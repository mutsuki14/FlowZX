/**
 * Xray 内核版本选择（含预发布）：列出 XTLS/Xray-core 的 GitHub Releases → 按 tag 在线安装到现役槽位
 * `<userData>/xray_core/xray[.exe]` → 或恢复随包版本。只响应用户显式操作，**无后台自动更新**。
 *
 * 与 sing-box 的 CoreUpdateService 刻意分家：后者的兼容带 / fork 守卫 / helper install-core / staged 自动落位 / 备份路径
 * 全是 sing-box 专属；Xray 以普通用户运行、槽位在 userData，无需提权。共用的只有 CoreDownloader（同一网络会话层）
 * 与 ProxyManager 的公开生命周期 API。
 *
 * 安全不变量（任何一条被改坏都可能「静默装上不是官方发布的可执行文件」）：
 *  1. 渲染端只给 tag；下载 URL 由 tag 拼出、摘要由主进程按 tag 现取（GET /releases/tags/{tag}）。
 *  2. 期望摘要 = API asset.digest；缺席则取 github.com 直连的 `<asset>.dgst`（绝不经 gh-proxy 镜像）；两者都有必须一致；
 *     都没有 → NO_HASH 拒装（fail-closed）。下载即使回落镜像，字节也要过这个摘要。
 *  3. 低于 core-manifest.minXrayVersion 的版本拒装（tag 与解出二进制的 `xray version` 双重检查）——Xray 会静默忽略
 *     它不认识的安全字段（pinnedPeerCertSha256 / mldsa65Verify / echSockopt / penetrate），`run -test` 也查不出。
 *  4. 只解出 xray[.exe]（纯 Node zip 读取器，见 utils/zip-extract），staging → 自检 → rename 落位；槽位从不出现半成品。
 *  5. 切换 = 整个代理重启（不是只重启 Xray）：sing-box 的 process_path 规则内嵌 Xray 路径、逐节点 `xray run -test`
 *     闸也要用新核重跑。换核窗口经 ProxyManager.setCoreSwapInProgress(…, 'xray') 门控手动启停；重启失败 → 回滚原二进制
 *     与标记再起。重启期间用户手动停止 / 连接 / 退出 → 让位（新核留用，不回滚、不再起代理）。与 sing-box 核更新互斥：
 *     任一方在进行时另一方拒绝开始（本服务 CORE_BUSY；CoreUpdateService 经注入的 isBusy 判定）。
 *  6. 用户自行放入的文件（custom）永不丢：在线安装/恢复前另存为 xray.custom-bak[.exe]（已有不同内容的旧备份先改名留档）。
 */
import { execFile as nodeExecFile } from 'child_process';
import { randomBytes } from 'crypto';
import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';

import type { LogManager } from './LogManager';
import type { ProxyManager } from './ProxyManager';
import type { UpdateNetwork } from './UpdateNetwork';
import { CoreDownloader, DOWNLOAD_HASH_MISMATCH } from './core-downloader';
import { normalizeAssetDigest } from './singbox-asset';
import { resourceManager } from './ResourceManager';
import { parseXrayVersion } from './XrayCoreManager';
import { requiresXrayCore } from '../../shared/xray';
import {
  XRAY_MARKER_FILE,
  detectXraySource,
  sha256File,
  type XrayInstallMarker,
} from './xray-install-marker';
import { extractZipEntry } from '../utils/zip-extract';
import { writeFileAtomic } from '../utils/atomic-write';
import { getXrayConfigPath } from '../utils/paths';
import coreManifest from '../../shared/core-manifest.json';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type { UserConfig } from '../../shared/types';
import { compareSemver } from '../../shared/version';
import {
  listableXrayReleases,
  normalizeXrayRelease,
  parseXrayDgst,
  xrayBinaryName,
  xrayTagVersion,
  type XrayInstallErrorCode,
  type XrayInstallProgress,
  type XrayInstallResult,
  type XrayInstallState,
  type XrayRelease,
  type XrayReleaseList,
  type XrayRestoreResult,
  type XraySourceInfo,
} from '../../shared/xray-release';

const XRAY_API = 'https://api.github.com/repos/XTLS/Xray-core';
const XRAY_DOWNLOAD = 'https://github.com/XTLS/Xray-core/releases/download';
/** release 列表缓存时长（未认证 GitHub API 60 次/小时/IP，列表不能每次挂载都打）。 */
export const XRAY_LIST_TTL_MS = 10 * 60 * 1000;
/** 下载进度事件节流（~4 次/秒）；阶段切换与结束事件不节流。 */
const PROGRESS_THROTTLE_MS = 250;
const DGST_MAX_BYTES = 16 * 1024;
const VERSION_TIMEOUT_MS = 10_000;
const CONFIG_TEST_TIMEOUT_MS = 20_000;
const SIGN_TIMEOUT_MS = 30_000;
/** Windows：刚停掉的 xray.exe 句柄可能晚几百 ms 才释放 → rename / unlink 重试次数 × 间隔。 */
const IN_USE_RETRIES = 4;
const DETAIL_MAX = 2000;

type ProxyManagerLike = Pick<
  ProxyManager,
  | 'getStatus'
  | 'start'
  | 'stop'
  | 'isLifecycleBusy'
  | 'setCoreSwapInProgress'
  | 'isCoreSwapInProgress'
  | 'getLifecycleRequestCounts'
  | 'getXrayStatus'
>;
type LifecycleCounts = ReturnType<ProxyManagerLike['getLifecycleRequestCounts']>;
type DownloaderLike = Pick<
  CoreDownloader,
  'fetchGithubJson' | 'fetchGithubText' | 'downloadFile' | 'setUpdateNetwork'
>;

/** 构造注入点（单测替换网络 / 目录 / 平台 / 子进程 / 时钟；生产全用缺省）。 */
export interface XrayCoreUpdateServiceOptions {
  downloader?: DownloaderLike;
  /** 槽位目录（缺省 ResourceManager.getXrayOverrideDir() = <userData>/xray_core）。 */
  overrideDir?: () => string;
  /** 现役 Xray 配置（缺省 <userData>/xray_config.json，用于新核 `run -test`）。 */
  xrayConfigPath?: () => string;
  platform?: NodeJS.Platform;
  arch?: string;
  execFileFn?: typeof nodeExecFile;
  now?: () => number;
  /** Windows rename 重试间隔（ms）。 */
  inUseRetryDelayMs?: number;
}

/** 预期内的失败（带 code，映射为 { ok:false, code, detail }）。 */
class XrayInstallError extends Error {
  constructor(
    readonly code: XrayInstallErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'XrayInstallError';
  }
}

/** 一次换核的善后句柄：rollback 把槽位/标记恢复原状；commit 在切换成功后清理临时停放的旧文件。 */
interface SwapHandle {
  rollback: () => Promise<void>;
  commit?: () => Promise<void>;
}

/** sing-box 核更新在进行时拒绝开始（CoreUpdateService.isBusy 由 index.ts 注入）。 */
const SINGBOX_BUSY_MSG = 'sing-box 内核正在更新，请稍后再试';

type ActivationResult =
  | { ok: true; restarted: boolean }
  | { ok: false; code: XrayInstallErrorCode; detail?: string; rolledBack?: boolean };

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const tail = (s: string): string => (s.length > DETAIL_MAX ? `…${s.slice(-DETAIL_MAX)}` : s);

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

export class XrayCoreUpdateService {
  private proxyManager: ProxyManagerLike | null = null;
  private configProvider: (() => Promise<UserConfig | null>) | null = null;
  private eventSender: ((channel: string, payload: unknown) => void) | null = null;
  /** sing-box 核更新是否在进行（index.ts 注入 CoreUpdateService.isBusy；未注入 → 恒 false）。 */
  private singboxCoreBusy: () => boolean = () => false;

  private readonly downloader: DownloaderLike;
  private readonly overrideDir: () => string;
  private readonly xrayConfigPath: () => string;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly execFileFn: typeof nodeExecFile;
  private readonly now: () => number;
  private readonly inUseRetryDelayMs: number;

  /** 安装 / 恢复共用的单飞锁：check+set 在第一个 await 之前完成（同步临界区）。 */
  private busy = false;
  private progress: XrayInstallProgress | null = null;
  private lastProgressEmit = 0;
  private listCache: { releases: XrayRelease[]; fetchedAt: number } | null = null;
  private listInflight: Promise<XrayReleaseList> | null = null;

  constructor(
    private readonly logManager: LogManager,
    opts: XrayCoreUpdateServiceOptions = {}
  ) {
    // configProvider 在构造后才注入，故给下载器传惰性 thunk（读 ghProxyPrefix 镜像前缀；未配置 → null）。
    this.downloader =
      opts.downloader ??
      new CoreDownloader(logManager, () =>
        this.configProvider ? this.configProvider() : Promise.resolve(null)
      );
    this.overrideDir = opts.overrideDir ?? (() => resourceManager.getXrayOverrideDir());
    this.xrayConfigPath = opts.xrayConfigPath ?? (() => getXrayConfigPath());
    this.platform = opts.platform ?? process.platform;
    this.arch = opts.arch ?? process.arch;
    this.execFileFn = opts.execFileFn ?? nodeExecFile;
    this.now = opts.now ?? (() => Date.now());
    this.inUseRetryDelayMs = opts.inUseRetryDelayMs ?? 500;
  }

  setProxyManager(proxyManager: ProxyManagerLike): void {
    this.proxyManager = proxyManager;
  }

  setConfigProvider(provider: () => Promise<UserConfig | null>): void {
    this.configProvider = provider;
  }

  /** 进度事件发送器（index.ts 注入 ipcEventEmitter.sendToAll，同 CoreUpdateService）。 */
  setEventSender(fn: (channel: string, payload: unknown) => void): void {
    this.eventSender = fn;
  }

  /** 与 sing-box 核更新互斥：注入「sing-box 核更新在进行」判定（CoreUpdateService.isBusy）。 */
  setSingboxCoreBusyCheck(fn: () => boolean): void {
    this.singboxCoreBusy = fn;
  }

  /** 安装 / 恢复是否在进行（含下载阶段）；CoreUpdateService 据此拒绝在此期间换 sing-box 核。 */
  isBusy(): boolean {
    return this.busy;
  }

  /** 与 sing-box 核更新同一更新链路会话层（proxyRunning × mainSessionViaProxy → update-in socks / direct）。 */
  setUpdateNetwork(updateNetwork: UpdateNetwork): void {
    this.downloader.setUpdateNetwork(updateNetwork);
  }

  private get bundledVersion(): string {
    return coreManifest.bundledXrayVersion;
  }

  private get minVersion(): string {
    return coreManifest.minXrayVersion;
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.logManager.addLog(level, message, 'XrayCoreUpdateService');
  }

  // ── 列表 ────────────────────────────────────────────────────────────────────────────────────

  /**
   * XTLS/Xray-core 的 release 列表（剔除草稿与低于最低版本者，新→旧）。缓存 10 分钟，force 绕过；并发调用合并为一次请求。
   * 失败抛 Error（code：RATE_LIMITED / NETWORK，经 IPC ApiResponse.code 透传到渲染端）。
   */
  async listReleases(opts: { force?: boolean } = {}): Promise<XrayReleaseList> {
    const cache = this.listCache;
    if (!opts.force && cache && this.now() - cache.fetchedAt < XRAY_LIST_TTL_MS) {
      return this.toList(cache);
    }
    if (this.listInflight) return this.listInflight;
    const inflight = (async () => {
      try {
        const raw = await this.downloader.fetchGithubJson(`${XRAY_API}/releases?per_page=100`);
        if (!Array.isArray(raw)) throw new Error('GitHub 返回的 release 列表格式异常');
        const entry = {
          releases: listableXrayReleases(raw, this.platform, this.arch, this.minVersion),
          fetchedAt: this.now(),
        };
        this.listCache = entry;
        return this.toList(entry);
      } catch (e) {
        const code =
          (e as { code?: unknown })?.code === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'NETWORK';
        this.log('warn', `获取 Xray 版本列表失败（${code}）: ${errMsg(e)}`);
        throw Object.assign(new Error(errMsg(e)), { code });
      } finally {
        this.listInflight = null;
      }
    })();
    this.listInflight = inflight;
    return inflight;
  }

  private toList(entry: { releases: XrayRelease[]; fetchedAt: number }): XrayReleaseList {
    return {
      releases: entry.releases.map((r) => ({ ...r })),
      fetchedAt: entry.fetchedAt,
      bundledVersion: this.bundledVersion,
      minVersion: this.minVersion,
    };
  }

  // ── 状态 ────────────────────────────────────────────────────────────────────────────────────

  getInstallState(): XrayInstallState {
    return { installing: this.progress ? { ...this.progress } : null };
  }

  /** 现役 Xray 来源（bundled / downloaded / custom；哈希按 path+size+mtime 缓存）。 */
  getSourceInfo(): Promise<XraySourceInfo> {
    return detectXraySource(this.overrideDir(), this.platform);
  }

  private emitProgress(): void {
    this.lastProgressEmit = this.now();
    try {
      this.eventSender?.(
        IPC_CHANNELS.EVENT_XRAY_CORE_INSTALL_PROGRESS,
        this.progress ? { ...this.progress } : null
      );
    } catch {
      /* 推送失败（窗口已关）不影响安装 */
    }
  }

  /** 阶段切换 / 结束（null）：立即推送。 */
  private setProgress(p: XrayInstallProgress | null): void {
    this.progress = p;
    this.emitProgress();
  }

  // ── 安装 ────────────────────────────────────────────────────────────────────────────────────

  /**
   * 按 tag 在线安装并切换到该版本。force=true 跳过「新核 `run -test` 当前配置」（渲染端在 CONFIG_TEST_FAILED 后让用户确认）。
   * 预期内的失败一律以 `{ ok:false, code, detail }` 返回（不抛），便于渲染端按 code 出文案。
   */
  async install(args: { tag?: unknown; force?: unknown } = {}): Promise<XrayInstallResult> {
    if (this.busy) return { ok: false, code: 'BUSY' };
    const blocker = this.coreSwapBlocker();
    if (blocker) {
      return this.toFailure(new XrayInstallError('CORE_BUSY', blocker), 'Xray 安装未开始');
    }
    this.busy = true; // 同步临界区：check+set 之间无 await（与 sing-box 核更新的互斥判定同在此段）
    let tempZip: string | null = null;
    let stagingDir: string | null = null;
    try {
      const version = xrayTagVersion(args.tag);
      if (!version)
        throw new XrayInstallError('INVALID_TAG', `非法的 Xray 版本号: ${String(args.tag)}`);
      const tag = `v${version}`;
      if (this.proxyManager?.isLifecycleBusy()) {
        throw new XrayInstallError('PROXY_BUSY', '代理正在启动/停止，请稍后再试');
      }
      if (compareSemver(version, this.minVersion) < 0) {
        throw new XrayInstallError(
          'BELOW_MINIMUM',
          `Xray ${version} 低于 FlowZX 支持的最低版本 ${this.minVersion}`
        );
      }
      this.setProgress({ tag, phase: 'downloading', kind: 'install' });

      // 1) 按 tag 现取 release（不信任渲染端给的任何 URL / 摘要）
      const raw = await this.fetchReleaseByTag(tag);
      const rel = normalizeXrayRelease(raw, this.platform, this.arch, this.minVersion);
      if (!rel || rel.version !== version) {
        throw new XrayInstallError('NOT_FOUND', `GitHub 上没有 Xray ${tag}`);
      }
      if (rel.draft) throw new XrayInstallError('DRAFT', `Xray ${tag} 是草稿 release`);
      if (rel.belowMinimum) {
        throw new XrayInstallError(
          'BELOW_MINIMUM',
          `Xray ${version} 低于 FlowZX 支持的最低版本 ${this.minVersion}`
        );
      }
      const assets: unknown[] = Array.isArray((raw as { assets?: unknown }).assets)
        ? (raw as { assets: unknown[] }).assets
        : [];
      const assetName = rel.assetName;
      const asset = assetName
        ? assets.find((a) => !!a && (a as { name?: unknown }).name === assetName)
        : undefined;
      if (!assetName || !asset) {
        throw new XrayInstallError(
          'NO_ASSET',
          `Xray ${tag} 没有适用于本平台的构建（${assetName ?? `${this.platform}-${this.arch}`}）`
        );
      }
      const url = `${XRAY_DOWNLOAD}/${rel.tag}/${assetName}`;

      // 2) 期望摘要（API digest / .dgst；fail-closed）
      const expected = await this.resolveExpectedSha256(url, asset, assets, assetName);

      // 3) 下载（失败回落镜像时字节仍过摘要）
      tempZip = await this.download(url, expected, tag);

      // 4) 独立复核压缩包摘要（纵深防御；同时作为标记里的 archiveSha256）
      this.setProgress({ tag, phase: 'verifying', kind: 'install' });
      const archiveSha256 = await sha256File(tempZip);
      if (archiveSha256 !== expected) {
        throw new XrayInstallError(
          'HASH_MISMATCH',
          `压缩包 sha256 不符：期望 ${expected}，实得 ${archiveSha256 ?? '无法读取'}`
        );
      }

      // 5) 只解出 xray[.exe] 到 staging（与槽位同目录 → 落位 rename 同卷原子）
      this.setProgress({ tag, phase: 'extracting', kind: 'install' });
      const dir = this.overrideDir();
      await fs.mkdir(dir, { recursive: true });
      await this.sweepStaleArtifacts(dir);
      stagingDir = path.join(dir, `.staging-${randomBytes(6).toString('hex')}`);
      await fs.mkdir(stagingDir);
      const binName = xrayBinaryName(this.platform);
      const staged = path.join(stagingDir, binName);
      try {
        await extractZipEntry(tempZip, binName, staged);
      } catch (e) {
        throw new XrayInstallError('EXTRACT_FAILED', errMsg(e));
      }
      if (this.platform !== 'win32') await fs.chmod(staged, 0o755);
      if (this.platform === 'darwin') await this.adhocSign(staged);

      // 6) 自检：版本号必须与 tag 一致（同时是最低版本的第二道检查）；未 force 时用新核 `run -test` 当前配置
      this.setProgress({ tag, phase: 'testing', kind: 'install' });
      const got = await this.probeVersion(staged);
      if (got !== version) {
        throw new XrayInstallError(
          'VERSION_MISMATCH',
          `解出的内核报告版本 ${got ?? '未知'}，与所选 ${version} 不符`
        );
      }
      if (compareSemver(got, this.minVersion) < 0) {
        throw new XrayInstallError(
          'BELOW_MINIMUM',
          `Xray ${got} 低于 FlowZX 支持的最低版本 ${this.minVersion}`
        );
      }
      if (args.force !== true) {
        const test = await this.testLiveConfig(staged);
        if (!test.ok) {
          this.log('warn', `新 Xray ${version} 无法通过当前配置校验（未切换）: ${test.detail}`);
          return { ok: false, code: 'CONFIG_TEST_FAILED', detail: test.detail };
        }
      }
      const binarySha256 = await sha256File(staged);
      if (!binarySha256) throw new XrayInstallError('FAILED', '无法读取解出的内核文件');
      const marker: XrayInstallMarker = {
        tag: rel.tag,
        version,
        prerelease: rel.prerelease,
        binarySha256,
        archiveSha256,
        assetName,
        installedAt: new Date(this.now()).toISOString(),
      };

      // 7) 切换（停代理 → 换核 → 起代理；失败回滚）。force = 用户已在 CONFIG_TEST_FAILED 弹框确认「仍然切换」
      //    （文案明示 Xray 节点可能起不来）→ 重启后 Xray sidecar 没起不再算失败、不回滚；代理本身起不来照旧回滚。
      const activation = await this.activate(
        tag,
        'install',
        () => this.swapInStaged(staged, marker),
        args.force !== true
      );
      if (!activation.ok) return activation;
      this.log(
        'info',
        `Xray 已切换到 ${rel.tag}${rel.prerelease ? '（预发布）' : ''}${activation.restarted ? '，代理已重启' : ''}`
      );
      return {
        ok: true,
        version,
        tag: rel.tag,
        prerelease: rel.prerelease,
        restarted: activation.restarted,
      };
    } catch (e) {
      return this.toFailure(e, 'Xray 安装失败');
    } finally {
      if (tempZip) await fs.unlink(tempZip).catch(() => {});
      if (stagingDir) await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      this.busy = false;
      this.setProgress(null);
    }
  }

  /**
   * 恢复随包版本：槽位二进制 downloaded → 删除；custom → 改名为 xray.custom-bak[.exe]；删标记；代理在跑则重启
   * （失败回滚同 install）。槽位本就为空 → 只清陈旧标记，ok。
   */
  async restoreBundled(): Promise<XrayRestoreResult> {
    if (this.busy) return { ok: false, code: 'BUSY' };
    const blocker = this.coreSwapBlocker();
    if (blocker) {
      return this.toFailure(new XrayInstallError('CORE_BUSY', blocker), '恢复随包 Xray 未开始');
    }
    this.busy = true;
    try {
      if (this.proxyManager?.isLifecycleBusy()) {
        throw new XrayInstallError('PROXY_BUSY', '代理正在启动/停止，请稍后再试');
      }
      const dir = this.overrideDir();
      const slot = path.join(dir, xrayBinaryName(this.platform));
      const markerPath = path.join(dir, XRAY_MARKER_FILE);
      if (!(await pathExists(slot))) {
        await fs.unlink(markerPath).catch(() => {});
        return { ok: true, restarted: false };
      }
      await this.sweepStaleArtifacts(dir);
      const activation = await this.activate(`v${this.bundledVersion}`, 'restore', () =>
        this.parkSlot()
      );
      if (!activation.ok) return activation;
      this.log('info', `已恢复随包 Xray ${this.bundledVersion}`);
      return { ok: true, restarted: activation.restarted };
    } catch (e) {
      return this.toFailure(e, '恢复随包 Xray 失败');
    } finally {
      this.busy = false;
      this.setProgress(null);
    }
  }

  /**
   * 与 sing-box 核更新互斥：其在进行（CoreUpdateService.isBusy）或任一换核窗口仍被持有 → 返回原因，空闲 → null。
   * 同步判定：调用方须在同一同步段内紧接着持锁（busy=true / setCoreSwapInProgress），中间不得有 await。
   */
  private coreSwapBlocker(): string | null {
    if (this.singboxCoreBusy()) return SINGBOX_BUSY_MSG;
    if (this.proxyManager?.isCoreSwapInProgress()) return '内核正在更新，请稍后再试';
    return null;
  }

  private toFailure(
    e: unknown,
    what: string
  ): { ok: false; code: XrayInstallErrorCode; detail: string } {
    if (e instanceof XrayInstallError) {
      this.log('warn', `${what}（${e.code}）: ${e.message}`);
      return { ok: false, code: e.code, detail: e.message };
    }
    this.log('error', `${what}: ${errMsg(e)}`);
    return { ok: false, code: 'FAILED', detail: errMsg(e) };
  }

  // ── 网络 ────────────────────────────────────────────────────────────────────────────────────

  private async fetchReleaseByTag(tag: string): Promise<unknown> {
    try {
      return await this.downloader.fetchGithubJson(`${XRAY_API}/releases/tags/${tag}`);
    } catch (e) {
      const err = e as { code?: unknown; status?: unknown };
      if (err?.code === 'RATE_LIMITED') {
        throw new XrayInstallError('RATE_LIMITED', errMsg(e));
      }
      if (err?.status === 404) throw new XrayInstallError('NOT_FOUND', `GitHub 上没有 Xray ${tag}`);
      throw new XrayInstallError('NETWORK', errMsg(e));
    }
  }

  /**
   * 期望的压缩包 sha256：API digest 优先；release 带 `.dgst`（或 API 无 digest）时也取 `.dgst`（github.com 直连，
   * 不经镜像）交叉核对——两者都有必须一致（HASH_MISMATCH）；都没有 → NO_HASH。.dgst 取失败而 API digest 在 → 照用 digest。
   */
  private async resolveExpectedSha256(
    url: string,
    asset: unknown,
    assets: unknown[],
    assetName: string
  ): Promise<string> {
    const apiDigest = normalizeAssetDigest(asset);
    let dgst: string | null = null;
    const listsDgst = assets.some(
      (a) => !!a && (a as { name?: unknown }).name === `${assetName}.dgst`
    );
    if (listsDgst || !apiDigest) {
      try {
        dgst = parseXrayDgst(await this.downloader.fetchGithubText(`${url}.dgst`, DGST_MAX_BYTES));
        if (!dgst) this.log('warn', `${assetName}.dgst 中没有可识别的 SHA2-256 行`);
      } catch (e) {
        this.log('warn', `获取 ${assetName}.dgst 失败: ${errMsg(e)}`);
      }
    }
    if (apiDigest && dgst && apiDigest !== dgst) {
      throw new XrayInstallError(
        'HASH_MISMATCH',
        `GitHub API 摘要（${apiDigest}）与 .dgst 摘要（${dgst}）不一致，已拒绝安装`
      );
    }
    const expected = apiDigest ?? dgst;
    if (!expected) {
      throw new XrayInstallError(
        'NO_HASH',
        `无法获取 ${assetName} 的官方 sha256 摘要，已拒绝安装未经校验的内核`
      );
    }
    return expected;
  }

  private async download(url: string, expected: string, tag: string): Promise<string> {
    try {
      return await this.downloader.downloadFile(url, false, expected, {
        tempPrefix: 'xray-core-update',
        onProgress: (done, total) => {
          if (total <= 0) return;
          const percent = Math.min(100, Math.floor((done * 100) / total));
          this.progress = { tag, phase: 'downloading', percent, kind: 'install' };
          if (percent === 100 || this.now() - this.lastProgressEmit >= PROGRESS_THROTTLE_MS) {
            this.emitProgress();
          }
        },
      });
    } catch (e) {
      const msg = errMsg(e);
      // 按下载器给的 code 判（直连摘要不符而镜像腿失败时同样保留完整性失败）；文案匹配只作兜底。
      if (
        (e as { code?: unknown } | null)?.code === DOWNLOAD_HASH_MISMATCH ||
        /完整性校验失败/.test(msg)
      ) {
        throw new XrayInstallError('HASH_MISMATCH', msg);
      }
      throw new XrayInstallError('DOWNLOAD_FAILED', msg);
    }
  }

  // ── 自检 ────────────────────────────────────────────────────────────────────────────────────

  private probeVersion(bin: string): Promise<string | null> {
    return new Promise((resolve) => {
      this.execFileFn(
        bin,
        ['version'],
        { timeout: VERSION_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => resolve(err ? null : parseXrayVersion(String(stdout)))
      );
    });
  }

  /**
   * 新核 `run -test -c <userData>/xray_config.json`（上次运行写下的现役 Xray 配置，0600）。文件不存在 → 视为通过
   * （从没跑过 Xray 节点；下次起核的逐节点 -test 闸兜底）。任何失败（含超时）都算不通过：用户可 force 强行切换。
   */
  private testLiveConfig(bin: string): Promise<{ ok: true } | { ok: false; detail: string }> {
    const cfg = this.xrayConfigPath();
    if (!fsSync.existsSync(cfg)) return Promise.resolve({ ok: true });
    return new Promise((resolve) => {
      this.execFileFn(
        bin,
        ['run', '-test', '-c', cfg],
        {
          timeout: CONFIG_TEST_TIMEOUT_MS,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
          // 与 XrayCoreManager 起核同一资产目录（FlowZX 生成的配置不引用 geo 文件，此处仅保持一致）
          env: { ...process.env, XRAY_LOCATION_ASSET: path.dirname(cfg) },
        },
        (err, stdout, stderr) => {
          if (!err) return resolve({ ok: true });
          const out = `${String(stdout ?? '')}\n${String(stderr ?? '')}`.trim();
          resolve({ ok: false, detail: tail(out || errMsg(err)) });
        }
      );
    });
  }

  /** macOS：清隔离标记 + ad-hoc 重签（Gatekeeper 会 SIGKILL 新落地的未签名/改动过的二进制）。尽力而为，失败只记日志。 */
  private async adhocSign(bin: string): Promise<void> {
    const run = (cmd: string, args: string[]) =>
      new Promise<void>((resolve, reject) => {
        this.execFileFn(cmd, args, { timeout: SIGN_TIMEOUT_MS }, (err) =>
          err ? reject(err) : resolve()
        );
      });
    try {
      await run('xattr', ['-cr', bin]);
      await run('codesign', ['--force', '-s', '-', bin]);
    } catch (e) {
      this.log('warn', `macOS 签名处理失败（新 Xray 可能被 Gatekeeper 拦截）: ${errMsg(e)}`);
    }
  }

  // ── 切换 ────────────────────────────────────────────────────────────────────────────────────

  /**
   * 换核 + 整代理重启（决策见头注 5）。mutate 负责实际改槽位并返回回滚句柄；它自身失败时须已复原现场。
   * 门控序列（owner='xray'）：成功 [true,false]；重启失败回滚 [true,false,true,false]（再起代理时门控已清，否则会被
   * 自己的闸拒绝）。
   * requireXray=false（install force）：切换前在跑的 Xray sidecar 重启后没起来不算失败（见 startProxy）。
   * 用户介入（ProxyManager.getLifecycleRequestCounts 出现本流程之外的 start/stop 请求：手动停止 / 连接 / 托盘 / 退出）
   * → 让位：新核留用（commit），不回滚、不再起代理，返回 ok + restarted:false。
   */
  private async activate(
    tag: string,
    kind: 'install' | 'restore',
    mutate: () => Promise<SwapHandle>,
    requireXray = true
  ): Promise<ActivationResult> {
    const pm = this.proxyManager;
    if (pm?.isLifecycleBusy()) {
      throw new XrayInstallError('PROXY_BUSY', '代理正在启动/停止，请稍后再试');
    }
    // 基线（与 getStatus 同一同步段）：此后除本流程自己那一次 stop 外的任何 stop 请求 = 用户要它停着。
    const baseline = pm?.getLifecycleRequestCounts() ?? null;
    const wasRunning = !!pm && pm.getStatus().running;
    let cfg: UserConfig | null = null;
    let xrayWasRunning = false;
    if (pm && wasRunning) {
      cfg = this.configProvider ? await this.configProvider().catch(() => null) : null;
      if (!cfg) throw new XrayInstallError('FAILED', '无法读取当前配置，未切换（代理保持运行）');
      xrayWasRunning = await pm
        .getXrayStatus()
        .then((s) => s.running)
        .catch(() => false);
    }
    // 只有要重启的配置里确有 Xray 节点，「sidecar 没起来」才算新核失败：节点被删 / 订阅剔除而未重启（restartOnNodeChange
    // 关时延后生效）时旧 sidecar 仍在跑，按盘上配置重启本就不会再起 sidecar——那不是新核的问题，不能据此回滚。
    const needXray =
      requireXray &&
      xrayWasRunning &&
      !!cfg &&
      (cfg.servers ?? []).some((s) => requiresXrayCore(s));

    // 互斥复核与持门控同一同步段（install / restore 入口已判过；此处防其它 owner 在 await 期间进入换核窗口）
    const blocker = this.coreSwapBlocker();
    if (blocker) throw new XrayInstallError('CORE_BUSY', blocker);
    this.setProgress({ tag, phase: 'switching', kind });
    let handle: SwapHandle | null = null;
    let swapError: unknown = null;
    pm?.setCoreSwapInProgress(true, 'xray');
    try {
      if (pm && wasRunning) await pm.stop();
      handle = await mutate();
    } catch (e) {
      swapError = e;
    } finally {
      pm?.setCoreSwapInProgress(false, 'xray');
    }
    // 换核窗口内（含本流程 stop 之前的 await）用户停止 / 退出过 → 不再起代理。窗口内被门控拒绝的手动连接不算：
    // 它没起来，恰该由下方重启兑现（停止后又点连接 / 重启 → 最后一次是 start → 照常重启）。
    const stoppedByUser =
      !!pm && !!baseline && this.userStoppedSince(pm, baseline, wasRunning ? 1 : 0);
    if (swapError || !handle) {
      // 槽位未变（mutate 已复原）：把停掉的代理按原配置拉回来
      if (pm && cfg && !stoppedByUser) {
        const againErr = await this.startProxy(pm, cfg, false);
        if (againErr) this.log('error', `换核失败后代理未能重新启动: ${againErr}`);
      }
      throw swapError ?? new XrayInstallError('FAILED', '切换失败');
    }

    let restarted = false;
    if (pm && cfg) {
      if (stoppedByUser) {
        this.log('info', `Xray 已切换到 ${tag}；切换期间代理被手动停止，不再自动重启`);
        await this.commitSwap(handle);
        return { ok: true, restarted: false };
      }
      this.setProgress({ tag, phase: 'restarting', kind });
      const beforeStart = pm.getLifecycleRequestCounts();
      const startErr = await this.startProxy(pm, cfg, needXray);
      if (this.takenOverSince(pm, beforeStart)) {
        // 重启期间用户停止 / 连接 / 退出：代理此刻归用户操作所有。回滚要先 stop——会杀掉用户刚发起的连接，
        // 或在退出拆除后再起 sing-box；判不了成败也不该替用户做主 → 新核留用。
        this.log(
          'info',
          `Xray 已切换到 ${tag}；重启代理期间用户已停止或接管代理，未回滚、不再自动重启` +
            (startErr ? `（本次启动: ${startErr}）` : '')
        );
        await this.commitSwap(handle);
        return { ok: true, restarted: false };
      }
      if (startErr) {
        this.log('error', `切换 Xray 后代理启动失败，回滚到原内核: ${startErr}`);
        let rollbackErr: unknown = null;
        // 判定与持门控同一同步段（无 await）：其后的手动连接被门控拒绝，不会被下方 stop 误杀。
        pm.setCoreSwapInProgress(true, 'xray');
        const beforeRollback = pm.getLifecycleRequestCounts();
        try {
          await pm.stop().catch(() => {});
          await handle.rollback();
        } catch (e) {
          rollbackErr = e;
        } finally {
          pm.setCoreSwapInProgress(false, 'xray');
        }
        // 回滚窗口内用户停止 / 退出 → 保持停止（不在退出拆除后再拉起 sing-box）
        const stoppedDuringRollback = this.userStoppedSince(pm, beforeRollback, 1);
        const againErr = stoppedDuringRollback ? null : await this.startProxy(pm, cfg, false);
        if (rollbackErr) this.log('error', `回滚原 Xray 失败: ${errMsg(rollbackErr)}`);
        if (againErr) this.log('error', `回滚后代理仍未能启动: ${againErr}`);
        return {
          ok: false,
          code: 'START_FAILED',
          detail: tail(rollbackErr ? `${startErr}；回滚失败: ${errMsg(rollbackErr)}` : startErr),
          rolledBack: !rollbackErr,
        };
      }
      restarted = true;
    }
    await this.commitSwap(handle);
    return { ok: true, restarted };
  }

  private commitSwap(handle: SwapHandle): Promise<void> {
    return (handle.commit?.() ?? Promise.resolve()).catch((e) =>
      this.log('warn', `清理旧 Xray 文件失败: ${errMsg(e)}`)
    );
  }

  /**
   * 自 before 起、扣除本流程自己的 ownStops 次 stop 后仍有 stop 请求，且最近一次请求是 stop（用户停止 / 托盘 / 退出）。
   * 用于持门控的窗口：窗口内的手动 start 被门控拒绝、没起来，最后一次是 start 时仍应由本流程把代理拉回来。
   */
  private userStoppedSince(
    pm: ProxyManagerLike,
    before: LifecycleCounts,
    ownStops: number
  ): boolean {
    const now = pm.getLifecycleRequestCounts();
    return now.stops > before.stops + ownStops && now.last === 'stop';
  }

  /** 自 before 起，除本流程自己那一次 start 外是否还有 start/stop 请求（用户停止 / 连接 / 托盘 / 退出 / 重启）。 */
  private takenOverSince(pm: ProxyManagerLike, before: LifecycleCounts): boolean {
    const now = pm.getLifecycleRequestCounts();
    return now.stops !== before.stops || now.starts !== before.starts + 1;
  }

  /**
   * 起代理并判定成败：start 抛错 → 失败；requireXray（切换前 Xray sidecar 在跑、且本次配置仍含 Xray 节点）而切换后
   * sidecar 没起来（选中节点非 Xray 时 ProxyManager 会吞掉 sidecar 失败、只剔除 Xray 节点）→ 也算失败，交回滚。
   * 返回错误文案，成功为 null。
   * 例外：install force（用户已确认新核不认当前配置仍要切换）由调用方传 requireXray=false——Xray 节点被剔除正是
   * 用户已接受的后果，此时回滚反而让「仍然切换」永远切不过去。
   */
  private async startProxy(
    pm: ProxyManagerLike,
    cfg: UserConfig,
    requireXray: boolean
  ): Promise<string | null> {
    try {
      await pm.start(cfg);
    } catch (e) {
      return errMsg(e);
    }
    if (requireXray) {
      const st = await pm.getXrayStatus().catch(() => null);
      if (st && !st.running) return '新 Xray 内核未能随代理启动（可能与当前节点配置不兼容）';
    }
    return null;
  }

  private names(dir: string) {
    const exe = this.platform === 'win32' ? '.exe' : '';
    return {
      slot: path.join(dir, xrayBinaryName(this.platform)),
      bak: path.join(dir, `xray.bak${exe}`),
      customBak: path.join(dir, `xray.custom-bak${exe}`),
      marker: path.join(dir, XRAY_MARKER_FILE),
      exe,
    };
  }

  /**
   * 改动槽位的文件操作，Windows 上对 EBUSY/EPERM/EACCES 短暂重试后报 IN_USE（如测速临时会话占着 xray.exe；刚被
   * SIGKILL 的 xray.exe 映像句柄也可能晚几百 ms 才释放——回滚恰在停代理之后，最需要这层重试）。
   */
  private async retryInUse<T>(op: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await op();
      } catch (e) {
        const code = (e as NodeJS.ErrnoException)?.code;
        const locked = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
        if (this.platform === 'win32' && locked) {
          if (attempt < IN_USE_RETRIES) {
            await new Promise((r) => setTimeout(r, this.inUseRetryDelayMs));
            continue;
          }
          throw new XrayInstallError('IN_USE', `xray.exe 正被占用（${code}），请稍后再试`);
        }
        throw e;
      }
    }
  }

  private renameChecked(from: string, to: string): Promise<void> {
    return this.retryInUse(() => fs.rename(from, to));
  }

  private unlinkChecked(p: string): Promise<void> {
    return this.retryInUse(() => fs.unlink(p));
  }

  /** 已有 xray.custom-bak 且内容与即将备份的文件不同 → 先改名留档（xray.custom-bak-<时间>），保证用户文件永不被覆盖。 */
  private async archiveOldCustomBak(customBak: string, incoming: string, exe: string) {
    if (!(await pathExists(customBak))) return;
    const [a, b] = await Promise.all([sha256File(incoming), sha256File(customBak)]);
    if (a !== null && a === b) return;
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
    const base = customBak.slice(0, customBak.length - exe.length);
    await fs.rename(customBak, `${base}-${stamp}${exe}`);
  }

  /** install 的落位：旧槽位 → xray.bak（custom 另留永久副本）→ staged → 槽位 → 原子写标记。 */
  private async swapInStaged(staged: string, marker: XrayInstallMarker): Promise<SwapHandle> {
    const dir = this.overrideDir();
    const n = this.names(dir);
    const prevMarkerRaw = await fs.readFile(n.marker, 'utf8').catch(() => null);
    const slotExists = await pathExists(n.slot);
    if (slotExists) {
      // 非「应用内安装且未被改动」的槽位文件一律视为用户文件（含 POSIX 下忘了 chmod 的），另存永久副本。
      const prev = await detectXraySource(dir, this.platform);
      if (prev.source !== 'downloaded') {
        await this.archiveOldCustomBak(n.customBak, n.slot, n.exe);
        await fs.copyFile(n.slot, n.customBak);
        this.log('info', `已将自定义 Xray 备份为 ${path.basename(n.customBak)}`);
      }
      await this.renameChecked(n.slot, n.bak);
    }
    try {
      await this.renameChecked(staged, n.slot);
    } catch (e) {
      if (slotExists) await this.renameChecked(n.bak, n.slot).catch(() => {});
      throw e;
    }
    try {
      await writeFileAtomic(n.marker, `${JSON.stringify(marker, null, 2)}\n`);
    } catch (e) {
      await this.unlinkChecked(n.slot).catch(() => {});
      if (slotExists) await this.renameChecked(n.bak, n.slot).catch(() => {});
      throw new XrayInstallError('FAILED', `写入安装标记失败: ${errMsg(e)}`);
    }
    return {
      rollback: async () => {
        // 回滚紧跟停代理：被替换 / 删除的正是刚被杀掉的新 xray.exe → 同样要 Windows 占用重试
        if (slotExists) await this.renameChecked(n.bak, n.slot);
        else await this.unlinkChecked(n.slot);
        if (prevMarkerRaw !== null) await writeFileAtomic(n.marker, prevMarkerRaw);
        else await fs.unlink(n.marker).catch(() => {});
      },
    };
  }

  /** restore 的落位：downloaded → 暂停放到 .restore-*（成功后删）；custom → 改名为 xray.custom-bak；删标记。 */
  private async parkSlot(): Promise<SwapHandle> {
    const dir = this.overrideDir();
    const n = this.names(dir);
    const prev = await detectXraySource(dir, this.platform);
    const prevMarkerRaw = await fs.readFile(n.marker, 'utf8').catch(() => null);
    let parked: string;
    if (prev.source === 'downloaded') {
      parked = path.join(dir, `.restore-${randomBytes(6).toString('hex')}${n.exe}`);
    } else {
      await this.archiveOldCustomBak(n.customBak, n.slot, n.exe);
      parked = n.customBak;
    }
    await this.renameChecked(n.slot, parked);
    if (prevMarkerRaw !== null) {
      try {
        await fs.unlink(n.marker);
      } catch (e) {
        await this.renameChecked(parked, n.slot).catch(() => {});
        throw new XrayInstallError('FAILED', `删除安装标记失败: ${errMsg(e)}`);
      }
    }
    if (prev.source !== 'downloaded') {
      this.log('info', `已将自定义 Xray 移到 ${path.basename(n.customBak)}`);
    }
    return {
      rollback: async () => {
        await this.renameChecked(parked, n.slot);
        if (prevMarkerRaw !== null) await writeFileAtomic(n.marker, prevMarkerRaw);
      },
      commit: prev.source === 'downloaded' ? () => fs.rm(parked, { force: true }) : undefined,
    };
  }

  /** 清理上次崩溃/断电残留的 staging 目录与 restore 停放文件（持锁时调用，不会误删进行中的）。 */
  private async sweepStaleArtifacts(dir: string): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (/^\.(staging|restore)-[0-9a-f]+(\.exe)?$/.test(name)) {
        await fs.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}
