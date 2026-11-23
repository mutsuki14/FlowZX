import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import { existsSync, statSync } from 'fs';
import type { LogLevel } from '../../shared/types';
import type { LogManager } from './LogManager';
import { sha256File } from '../../shared/file-hash';
import coreManifest from '../../shared/core-manifest.json';
import { findGoBuildSetting, findGoDepVersion } from '../utils/go-buildinfo';

/** libcronet 自愈动作：ok=已就位无需动 / restored=刚从权威源重拷 / failed=拷贝失败或无配套库（已告警，调用方降级）。 */
export type CronetHealAction = 'ok' | 'restored' | 'failed';

/**
 * libcronet 可用性：
 * - available：可加载（macOS 静态编入，或 linux/win 核心同目录已有与该内核配套的库）
 * - copy-failed：配套库有权威源，但核心同目录缺失 / 大小不符（拷贝失败、损坏），可经自愈恢复
 * - mismatch：当前内核绑定的 cronet 版本既不是随包版本、本机也没有它配套的库（例如旧版 FlowZX 在线装的内核，
 *   当时丢弃了压缩包自带的库）。此时绝不能拿随包库凑数——ABI 漂移会让 naive 一工作内核就崩（0xc0000005）
 * - no-lib：既无随包库、也无法确定内核需要哪一版
 */
export type CronetLibStatus = 'available' | 'copy-failed' | 'mismatch' | 'no-lib';

/**
 * 某个内核配套 libcronet 的权威来源：
 * - bundled：随包库（内核绑定的版本 = 随包版本，或无法读出版本时沿用旧行为）
 * - store：本机库存（userData/cronet/<版本>/），由安装内核时从官方压缩包收下
 * - missing：内核需要的版本既非随包、库存里也没有
 * - none：无随包库且版本未知（mac-x64 等）
 */
export type CronetSource =
  | { kind: 'bundled' | 'store'; path: string; version: string | null }
  | { kind: 'missing'; version: string }
  | { kind: 'none' };

/** sing-box 经 purego 加载的 cronet 预编译库模块（Go build info 里的 dep 路径前缀）。 */
const CRONET_LIB_MODULE_PREFIX = 'github.com/sagernet/cronet-go/lib/';

export class ResourceManager {
  private _isDev?: boolean;
  private readonly platform: string;
  private readonly arch: string;
  private logManager?: LogManager;
  /** 内核二进制 → 其绑定的 cronet 库版本（按 size+mtime 失效；扫描 ~80MB 二进制只做一次）。 */
  private readonly cronetVersionCache = new Map<
    string,
    { size: number; mtimeMs: number; version: string | null }
  >();

  /** 内核二进制 → 编译 tag（按 size+mtime 失效）。 */
  private readonly coreTagsCache = new Map<
    string,
    { size: number; mtimeMs: number; tags: string[] | null }
  >();

  constructor() {
    this.platform = process.platform;
    this.arch = process.arch;
  }

  /**
   * 注入 LogManager（由主流程在 index.ts 统一注入）。注入前日志走 console fallback。
   */
  setLogManager(lm: LogManager): void {
    this.logManager = lm;
  }

  /**
   * 统一日志出口：已注入 LogManager 则转发，否则按级别 fallback 到 console。
   */
  private log(level: LogLevel, message: string): void {
    if (this.logManager) {
      this.logManager.addLog(level, message, 'ResourceManager');
      return;
    }
    if (level === 'error' || level === 'fatal') console.error(message);
    else if (level === 'warn') console.warn(message);
    else console.log(message);
  }

  private get isDev(): boolean {
    if (this._isDev === undefined) {
      // Use optional chaining just in case app is undefined during an early evaluation
      this._isDev = !(app?.isPackaged ?? true);
    }
    return this._isDev;
  }

  getSingBoxPath(): string {
    // Windows 平台需要 .exe 扩展名
    const filename = this.platform === 'win32' ? 'sing-box.exe' : 'sing-box';

    // Windows（portable + 安装版统一）：优先 userData 可写核——换核覆盖跨平台统一模型：现役核恒为可写核、随包核
    // 只是种子（见 docs/design/core-override-cross-platform-unify）。存在才用、缺失回落随包种子，故首启/迁移永不 brick；
    // 现役核与安装目录种子解耦后，NSIS 重装覆盖种子不再降级用户已更新到的更新核。
    if (this.platform === 'win32') {
      const fs = require('fs');
      const winCorePath = path.join(app.getPath('userData'), 'core_update', filename);
      if (fs.existsSync(winCorePath)) {
        return winCorePath;
      }
    }

    // Linux：helper 模式优先 root 受管核（安装播种 / install-core 写入，root-only 不可篡改）——存在且可执行即用，
    // 与 macOS 受保护目录优先同构。无受管核（未装 helper / setcap 兜底）→ userData 可写核（支持 setcap + 规避 AppImage EROFS）。
    if (this.platform === 'linux') {
      const fs = require('fs');
      // helper 模式：root 受管核优先（共用 linuxManagedCoreUsable 谓词，与 ensureWritableCore force 刷新腿同源）。
      if (this.linuxManagedCoreUsable()) {
        return path.join(this.getLinuxManagedCoreDir(), filename);
      }
      const linuxCorePath = path.join(app.getPath('userData'), 'core_update', filename);
      if (fs.existsSync(linuxCorePath)) {
        return linuxCorePath;
      }
    }

    // macOS 内核持久化（B 块）：优先受保护目录下的内核（存在且可执行——持久化更新写入处），否则回落 bundle 出厂
    // 内核。受保护目录惰性创建（仅首次内核更新时），未创建时此处自然 fallback，行为与改动前一致、永不 brick。
    if (this.platform === 'darwin') {
      const fs = require('fs');
      const protectedCore = path.join(this.getProtectedCoreDir(), filename);
      try {
        fs.accessSync(protectedCore, fs.constants.X_OK);
        return protectedCore;
      } catch {
        /* 受保护目录无内核/不可执行 → 用 bundle 出厂内核 */
      }
    }

    const platformDir = this.getPlatformResourceDir();
    const singboxPath = path.join(platformDir, filename);

    return singboxPath;
  }

  /** 专为解决 Portable 版本每次启动清空临时目录导致更新失效的问题。 */
  getSingBoxUpdateTargetPath(): string {
    const filename = this.platform === 'win32' ? 'sing-box.exe' : 'sing-box';

    // Windows（portable + 安装版统一）：核更新/换核写入 userData 可写核（与 getSingBoxPath 优先项一致），
    // 使现役核与安装目录随包种子解耦——重装/升级 NSIS 覆盖种子不再降级用户更新到的更新核（统一模型）。
    if (this.platform === 'win32') {
      return path.join(app.getPath('userData'), 'core_update', filename);
    }

    // Linux 下特殊处理：AppImage 是只读文件系统 (EROFS)，更新核心必须写入 userData
    if (this.platform === 'linux') {
      return path.join(app.getPath('userData'), 'core_update', filename);
    }

    // macOS：fallback 写路径显式回 bundle（与 getSingBoxPath 受保护目录优先解耦）。受保护目录是 root-only，普通用户
    // 写不了；持久化更新经 helper v5 install-core 由 root 写（CoreUpdateService 改道），非 helper-v5 路径才回落此 bundle 写。
    if (this.platform === 'darwin') {
      return this.getBundledSingBoxPath();
    }

    return this.getSingBoxPath();
  }

  /**
   * 获取随包内置的 macOS 提权 helper 二进制路径（与 sing-box 同目录）。
   * 生产环境：<App>/Contents/Resources/mac/com.flowz.helper；开发环境：resources/mac-${arch}/com.flowz.helper。
   * 仅 macOS 有意义；安装时由 HelperManager 复制到 /Library/PrivilegedHelperTools/。
   */
  getMacHelperPath(): string {
    return path.join(this.getPlatformResourceDir(), 'com.flowz.helper');
  }

  /**
   * 获取随包内置的 Windows 提权 helper 服务二进制路径（与 sing-box.exe 同目录，安装期的**复制源**）。
   * 生产/开发：<resources>/win/com.flowz.helper.exe。仅 Windows 有意义。
   * 安装时由 WindowsServiceHelper 把它**复制外置**到 ProgramData\FlowZ 再注册为 LocalSystem 服务，binPath 指向
   * 外置副本（非此 app 内路径）——故 app 更新/移动不影响服务、卸载由 helper 自卸载/NSIS 钩子清外置副本。
   * 镜像 macOS HelperManager 把 helper 复制出 .app 到 /Library/PrivilegedHelperTools 的范式。
   */
  getWinHelperPath(): string {
    return path.join(this.getPlatformResourceDir(), 'com.flowz.helper.exe');
  }

  /**
   * 获取随包内置的 Linux 提权 helper 二进制路径（与 sing-box 同目录，安装期的**复制源**）。
   * 生产：<resources>/linux/flowz-helper-linux；开发：resources/linux[-${arch}]/flowz-helper-linux。仅 Linux 有意义。
   * 安装时由 LinuxServiceHelper 复制到 /opt/FlowZ/flowz-helper 并注册为 systemd system service。
   */
  getLinuxHelperPath(): string {
    return path.join(this.getPlatformResourceDir(), 'flowz-helper-linux');
  }

  /** macOS 内核持久化的受保护目录（root-only 写，App 升级不覆盖；B 块）。helper 安装时经 --coredir 锁定它，
   *  install-core 只写此目录。仅 macOS 有意义。 */
  getProtectedCoreDir(): string {
    return '/Library/Application Support/FlowZ/core';
  }

  /** Linux root-owned 受管核目录（root:root 0755，普通用户改不动；LinuxServiceHelper 安装时播种、install-core 写入）。
   *  helper 只跑此目录内的 sing-box（路径锁），getSingBoxPath 在此目录有可执行核时优先返回它。**须与 LinuxServiceHelper
   *  的 CORE_DIR 常量字面一致**。仅 Linux 有意义。 */
  getLinuxManagedCoreDir(): string {
    return '/usr/local/lib/flowz/core';
  }

  /** Linux root 受管核是否在位且可执行——getSingBoxPath 读路径与 ensureWritableCore force 刷新腿共用同一谓词，
   *  杜绝「读受管核、却刷 userData」的写读错位。 */
  private linuxManagedCoreUsable(): boolean {
    try {
      const fsSync = require('fs') as typeof import('fs');
      fsSync.accessSync(
        path.join(this.getLinuxManagedCoreDir(), 'sing-box'),
        fsSync.constants.X_OK
      );
      return true;
    } catch {
      return false;
    }
  }

  /** 随包 Xray 内核路径（scripts/fetch-core.mjs 落到 resources/<平台>/xray[.exe]，与 sing-box 同目录）。 */
  getBundledXrayPath(): string {
    const filename = this.platform === 'win32' ? 'xray.exe' : 'xray';
    return path.join(this.getPlatformResourceDir(), filename);
  }

  /**
   * 用户自行替换的 Xray 内核目录：<userData>/xray_core/xray[.exe]。存在且可执行即优先使用（手动升级 Xray 而不等
   * FlowZ 发版）；不存在回落随包核。Xray 以普通用户权限运行（仅监听 127.0.0.1、拨号回环 sing-box），无需提权目录。
   */
  getXrayOverrideDir(): string {
    return path.join(app.getPath('userData'), 'xray_core');
  }

  /** 现役 Xray 内核路径：用户覆盖核优先，否则随包核（文件可能不存在 → hasXrayCore 判定）。 */
  getXrayPath(): string {
    const fs = require('fs');
    const filename = this.platform === 'win32' ? 'xray.exe' : 'xray';
    try {
      const override = path.join(this.getXrayOverrideDir(), filename);
      fs.accessSync(override, this.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      return override;
    } catch {
      /* 无覆盖核 → 随包核 */
    }
    return this.getBundledXrayPath();
  }

  /** Xray 内核是否可用（文件存在且可执行）。缺失时 Xray 节点不可用（同 naive 缺 libcronet 的处置）。 */
  hasXrayCore(): boolean {
    const fs = require('fs');
    try {
      const p = this.getXrayPath();
      fs.accessSync(p, this.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  }

  /** 始终指向随 App 出厂的 bundle 内核（B 块 App 升级仲裁 / 受保护目录种子用，绕过受保护目录优先逻辑）。 */
  getBundledSingBoxPath(): string {
    const filename = this.platform === 'win32' ? 'sing-box.exe' : 'sing-box';
    return path.join(this.getPlatformResourceDir(), filename);
  }

  /**
   * 获取应用图标路径（统一使用 app.png）
   */
  getAppIconPath(): string {
    if (this.isDev) {
      return path.join(process.cwd(), 'resources', 'app.png');
    }
    // 生产环境：app.png 在 process.resourcesPath 根目录
    return path.join(process.resourcesPath, 'app.png');
  }

  /**
   * 托盘图标。mac / win 优先用按托盘尺寸原生栅格化的专用文件（scripts/generate-icon.js 产出）：
   * mac `tray-mac-*.png`（18pt，同目录 @2x 由 nativeImage 自动加载）、win `tray-win-*.ico`（多尺寸，按系统小图标尺寸取帧）；
   * 缺失（旧包 / 未生成）或 Linux 回退 1024 的 app.png / app-gray.png。
   * @param connected 是否已连接，true 返回彩色图标，false 返回灰色图标
   */
  getTrayIconPath(connected: boolean = false): string {
    const dir = this.isDev ? path.join(process.cwd(), 'resources') : process.resourcesPath;
    const state = connected ? 'connected' : 'idle';
    const native =
      this.platform === 'darwin'
        ? `tray-mac-${state}.png`
        : this.platform === 'win32'
          ? `tray-win-${state}.ico`
          : null;
    if (native && existsSync(path.join(dir, native))) {
      return path.join(dir, native);
    }
    return path.join(dir, connected ? 'app.png' : 'app-gray.png');
  }

  /** 随包 data 目录内任意资源文件的出厂路径（供内置 app 分流 geo .srs 等通用 bundle 项取 bundledPath）。 */
  getDataResourcePath(fileName: string): string {
    return path.join(this.getDataResourceDir(), fileName);
  }

  /**
   * sing-box 官方面板**随包内置**目录（SagerNet/sing-box-dashboard 的 gh-pages 构建，scripts/fetch-dashboard.mjs 拉取）。
   * 生产：<resources>/dashboard；开发：<cwd>/resources/dashboard。electron-builder extraResources 直拷到 resources/dashboard。
   * sing-box services[].dashboard.path 指向它（或运行时下载覆盖目录）→ 核直接 serve 本地、零联网下载、打开即时（dashboard #55）。
   */
  getBundledDashboardDir(): string {
    return path.join(this.getResourcesBaseDir(), 'dashboard');
  }

  /** 目录是否含 index.html（同步存在性探测，异常→false）。面板「就绪」判定的单一口径。 */
  private hasIndex(dir: string): boolean {
    try {
      return require('fs').existsSync(path.join(dir, 'index.html'));
    } catch {
      return false;
    }
  }

  /** 内置面板是否就绪（含 index.html）：异常打包/未跑 fetch:dashboard 时可能缺失 → serve 决策据此回落（不注入 path 则核走联网下载兜底）。 */
  hasBundledDashboard(): boolean {
    return this.hasIndex(this.getBundledDashboardDir());
  }

  /**
   * 解析面板「实际 serve 目录」：**运行时下载覆盖优先**（overrideDir 含 index.html）→ 否则随包内置目录。
   * 返回 null = 两者皆无（异常打包且未下载）→ 调用方不注入 dashboard.path，由 sing-box 联网下载兜底（保旧行为不 brick）。
   * 纯路径决策（仅 existsSync 探测），无副作用；与内置 geo 的「下载优先、内置兜底」语义对齐。
   */
  resolveDashboardServeDir(overrideDir: string): string | null {
    if (this.hasIndex(overrideDir)) return overrideDir;
    const bundled = this.getBundledDashboardDir();
    return this.hasIndex(bundled) ? bundled : null;
  }

  getGeoIPPath(): string {
    const dataDir = this.getDataResourceDir();
    return path.join(dataDir, 'geoip-cn.srs');
  }

  getGeoSiteCNPath(): string {
    const dataDir = this.getDataResourceDir();
    return path.join(dataDir, 'geosite-cn.srs');
  }

  getGeoSiteNonCNPath(): string {
    const dataDir = this.getDataResourceDir();
    return path.join(dataDir, 'geosite-geolocation-!cn.srs');
  }

  async checkResourcesExist(): Promise<{ exists: boolean; missing: string[] }> {
    const missing: string[] = [];

    const singboxPath = this.getSingBoxPath();
    if (!(await this.fileExists(singboxPath))) {
      missing.push(`sing-box executable: ${singboxPath}`);
    }

    const geoFiles = [
      { name: 'GeoIP CN', path: this.getGeoIPPath() },
      { name: 'GeoSite CN', path: this.getGeoSiteCNPath() },
      { name: 'GeoSite Non-CN', path: this.getGeoSiteNonCNPath() },
    ];

    for (const file of geoFiles) {
      if (!(await this.fileExists(file.path))) {
        missing.push(`${file.name}: ${file.path}`);
      }
    }

    return {
      exists: missing.length === 0,
      missing,
    };
  }

  private getPlatformResourceDir(): string {
    const baseDir = this.getResourcesBaseDir();

    if (this.platform === 'win32') {
      return path.join(baseDir, 'win');
    } else if (this.platform === 'darwin') {
      if (this.isDev) {
        if (this.arch === 'arm64') {
          return path.join(baseDir, 'mac-arm64');
        } else {
          return path.join(baseDir, 'mac-x64');
        }
      } else {
        return path.join(baseDir, 'mac');
      }
    } else if (this.platform === 'linux') {
      if (this.isDev) {
        // 开发环境：优先根据架构选择目录，如果找不到则回退到 linux 目录
        const fs = require('fs');
        const archDir = this.arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
        const fullArchDirPath = path.join(baseDir, archDir);

        if (fs.existsSync(fullArchDirPath)) {
          return fullArchDirPath;
        }
        return path.join(baseDir, 'linux');
      } else {
        return path.join(baseDir, 'linux');
      }
    }

    throw new Error(`Unsupported platform: ${this.platform}`);
  }

  private getDataResourceDir(): string {
    const baseDir = this.getResourcesBaseDir();
    return path.join(baseDir, 'data');
  }

  private getResourcesBaseDir(): string {
    if (this.isDev) {
      return path.join(process.cwd(), 'resources');
    } else {
      // process.resourcesPath 指向 app.asar 所在的 resources 目录
      // extraResources 直接复制到 process.resourcesPath 下
      return process.resourcesPath;
    }
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 确保「现役核」就位并返回其路径——平台感知的随包核播种入口（§5 两平台统一调用 ensureWritableCore(true)）：
   *  - linux：helper 模式经 install-core 刷新 root 受管核（force + 注入 installCore + 受管核在位）+ 维护 userData
   *    兜底核（setcap/系统代理回退用）；返回现役核（受管核优先，探测/校验/实跑同源）。无 helper → userData 可写核（AppImage EROFS + setcap）；
   *  - darwin：受保护目录 root-only，force 时经已装 helper install-core 重播种随包核（免密码）——复制到干净临时
   *    目录再装（避免带入同目录 helper/LICENSE），macOS 无 libcronet 静态编入只播 sing-box。需注入 deps.installCore
   *    （由 ProxyManager 传 HelperManager.installCore，保持本模块零 HelperManager 依赖）；缺注入 / 非 force → no-op
   *    回落 getSingBoxPath（行为同改动前：受保护目录无核则用 bundle 出厂核）；
   *  - 其它平台：no-op 返回 getSingBoxPath。
   *
   * @param deps.installCore darwin 重播种用——把 seedDir 内的随包核经提权 helper 装进受保护目录（{ok,error}）。
   */
  async ensureWritableCore(
    force = false,
    deps?: { installCore?: (seedDir: string) => Promise<{ ok: boolean; error?: string }> }
  ): Promise<string> {
    if (this.platform === 'darwin') {
      // 仅 force（§5 reseed 决策）+ 注入了 helper installCore 时才重播种；否则 no-op（保持改动前行为）。
      if (force && deps?.installCore) {
        try {
          const os = require('os') as typeof import('os');
          const seedDir = path.join(os.tmpdir(), 'flowz-core-reseed');
          await fs.mkdir(seedDir, { recursive: true });
          await fs.copyFile(this.getBundledSingBoxPath(), path.join(seedDir, 'sing-box'));
          const r = await deps.installCore(seedDir);
          if (!r.ok) this.log('warn', `随包内核重播种失败: ${r.error ?? ''}`);
        } catch (e) {
          this.log('warn', `随包内核刷新失败: ${(e as Error)?.message ?? e}`);
        }
      }
      return this.getSingBoxPath();
    }
    // Linux + Windows：userData 可写核（种子 + 版本感知 reseed），其它平台无可写核 → 回落 getSingBoxPath。
    // Windows 曾在此 no-op（reseed 不执行 → 升级带来更新随包核时旧可写核永不被替换、需手动「重置出厂」）——
    // 本处统一补齐换核执行（设计见 docs/design/core-override-cross-platform-unify）。原子 rename 规避运行中 .exe
    // 文件锁（reseed 在 core spawn 之前 + #150 version 探测串行，撞锁概率极低；真失败则诚实 reseedError）。
    if (this.platform !== 'linux' && this.platform !== 'win32') {
      return this.getSingBoxPath();
    }

    // Linux root 受管核刷新（镜像 darwin 受保护目录腿）：仅 force（§5 决策已定）+ 注入 installCore + 受管核在位
    // （helper 模式读路径优先它）时，把随包核 + libcronet 放进干净临时 seedDir，经 helper install-core（sha256 校验、
    // 免密、原子 rename）写入 root 受管目录。失败仅告警不抛——返回值仍解析到受管核，§5 诚实校验会探测到旧版本、由版本
    // 闸门兜底（绝不谎报成功）。helper 未装/受管核不在位 → 跳过，走下方 userData 兜底核（setcap 路径零回归）。
    if (this.platform === 'linux' && force && deps?.installCore && this.linuxManagedCoreUsable()) {
      let seedDir: string | null = null;
      try {
        const os = require('os') as typeof import('os');
        seedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flowz-core-reseed-'));
        const seedBin = path.join(seedDir, 'sing-box');
        await fs.copyFile(this.getBundledSingBoxPath(), seedBin);
        await fs.chmod(seedBin, 0o755);
        await this.ensureCronetBeside(seedDir); // naive purego 同目录加载，libcronet.so 随核配套
        const r = await deps.installCore(seedDir);
        if (!r.ok) this.log('warn', `受管核重播种失败: ${r.error ?? ''}`);
      } catch (e) {
        this.log('warn', `受管核刷新失败: ${(e as Error)?.message ?? e}`);
      } finally {
        if (seedDir) await fs.rm(seedDir, { recursive: true, force: true }).catch(() => {});
      }
    }

    const filename = this.platform === 'win32' ? 'sing-box.exe' : 'sing-box';
    const userDataPath = app.getPath('userData');
    const updateDir = path.join(userDataPath, 'core_update');
    const targetPath = path.join(updateDir, filename);

    // 检查是否已经有可写核心（force=true 跳过复用、强制用随包核覆盖——§5 最低版本守卫：升级遗留的旧可写核
    // 会被硬切 1.14 的配置 FATAL，须随包 1.14 核覆盖刷新）
    if (!force && (await this.fileExists(targetPath))) {
      // 已有可写核心：仍需确保 libcronet 在旁（naive 出站靠 purego 同目录/系统库路径加载）
      await this.ensureCronetBeside(updateDir);
      // Linux 现役核对齐：helper 模式返回受管核（探测/校验/实跑同源），无 helper 返回 userData 核（等价旧值）。
      return this.platform === 'linux' ? this.getSingBoxPath() : targetPath;
    }

    await fs.mkdir(updateDir, { recursive: true });

    // 从应用内置的包中复制（force 时 copyFile 覆盖旧核）
    const platformDir = this.getPlatformResourceDir();
    const sourcePath = path.join(platformDir, filename);

    if (await this.fileExists(sourcePath)) {
      // 原子替换（写 targetPath.tmp → chmod 0o755 → rename），非原地 copyFile 覆盖：force 重播种时 targetPath
      // 可能正被运行中的 sing-box 执行，原地 O_TRUNC 打开会 ETXTBSY（text file busy）致覆盖失败、旧核残留
      //（issue #150）。rename 只把旧 inode unlink（在用进程继续持有旧 inode 不受影响），文件名指向全新核 →
      // 根除 ETXTBSY。与 ensureCronetHealthy 的 libcronet 写盘同款原子语义。
      await this.atomicCopy(sourcePath, targetPath);
    }

    // naive 节点需要 libcronet 与 sing-box 同目录（purego 加载），随核心一并放过去
    await this.ensureCronetBeside(updateDir);

    // Linux 现役核对齐：helper 模式返回受管核（上方 force 腿已刷新），无 helper 返回刚写的 userData 核（等价旧 targetPath）。
    return this.platform === 'linux' ? this.getSingBoxPath() : targetPath;
  }

  /** 各平台 NaiveProxy 核心库文件名（purego 期望的名字） */
  getCronetLibFilename(): string {
    if (this.platform === 'win32') return 'libcronet.dll';
    if (this.platform === 'darwin') return 'libcronet.dylib';
    return 'libcronet.so';
  }

  /** 当前平台的 sing-box 可执行文件名。 */
  getCoreBinaryName(): string {
    return this.platform === 'win32' ? 'sing-box.exe' : 'sing-box';
  }

  /** Go 的 <goos>_<goarch>（cronet-go/lib 子模块名），如 windows_amd64；未知组合 → null。 */
  private cronetGoTarget(): string | null {
    const goos =
      this.platform === 'win32'
        ? 'windows'
        : this.platform === 'linux' || this.platform === 'darwin'
          ? this.platform
          : null;
    const goarch =
      this.arch === 'x64'
        ? 'amd64'
        : this.arch === 'arm64'
          ? 'arm64'
          : this.arch === 'ia32'
            ? '386'
            : null;
    return goos && goarch ? `${goos}_${goarch}` : null;
  }

  /**
   * 读出内核二进制编译时绑定的 libcronet 版本（`cronet-go/lib/<goos>_<goarch>` 的 Go 模块伪版本，与
   * core-manifest.cronetVersion 同一口径）。文件不存在 / 不是带 naive 的 Go 构建 / 读失败 → null（调用方沿用随包库）。
   */
  getRequiredCronetVersion(corePath: string): string | null {
    const target = this.cronetGoTarget();
    if (!target) return null;
    let st: { size: number; mtimeMs: number };
    try {
      st = statSync(corePath);
    } catch {
      return null;
    }
    const hit = this.cronetVersionCache.get(corePath);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.version;
    // 只认本平台子模块（含 *_musl 变体）；官方构建只编入目标平台那一个，过滤只是保险。
    const m = findGoDepVersion(
      corePath,
      CRONET_LIB_MODULE_PREFIX,
      (d) => d.suffix === target || d.suffix === `${target}_musl`
    );
    const version = m?.version ?? null;
    this.cronetVersionCache.set(corePath, { size: st.size, mtimeMs: st.mtimeMs, version });
    return version;
  }

  /**
   * 内核编译 tag（Go build info 的 `-tags`，如 with_awg / with_gvisor），按 size+mtime 缓存。读不出 → null（未知）。
   * 用于判断现役内核能力：AmneziaWG 节点要 with_awg；无 with_gvisor 的内核（awgm-box、1.15.0-alpha.11+ 官方）TUN 不能用 gvisor 栈。
   */
  getCoreBuildTags(corePath: string = this.getSingBoxPath()): string[] | null {
    let st: { size: number; mtimeMs: number };
    try {
      st = statSync(corePath);
    } catch {
      return null;
    }
    const hit = this.coreTagsCache.get(corePath);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.tags;
    const raw = findGoBuildSetting(corePath, '-tags');
    const tags =
      raw === null
        ? null
        : raw
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean);
    this.coreTagsCache.set(corePath, { size: st.size, mtimeMs: st.mtimeMs, tags });
    return tags;
  }

  /** 现役内核是否编入 AmneziaWG（awgm-box 等，build tag with_awg）。未知按不支持（节点跳过而非让内核 FATAL）。 */
  coreSupportsAwg(): boolean {
    return this.getCoreBuildTags()?.includes('with_awg') === true;
  }

  /** 现役内核确定未编入 gVisor（tag 可读且无 with_gvisor）。未知按 false（沿用用户选择，行为不变）。 */
  coreLacksGvisor(): boolean {
    const tags = this.getCoreBuildTags();
    return tags !== null && !tags.includes('with_gvisor');
  }

  /** 本机 libcronet 库存根目录：userData/cronet/<版本>/<库文件>。 */
  getCronetStoreDir(): string {
    return path.join(app.getPath('userData'), 'cronet');
  }

  /** 库存里某版本库的路径；版本串不合法（防目录穿越）→ null。 */
  private getStoredCronetPath(version: string): string | null {
    if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) return null;
    return path.join(this.getCronetStoreDir(), version, this.getCronetLibFilename());
  }

  /**
   * coreDir 里那个内核应配的 libcronet 从哪来（见 CronetSource）。macOS cronet 静态编入，沿用旧行为（随包库或 none）。
   * 关键不变量：内核绑定的版本 ≠ 随包版本时，**绝不**回落随包库。
   */
  resolveCronetSource(coreDir: string): CronetSource {
    const bundled = path.join(this.getPlatformResourceDir(), this.getCronetLibFilename());
    const hasBundled = existsSync(bundled);
    const bundledVersion: string | null = coreManifest.cronetVersion || null;
    const required =
      this.platform === 'darwin'
        ? null
        : this.getRequiredCronetVersion(path.join(coreDir, this.getCoreBinaryName()));
    if (!required || required === bundledVersion) {
      return hasBundled
        ? { kind: 'bundled', path: bundled, version: bundledVersion }
        : { kind: 'none' };
    }
    const stored = this.getStoredCronetPath(required);
    if (stored && existsSync(stored)) return { kind: 'store', path: stored, version: required };
    return { kind: 'missing', version: required };
  }

  /**
   * libcronet（naive 出站依赖库）对**现役内核**的可用性（见 CronetLibStatus）。热路径（每个 naive 节点判一次）：
   * 版本读取有缓存，其余只 stat。
   */
  getCronetLibStatus(): CronetLibStatus {
    try {
      // macOS：cronet 由 sing-box 二进制静态编入（CGO，无 .dylib）→ naive 两 arch 皆可用、无需外部库。
      if (this.platform === 'darwin') {
        return 'available';
      }
      // linux/windows：purego 从内核同目录 dlopen。按现役内核所在目录判定（Linux/便携/已更新=userData 可写核目录，
      // 未更新的 win 安装版=内置 resources 目录）。
      const coreDir = path.dirname(this.getSingBoxPath());
      const dstLib = path.join(coreDir, this.getCronetLibFilename());
      const src = this.resolveCronetSource(coreDir);
      if (src.kind === 'none') return existsSync(dstLib) ? 'available' : 'no-lib';
      if (src.kind === 'missing') return 'mismatch';
      if (!existsSync(dstLib)) return 'copy-failed';
      // 存在但大小与权威源不符（0 字节 / 截断 / 版本错位）→ 当前不可用，可经自愈恢复。
      if (
        path.resolve(dstLib) !== path.resolve(src.path) &&
        statSync(dstLib).size !== statSync(src.path).size
      ) {
        return 'copy-failed';
      }
      return 'available';
    } catch {
      return 'no-lib';
    }
  }

  /** 现役内核的 libcronet 是否可用（naive 可用性判断）。copy-failed / mismatch 均视为当前不可用。 */
  hasCronetLib(): boolean {
    return this.getCronetLibStatus() === 'available';
  }

  /**
   * 确保 coreDir 里的内核旁边是与它配套的 libcronet（供 naive 出站 purego 加载）。
   * 供 ensureWritableCore 与核心更新写盘后调用。薄 wrapper → ensureCronetHealthy（strong=false 热路径）。
   */
  async ensureCronetBeside(coreDir: string): Promise<void> {
    await this.ensureCronetHealthy(coreDir);
  }

  /**
   * libcronet 缺失/损坏自愈（完整性 + 版本感知的播种）：从该内核配套库的权威源（随包或本机库存，见
   * resolveCronetSource）恢复到 coreDir。离线可恢复——不联网下载。
   *
   * 判据（见 cronetNeedsRestore）：dst 缺失 / size(dst)≠size(src)（热路径快筛）；strong=true 时额外比 sha256。
   * 内核需要的版本本机没有（missing）→ 不动 dst、返回 failed（reason='version-mismatch'）：宁可让 naive 节点被跳过，
   * 也不拿随包库凑数让内核崩。
   *
   * @returns action：ok（无需动 / 无可用源 reason='no-bundled-lib'）/ restored（已重拷）/ failed（拷贝失败或无配套库）。
   */
  async ensureCronetHealthy(
    coreDir: string,
    opts: { strong?: boolean } = {}
  ): Promise<{ action: CronetHealAction; reason?: string }> {
    const dst = path.join(coreDir, this.getCronetLibFilename());
    const src = this.resolveCronetSource(coreDir);
    // 无随包库且版本未知（mac-x64 等）→ 无权威源，按现状跳过。
    if (src.kind === 'none') return { action: 'ok', reason: 'no-bundled-lib' };
    if (src.kind === 'missing') {
      this.log(
        'warn',
        `当前内核需要 libcronet ${src.version}，本机没有配套的库（随包为 ${coreManifest.cronetVersion}）；` +
          '为免 naive 节点让内核崩溃，不使用随包库，naive 节点暂不可用。请在「内核管理」重新安装当前版本或恢复随包内核'
      );
      return { action: 'failed', reason: 'version-mismatch' };
    }
    if (path.resolve(src.path) === path.resolve(dst)) return { action: 'ok' };
    try {
      const need = await this.cronetNeedsRestore(src.path, dst, opts.strong === true);
      if (!need) return { action: 'ok' };
      await this.atomicCopy(src.path, dst);
      this.log(
        'info',
        `libcronet 自愈：restored（${opts.strong ? 'hash' : 'size'}，${src.kind === 'store' ? `库存 ${src.version}` : '随包'}）→ ${dst}`
      );
      return { action: 'restored' };
    } catch (error) {
      // 复制失败不阻断启动（naive 不可用时 sing-box 会自报 cronet 错误），但必须告警而非静默吞掉：
      // 否则 dst 缺库会被 getCronetLibStatus 判为 'copy-failed'，需要这条日志定位 EACCES/磁盘满/AV 锁等真因。
      const msg = error instanceof Error ? error.message : String(error);
      this.log('warn', `libcronet 自愈失败（naive 暂不可用）：${src.path} → ${dst}：${msg}`);
      return { action: 'failed', reason: msg };
    }
  }

  /**
   * 安装内核时收下官方压缩包自带的 libcronet：sourceDir（解压 / 暂存目录）里的内核（corePath，缺省 sourceDir/sing-box[.exe]）
   * 绑定版本 ≠ 随包版本、且目录里有库 →
   * 存入 userData/cronet/<版本>/，此后自愈 / 回滚都以它为权威源。压缩包已过 GitHub API 的 SHA-256 校验，库与内核同出一包。
   * 失败只告警不抛（安装照常，naive 届时判 mismatch 被跳过，不会崩）。macOS 静态编入 → no-op。
   */
  async adoptCronetFromCoreDir(
    sourceDir: string,
    corePath: string = path.join(sourceDir, this.getCoreBinaryName())
  ): Promise<{ adopted: boolean; version: string | null }> {
    if (this.platform === 'darwin') return { adopted: false, version: null };
    const lib = path.join(sourceDir, this.getCronetLibFilename());
    const version = this.getRequiredCronetVersion(corePath);
    if (!version || version === coreManifest.cronetVersion) return { adopted: false, version };
    const dst = this.getStoredCronetPath(version);
    if (!dst || !(await this.fileExists(lib))) return { adopted: false, version };
    try {
      if ((await this.fileExists(dst)) && sha256File(dst) === sha256File(lib)) {
        return { adopted: true, version };
      }
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await this.atomicCopy(lib, dst);
      this.log('info', `已收下新内核配套的 libcronet ${version} → ${dst}`);
      return { adopted: true, version };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log('warn', `收下新内核配套的 libcronet ${version} 失败：${msg}`);
      return { adopted: false, version };
    }
  }

  /**
   * 清理 libcronet 库存：只保留 keepCorePaths（现役 / 备份 / 暂存内核）所需的版本，其余删除（每份 ~10MB）。
   * 读不出版本的路径忽略；任何失败只忽略，绝不抛。
   */
  async pruneCronetStore(keepCorePaths: readonly string[]): Promise<void> {
    if (this.platform === 'darwin') return;
    const keep = new Set<string>();
    for (const p of keepCorePaths) {
      const v = this.getRequiredCronetVersion(p);
      if (v) keep.add(v);
    }
    const root = this.getCronetStoreDir();
    let entries: string[];
    try {
      entries = await fs.readdir(root);
    } catch {
      return;
    }
    for (const name of entries) {
      if (keep.has(name)) continue;
      await fs.rm(path.join(root, name), { recursive: true, force: true }).catch(() => {});
      this.log('info', `已清理不再使用的 libcronet ${name}`);
    }
  }

  /**
   * 判定是否需要从内置 bundle 重拷 libcronet：
   * - dst 缺失 → true；
   * - size(src)≠size(dst) → true（0 字节/截断/跨版本大小必变，命中绝大多数损坏，成本仅 2×stat）；
   * - !strong → 热路径到此即止（零 hash 成本，正常启动每次只 stat）；
   * - strong → 再比 sha256（冷路径强校验，仅启动失败重试时付费）。
   */
  private async cronetNeedsRestore(src: string, dst: string, strong: boolean): Promise<boolean> {
    if (!(await this.fileExists(dst))) return true;
    const [s, d] = [await fs.stat(src), await fs.stat(dst)];
    if (s.size !== d.size) return true;
    if (!strong) return false;
    return sha256File(src) !== sha256File(dst);
  }

  /**
   * 原子拷贝 src→dst：写 dst.tmp → chmod → rename。rename 同盘原子——避免 sing-box 启动时读到半写文件；
   * tmp 失败/rename 被 AV 锁 → 抛给上层 catch 告警回落降级（不留半残破文件占着 dst 位）。
   */
  private async atomicCopy(src: string, dst: string): Promise<void> {
    const tmp = `${dst}.tmp`;
    try {
      await fs.copyFile(src, tmp);
      await fs.chmod(tmp, 0o755);
      await fs.rename(tmp, dst);
    } catch (e) {
      // chmod/rename 失败（如 Windows AV 持 .tmp 扫描锁）→ 清理半残 .tmp 防跨重启累积，再抛给调用方降级。
      await fs.unlink(tmp).catch(() => {});
      throw e;
    }
  }

  /**
   * 获取资源信息（用于调试）
   */
  getResourceInfo(): {
    isDev: boolean;
    platform: string;
    arch: string;
    baseDir: string;
    singboxPath: string;
    geoIPPath: string;
    geoSiteCNPath: string;
    geoSiteNonCNPath: string;
  } {
    return {
      isDev: this.isDev,
      platform: this.platform,
      arch: this.arch,
      baseDir: this.getResourcesBaseDir(),
      singboxPath: this.getSingBoxPath(),
      geoIPPath: this.getGeoIPPath(),
      geoSiteCNPath: this.getGeoSiteCNPath(),
      geoSiteNonCNPath: this.getGeoSiteNonCNPath(),
    };
  }
}

export const resourceManager = new ResourceManager();
