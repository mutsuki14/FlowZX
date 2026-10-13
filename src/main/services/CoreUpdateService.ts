/**
 * 核心更新服务
 * 负责检查 Sing-box 核心更新、下载并替换
 */

import { app, dialog } from 'electron';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { LogManager } from './LogManager';
import { ProxyManager } from './ProxyManager';
import type { HelperManager } from './HelperManager';
import { PlatformPrivilegeService } from './PlatformPrivilegeService';
import { resourceManager } from './ResourceManager';

import type { UserConfig, HelperStatus, TunStack } from '../../shared/types';
import { encodeMajorMinor, sameMajorMinor, compareSemver } from '../../shared/version';
import { resolveTunStack } from '../../shared/tun-defaults';
import {
  listableSingboxReleases,
  normalizeSingboxRelease,
  parseSingboxBuildTags,
  singboxTagVersion,
  type SingboxInstallErrorCode,
  type SingboxInstallPhase,
  type SingboxInstallProgress,
  type SingboxInstallResult,
  type SingboxInstallState,
  type SingboxPin,
  type SingboxRelease,
  type SingboxReleaseList,
} from '../../shared/singbox-release';
import {
  classifyCoreBuild,
  classifyReseedResult,
  comparableCoreVersion,
  decideCoreOverride,
  extractVersionToken,
  parseUploadedCoreVersion,
  type CoreBuildKind,
} from '../../shared/core-build';
import { CoreUpdateStateStore } from './core-update-state-store';
import type { StagedCoreInfo, CoreAutoUpdateState } from './core-update-state-store';
import { CoreDownloader, DOWNLOAD_HASH_MISMATCH } from './core-downloader';
import { RELEASE_PAGING } from './github-release-pages';
import { CoreStartTunPersistentError } from './core-readiness';
import type { UpdateNetwork } from './UpdateNetwork';
import coreManifest from '../../shared/core-manifest.json';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import { normalizeAssetDigest } from './singbox-asset';
import { extractLastFatal, stripAnsi } from '../../shared/singbox-fatal';
import { system32 } from '../utils/win-system32';

export interface CoreUpdateCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion?: string;
  downloadUrl?: string;
  /** 该资产的 sha256（小写裸 hex，取自 GitHub API 的 asset.digest）。运行期换核的完整性锚。 */
  downloadSha256?: string;
  releaseNotes?: string;
  crossBand?: boolean; // latestVersion 是否跨当前 minor 带（restrict 关闭时让 UI 标「跨大版本、风险更高」）
  error?: string;
}

export interface CoreVersionInfo {
  currentVersion: string;
  backupVersion: string | null;
  hasBackup: boolean;
  // 内核来源：official=官方 / fork=第三方（禁在线·自动更新）/ unknown=无法确认（仅提示）。
  build: CoreBuildKind;
  // 内核版本变更「待展示通知」（push 型持久位）：非空 = 有一条由更新动作创建、尚未展示 ack 的变更提示。
  // banner 读它决定是否弹（取代旧推断式比对）；静默 reseed 不创建 → 不弹。
  pendingChangeNotice?: { previousVersion: string; currentVersion: string } | null;
  /** 随包（出厂）内核版本 = 版本选择的最低可选版本。 */
  bundledVersion: string;
  /** 生效中的固定版本（当前内核仍是它时自动更新暂停）；无 / 已陈旧 → null。 */
  pinned: SingboxPin | null;
}

// StagedCoreInfo / CoreAutoUpdateState 迁至 core-update-state-store（与 CoreUpdateStateStore 同处）；re-export 保对外兼容。
export type { StagedCoreInfo, CoreAutoUpdateState };

/**
 * tryApplyStaged 落位结果枚举（供 applyStagedNow / UI 区分反馈）：
 * - applied:   已换核落位成功（installCoreFromDir 完成、staged 已清）
 * - discarded: staged 已不适用被作废（不再领先 / known-bad / 缺文件 / 重预检失败），未换核
 * - deferred:  代理运行中暂不落位，保持 staged（待安全窗口生效）；或开关已关不自动落位
 * - failed:    落位中途异常（已尽力 restoreBackup），staged 保留待重试
 * - noop:      无 staged 可落位 / isUpdating 重入 → 无操作
 */
export type StagedApplyResult = 'applied' | 'discarded' | 'deferred' | 'failed' | 'noop';

/** Xray 版本切换（XrayCoreUpdateService）进行中：sing-box 换核类操作一律拒绝/推迟（两条换核流程互斥）。 */
const XRAY_BUSY_MSG = 'Xray 内核正在切换，请稍后再试';
/** 另一 sing-box 内核操作（安装 / 更新 / 自动轮次 / 恢复随包 / 回滚 / 手动替换 / 立即应用）在飞：一次只允许一个。 */
const CORE_BUSY_MSG = '内核更新正在进行中，请稍后再试';

/** withCoreOp 拒绝开始的原因（BUSY = 另一内核操作在飞；XRAY_BUSY = Xray 版本切换在进行）。 */
type CoreOpBusyCode = 'BUSY' | 'XRAY_BUSY';

/** 带 code 的「未开始」错误（经 IPC ApiResponse.code 透传到渲染端 error.code）。 */
const coreOpBusyError = (code: CoreOpBusyCode): Error =>
  Object.assign(new Error(code === 'BUSY' ? CORE_BUSY_MSG : XRAY_BUSY_MSG), { code });

/** replaceManualCore 的结果（needConfirm 系列由前端弹确认后带 force 重入）。 */
type ManualCoreReplaceResult = {
  ok: boolean;
  needConfirm?: boolean;
  sameVersion?: string;
  baselineOverride?: boolean;
  uploadVersion?: string;
  bundledVersion?: string;
  build?: CoreBuildKind;
  filePath?: string;
  error?: string;
  /** 未开始即被拒：BUSY = 另一内核操作在飞；XRAY_BUSY = Xray 版本切换在进行。 */
  code?: CoreOpBusyCode;
};

/** 推渲染端的内核自动更新状态快照（UI：待生效行 / 跨带提示行）。 */
export interface CoreAutoStatus {
  autoUpdateEnabled: boolean;
  lastCheckAt: number | null;
  staged: { version: string; stagedAt: string } | null;
  crossBandLatest: string | null; // 检测到但跨 minor、不自动的最新版本
  /** 版本选择里「固定此版本」：非 null 时自动更新暂停（不检查下载、不落位 staged），直到取消固定或版本被其它途径改变。 */
  pinned: SingboxPin | null;
}

/** resetCoreToFactory 的结果：code 仅在未开始时给出（BUSY = 已有内核更新 / 安装 / 换核在进行；XRAY_BUSY = Xray 正在切换）。 */
export interface CoreFactoryResetResult {
  ok: boolean;
  error?: string;
  code?: 'BUSY' | 'XRAY_BUSY';
}

/**
 * 兼容版本带「地板」= 随 App 出厂的内核版本带（编码 major*1000+minor，1.13.13→1013）。出厂内核必经 FlowZ
 * 配置生成器验证，故其版本带即官方背书的兼容下限，**从出厂内核动态推导、不再独立硬编码**（去掉了 manifest 的
 * compatibleCeiling 字段，消除「两字段手动同步」隐患）。有效兼容上限 = max(地板, 当前实跑带, verifiedCeiling)，
 * 见 checkUpdate；跨越有效上限默认不自动更新（可在设置关闭）。
 */
const BUNDLED_CEILING = encodeMajorMinor(coreManifest.bundledCoreVersion);

// ── 版本选择（installTag / listReleases）常量 ──────────────────────────────────────────────────
const SINGBOX_API = 'https://api.github.com/repos/SagerNet/sing-box';
const SINGBOX_DOWNLOAD = 'https://github.com/SagerNet/sing-box/releases/download';
/** release 列表缓存时长（未认证 GitHub API 60 次/小时/IP，设置页每次挂载都打会很快被限流）。 */
export const SINGBOX_LIST_TTL_MS = 10 * 60 * 1000;
/** 残缺列表（第 2 页起某页失败，只拿到前几页）的缓存时长：照常展示，但很快就重取，不把残缺结果钉 10 分钟。 */
export const SINGBOX_LIST_PARTIAL_TTL_MS = 60 * 1000;
/** 下载进度事件节流（~4 次/秒）；阶段切换与结束事件不节流。 */
const INSTALL_PROGRESS_THROTTLE_MS = 250;
/**
 * 预检里 `sing-box version` / `sing-box check` 的超时：外来 / 挂起的二进制不得永久持有 isUpdating / coreOps
 * （coreOps 还连带阻塞 Xray 切换）。check 大配置实测 < 2s，20s 足够宽裕。
 */
const CORE_EXEC_TIMEOUT_MS = 20_000;
/** 渲染端 detail 上限（`sing-box check` 的 stderr 取尾部）。 */
const INSTALL_DETAIL_MAX = 2000;

/** release 列表缓存项（partial = 分页中途失败、只含前几页 → 用短缓存）。 */
type SingboxListCacheEntry = { releases: SingboxRelease[]; fetchedAt: number; partial: boolean };

/** installTag 预期内的失败（带 code，映射为 { ok:false, code, detail }）。 */
class SingboxInstallError extends Error {
  constructor(
    readonly code: SingboxInstallErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'SingboxInstallError';
  }
}

type LifecycleCounts = ReturnType<ProxyManager['getLifecycleRequestCounts']>;

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const clipTail = (s: string): string =>
  s.length > INSTALL_DETAIL_MAX ? `…${s.slice(-INSTALL_DETAIL_MAX)}` : s;

/**
 * 换核后起代理失败（null = 起来了）。environmental 见 isEnvironmentalStartError；tunPersistent = 终态 TUN 持续性失败
 * （CoreStartTunPersistentError，不论成因）——回滚后原核也以它失败 → 成因是环境，不把新版本记为问题版本。
 */
type InstallStartFailure = { msg: string; environmental: boolean; tunPersistent: boolean };

/**
 * 起代理失败是否属于「环境 / 用户」原因、与新内核版本无关——回滚无益（原核照样起不来），还会把健康的新版本误记为
 * 问题版本（之后自动更新 / 版本列表都避开它）。只认这些在起核前 / 起核外就确定的信号：
 *  - TUN 持续性失败且核自己的 FATAL 落在 TUN 层（fatalKind 'tun-*'：地址冲突 / wintun 适配器创建 / TUN DNS / 其它
 *    TUN 接口配置；issue #324）。泛化的「重试预算耗尽、适配器从未出现」终态（fatalKind 'other' / 无 FATAL）**不算**：
 *    新核在建 TUN 之前就崩（运行期才暴露的坏核，`check` 查不出）在 Windows helper 路径上正是这个终态，须照常回滚；
 *  - 用户在提权引导里点了取消（HELPER_GATE_ABORTED）；
 *  - 用户取消管理员授权：UAC / osascript 密码框（「用户取消了管理员权限请求」）、Linux pkexec（「授权被取消」）；
 *  - 起核前的端口 / 残留进程清理受阻（CLASH_API_PORT_BUSY*、ROOT_ORPHAN_BLOCKED：此时新核还没 spawn）。
 * 泛化的「权限 / EACCES」不算：新二进制没有执行权限这类落位问题正该回滚。
 */
function isEnvironmentalStartError(e: unknown): boolean {
  if (e instanceof CoreStartTunPersistentError) return e.fatalKind?.startsWith('tun-') ?? false;
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 'HELPER_GATE_ABORTED' || code === 'ROOT_ORPHAN_BLOCKED') return true;
  if (typeof code === 'string' && code.startsWith('CLASH_API_PORT_BUSY')) return true;
  return /用户取消了管理员权限请求|授权被取消/.test(errMsg(e));
}

/**
 * 版本号带预发布后缀（`1.15.0-alpha.12`、其 dev 构建，或任何 `X.Y.Z-…` 形态）。这类版本「跑通过」不代表该 minor 带已
 * 兼容（预发布随时还会改 schema），故不据此抬高兼容带实证上限 verifiedCeiling。
 */
const hasPrereleaseSuffix = (version: string): boolean =>
  /^\d+\.\d+(?:\.\d+)?-/.test(comparableCoreVersion(version));

/**
 * 流式计算文件 sha256（小写 hex；压缩包几十 MB，不整读进内存）。
 * 等句柄真正关闭（'close'）才落定：调用方紧接着删临时包，Windows 上不能撞仍打开的读句柄。
 */
function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let ended = false;
    fs.createReadStream(filePath)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => {
        ended = true;
      })
      .on('close', () => {
        if (ended) resolve(hash.digest('hex'));
        else reject(new Error('读取文件中断'));
      });
  });
}

export class CoreUpdateService {
  private logManager: LogManager;
  private proxyManager: ProxyManager | null = null;
  // helper 的 install-core 能力窄视图（mac HelperManager / linux LinuxServiceHelper 均满足 getStatus+installCore；
  // Windows 无 install-core）。B 块：经 helper install-core 写 root 受保护/受管核目录。
  private helperManager: Pick<HelperManager, 'getStatus' | 'installCore'> | null = null;
  private privilegeService: PlatformPrivilegeService | null = null; // T16：copyFileElevatedWindows delegate
  private isUpdating: boolean = false;
  /**
   * 换核类操作在飞计数（updateCore / installTag / resetCoreToFactory / tryApplyStaged / applyStagedNow /
   * replaceManualCore / rollbackCore）：与 Xray 版本切换互斥，各公开入口也据它（连同 isUpdating）互斥。isBusy() 据此回答
   * XrayCoreUpdateService；自动轮次的后台检查 / 下载段不计（只有落位才计）。
   */
  private coreOps = 0;
  /** Xray 版本切换是否在进行（index.ts 注入 XrayCoreUpdateService.isBusy；未注入 → 恒 false）。 */
  private xrayBusy: () => boolean = () => false;
  /**
   * 最近一次 checkUpdate 解析出的「下载 URL → sha256」映射。updateCore 只认这里（或现取），
   * **不接受调用方传入摘要**——否则渲染层/IPC 侧一个疏忽就能把校验降级成不校验，而这正是要防的。
   */
  private assetDigestByUrl = new Map<string, string>();
  // 更新后等待「首次成功运行」验证的新版本号；首启成功→清除并删备份，首启失败→自动回滚
  private pendingUpdateVersion: string | null = null;
  private pendingUpdateAt: number = 0; // 更新落盘时间戳，用于"待验证"过期保护（防陈旧 pending 误回滚）
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  // 兜底计时器：更新后若迟迟无 'started'/'error' 事件来解决待验证态（如更新时代理未运行、用户不重启），
  // 到期解除自动重启抑制，避免抑制闩永久挂起。
  private pendingFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 新核首启验证期内报错（autoRollbackIfPendingUpdate 被调），但当时另一内核操作持锁 → 回滚**推迟**到锁释放
   * （afterCoreOpReleased），而不是丢弃。arm / disarm 待验证闩时作废（新一轮验证开始 / 持锁方已自行回滚）。
   */
  private rollbackDeferred = false;
  /** 推迟的回滚到期时的执行方（index.ts 注入：autoRollbackIfPendingUpdate → 回滚成功则以旧核重启代理）。 */
  private deferredRollbackHandler: (() => Promise<void>) | null = null;
  /**
   * 本轮待验证的新核替换掉的是第三方内核（installTag 经 fork 确认覆盖）→ 稳定观察判稳后**保留** .bak（用户确认时被告知
   * 可用「回滚」找回它；第三方核无从重新下载）。每次 arm / disarm 复位，其余安装 / 更新 / 替换照常判稳即删备份。
   */
  private retainBackupOnStable = false;
  private configProvider: (() => Promise<UserConfig>) | null = null;
  // 推渲染端的自动更新状态事件发送器（注入，仿 configProvider；不直接 import electron ipc 便于隔离）
  private eventSender: ((channel: string, payload: unknown) => void) | null = null;
  // 新核心首启成功后需"稳定运行"此时长（无 error）才删旧备份——防 'started'(仅1s存活) 假成功删掉回滚网。
  // 不变量：必须 > ProxyManager 健康检查间隔(10s)，否则 TUN 模式下崩溃在轮询检测到之前就被判稳定、误删备份。
  private static readonly STABILITY_DWELL_MS = 30000;
  // "待验证"最长有效期：超过则后续 error 视为与本次更新无关，不再触发回滚（防陈旧 pending 误回滚）
  private static readonly PENDING_MAX_AGE_MS = 5 * 60 * 1000;

  private readonly stateStore: CoreUpdateStateStore;
  private readonly coreDownloader: CoreDownloader;

  // ── 版本选择（installTag / listReleases）状态 ──
  /** 资产名 / helper 门 / TUN Auto 解析用的平台与架构（缺省取本机；单测覆写以覆盖他平台分支）。 */
  private platform: NodeJS.Platform = process.platform;
  private arch: string = process.arch;
  /** 时钟（列表缓存 / 进度节流 / pinnedAt；单测覆写）。 */
  private now: () => number = () => Date.now();
  /** 停代理后等进程完全退出再换核（同 updateCore 的 2s；单测置 0）。 */
  private swapSettleMs = 2000;
  private releaseListCache: SingboxListCacheEntry | null = null;
  private releaseListInflight: Promise<SingboxListCacheEntry> | null = null;
  /** 进行中的安装 / 恢复随包进度（主进程持有，设置卡卸载重挂后经 getInstallState 找回）。 */
  private installProgress: SingboxInstallProgress | null = null;
  private lastInstallProgressEmit = 0;

  constructor(logManager: LogManager) {
    this.logManager = logManager;
    this.stateStore = new CoreUpdateStateStore(logManager, app.getPath('userData'));
    // configProvider 在构造后才注入，故传惰性 thunk：调用时读当前 this.configProvider（未配置→null）。
    this.coreDownloader = new CoreDownloader(logManager, () =>
      this.configProvider ? this.configProvider() : Promise.resolve(null)
    );
  }

  setProxyManager(proxyManager: ProxyManager): void {
    this.proxyManager = proxyManager;
  }

  /** 与 Xray 版本切换互斥：注入「Xray 换核在进行」判定（XrayCoreUpdateService.isBusy）。 */
  setXrayBusyCheck(fn: () => boolean): void {
    this.xrayBusy = fn;
  }

  /** sing-box 换核类操作是否在进行（XrayCoreUpdateService 据此拒绝在此期间切换 Xray）。 */
  isBusy(): boolean {
    return this.coreOps > 0;
  }

  /**
   * 换核类公开入口（回滚 / 手动替换 / 立即应用）的包装：判定与持闸在同一同步段（async 函数首个 await 之前），不开始
   * 时 onBusy(code)：
   *  - BUSY：另一内核操作在飞（isUpdating = 在线安装 / 检查更新 / 自动轮次 / 恢复随包；coreOps>0 = 回滚 / 手动替换 /
   *    立即应用）。一次只允许一个换核操作——否则两方交错 stop / 门控 / .bak：先结束的一方替仍在写核的一方放开换核门控
   *    （门控按 owner 记账，同为 'singbox'），回滚还会吃掉对方失败恢复要用的 .bak；
   *  - XRAY_BUSY：Xray 版本切换在进行（与 XrayCoreUpdateService 入口的对称判定构成互斥）。
   * 已持锁的内部调用（恢复随包的落位腿）直接调 *Locked 本体，不经此处。
   */
  private async withCoreOp<T>(
    fn: () => Promise<T>,
    onBusy: (code: CoreOpBusyCode) => T
  ): Promise<T> {
    if (this.isUpdating || this.coreOps > 0) return onBusy('BUSY');
    if (this.xrayBusy()) return onBusy('XRAY_BUSY');
    this.coreOps++;
    try {
      return await fn();
    } finally {
      this.coreOps--;
      this.afterCoreOpReleased();
    }
  }

  /** 注入「推迟的首启失败回滚」执行方（见 rollbackDeferred）。 */
  setDeferredRollbackHandler(fn: () => Promise<void>): void {
    this.deferredRollbackHandler = fn;
  }

  /**
   * 每个持锁入口（isUpdating / coreOps）在 finally 放锁后调用：锁已全部释放且有被推迟的首启失败回滚 → 现在执行。
   * 执行方内部再走 autoRollbackIfPendingUpdate：此刻若又被别的操作抢先持锁，它会再次推迟（不丢）；PENDING_MAX_AGE
   * 过期保护照常生效。
   */
  private afterCoreOpReleased(): void {
    if (!this.rollbackDeferred || this.isUpdating || this.coreOps > 0) return;
    this.rollbackDeferred = false;
    const run = this.deferredRollbackHandler;
    if (!run) return;
    this.logManager.addLog('info', '内核操作已结束，执行推迟的首启失败回滚', 'CoreUpdateService');
    void run().catch((e) =>
      this.logManager.addLog('error', `推迟的自动回滚失败: ${errMsg(e)}`, 'CoreUpdateService')
    );
  }

  /** §8：把更新链路统一会话层转发给 CoreDownloader（核更新链路接入 update-in）；proxyRunning/update-in 端口惰性读 this.proxyManager。 */
  setUpdateNetwork(updateNetwork: UpdateNetwork): void {
    this.coreDownloader.setUpdateNetwork(updateNetwork);
  }

  /** B 块：注入 helper（macOS/Linux 持久化内核更新经 helper install-core 写 root 受保护/受管核目录）。 */
  setHelperManager(helperManager: Pick<HelperManager, 'getStatus' | 'installCore'>): void {
    this.helperManager = helperManager;
  }

  /** T16：注入平台提权服务（copyFileElevatedWindows delegate → service.copyFileElevated）。 */
  setPrivilegeService(service: PlatformPrivilegeService): void {
    this.privilegeService = service;
  }

  /** 注入配置读取器（用于读取"仅兼容版本带内更新"开关）。 */
  setConfigProvider(provider: () => Promise<UserConfig>): void {
    this.configProvider = provider;
  }

  /** 注入渲染端事件发送器（推内核自动更新状态：staged 待生效 / 跨带提示）。 */
  setEventSender(fn: (channel: string, payload: unknown) => void): void {
    this.eventSender = fn;
  }

  async checkUpdate(): Promise<CoreUpdateCheckResult> {
    try {
      this.logManager.addLog('info', '正在检查 Sing-box 核心更新...', 'CoreUpdateService');

      const currentVersion = await this.getCurrentVersion();

      // 第三方（非官方）内核：禁在线更新（不打 GitHub），避免覆盖用户刻意安装的 fork。
      // 自动调度经 runAutoUpdateCycle→checkUpdate 同被此闸拦下（=自动更新对 fork 失效）。
      if ((await this.getCoreBuild()) === 'fork') {
        this.logManager.addLog(
          'info',
          '检测到第三方（非官方）内核，已禁用在线检查更新',
          'CoreUpdateService'
        );
        return {
          hasUpdate: false,
          currentVersion,
          error:
            '当前为第三方（非官方）内核，已禁用在线更新；如需恢复官方更新，请先回滚或重置到出厂内核',
        };
      }

      const releases = await this.coreDownloader.fetchReleases();

      if (!releases || releases.length === 0) {
        return { hasUpdate: false, currentVersion, error: '未找到发布版本' };
      }

      // 只看正式版：非草稿、非预发布（API 标志或 tag 带 -alpha/-beta/-rc 后缀，与版本选择同一口径）、tag 形状合法。
      const validReleases = releases.filter((r: any) => {
        if (!r || r.draft === true || r.prerelease === true) return false;
        const v = singboxTagVersion(r.tag_name);
        return !!v && !hasPrereleaseSuffix(v);
      });
      if (validReleases.length === 0) {
        return { hasUpdate: false, currentVersion, error: '未找到正式版本' };
      }

      // 取**版本号最大**的正式版，不取 API 首个：上游多分支交错发布（1.13.x 补丁与 1.14.x 交替出现），API 的时间序
      // 不是版本序——取首个会把更晚发布的旧分支补丁当成「最新」（手动检查与自动轮次同经此处）。
      const latestRelease = validReleases.reduce((best: any, r: any) =>
        compareSemver(singboxTagVersion(r.tag_name)!, singboxTagVersion(best.tag_name)!) > 0
          ? r
          : best
      );
      const latestVersion = singboxTagVersion(latestRelease.tag_name)!;

      this.logManager.addLog(
        'info',
        `当前版本: ${currentVersion}, 最新版本: ${latestVersion}`,
        'CoreUpdateService'
      );

      if (this.compareVersions(latestVersion, currentVersion) > 0) {
        // 跳过曾预检/启动失败的问题版本（手动更新可绕过）
        if (this.isKnownBad(latestVersion)) {
          this.logManager.addLog(
            'info',
            `最新版本 ${latestVersion} 曾验证失败，已跳过自动更新`,
            'CoreUpdateService'
          );
          return {
            hasUpdate: false,
            currentVersion,
            latestVersion,
            error: `版本 ${latestVersion} 与当前配置不兼容（已跳过）；如需仍可手动更新`,
          };
        }

        // 版本带闸门：默认不自动跨越「有效兼容上限」（防 schema 破坏导致无法解析）。有效上限 =
        // max(出厂内核带, 当前实跑带, verifiedCeiling)——出厂带是官方背书地板；当前实跑带 + verifiedCeiling 是
        // 「已成功运行实证兼容」的带，使手动跨带成功后不被锁在首版、放行同带补丁；preflightValidate 每次仍兜底，
        // 与自动闸 sameMajorMinor 的 current 基准统一。地板守住「首次跨带仍需用户主动」。
        if (await this.isRestrictToCompatibleMinor()) {
          const latest = encodeMajorMinor(latestVersion);
          const curEnc = encodeMajorMinor(currentVersion);
          const verified = this.loadAutoState().verifiedCeiling ?? 0;
          const effectiveCeiling = Math.max(BUNDLED_CEILING, isNaN(curEnc) ? 0 : curEnc, verified);
          if (!isNaN(latest) && latest > effectiveCeiling) {
            this.logManager.addLog(
              'info',
              `最新版本 ${latestVersion} 跨越当前兼容版本带，不自动更新`,
              'CoreUpdateService'
            );
            return {
              hasUpdate: false,
              currentVersion,
              latestVersion,
              error: `新版本 ${latestVersion} 跨越兼容版本带，建议随 App 升级（可在设置关闭"仅兼容版本带内更新"以手动尝试）`,
            };
          }
        }

        // 找到适合当前平台的资源
        const asset = this.coreDownloader.findSuitableAsset(latestRelease.assets);
        if (asset) {
          const digest = normalizeAssetDigest(asset);
          if (digest) this.assetDigestByUrl.set(asset.browser_download_url, digest);
          const result = {
            hasUpdate: true,
            currentVersion,
            latestVersion,
            downloadUrl: asset.browser_download_url,
            downloadSha256: digest ?? undefined,
            releaseNotes: latestRelease.body,
            // 跨当前 minor 带（如 1.13→1.14）→ UI 标风险。能走到这说明带内或 restrict 关闭，跨带必是 restrict 关闭所致。
            crossBand: !sameMajorMinor(latestVersion, currentVersion),
          };
          this.logManager.addLog(
            'info',
            `Found suitable asset: ${asset.browser_download_url}`,
            'CoreUpdateService'
          );
          return result;
        } else {
          const msg = `未找到适合当前平台的构建 (Platform: ${process.platform}, Arch: ${process.arch})`;
          this.logManager.addLog('warn', msg, 'CoreUpdateService');
          return { hasUpdate: false, currentVersion, error: msg };
        }
      }

      return { hasUpdate: false, currentVersion };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logManager.addLog('error', `检查核心更新失败: ${msg}`, 'CoreUpdateService');
      return { hasUpdate: false, currentVersion: '未知', error: msg };
    }
  }

  /**
   * 解析某下载 URL 对应的 sha256（小写裸 hex）；解析不出返回 null。
   *
   * 顺序：本次会话 checkUpdate 写下的缓存 → 现拉一次 releases 重新解析（缓存冷：App 重启后用户直接点更新，
   * 或自动更新腿跨会话触发）。**刻意不接受调用方传入的摘要**——摘要是安全断言，来源必须由服务自己掌握，
   * 否则任何一个漏传/传错的调用点都会把校验静默降级成不校验。
   *
   * 实测依据：GitHub REST 对全部 asset 回填 `digest`（v1.12.0 / v1.13.0 / v1.14.0-beta.7 逐个验过），
   * 故「解析不出」属异常而非常态，调用方据此 fail-closed 是可行的、不会卡住正常更新。
   */
  private async resolveAssetSha256(downloadUrl: string): Promise<string | null> {
    const cached = this.assetDigestByUrl.get(downloadUrl);
    if (cached) return cached;
    try {
      const releases = await this.coreDownloader.fetchReleases();
      for (const rel of releases || []) {
        for (const a of rel?.assets || []) {
          const d = normalizeAssetDigest(a);
          if (d && a?.browser_download_url) this.assetDigestByUrl.set(a.browser_download_url, d);
        }
      }
    } catch (e) {
      this.logManager.addLog(
        'warn',
        `重新解析内核资产摘要失败（将拒绝安装未校验的内核）: ${e}`,
        'CoreUpdateService'
      );
      return null;
    }
    return this.assetDigestByUrl.get(downloadUrl) ?? null;
  }

  async updateCore(downloadUrl: string): Promise<boolean> {
    // 同步临界区：check+set 全在第一个 await 之前完成。旧实现在检查 isUpdating 与置位之间 await 了 fork 守卫，两次调用
    // （或与自动轮次 / 在线安装）可同时通过 → 并发双换核，且先结束的一方在 finally 里替仍在跑的一方放了锁。
    // coreOps>0 = 回滚 / 手动替换 / 立即应用 / 恢复随包在飞（它们不一定持 isUpdating）——同样不并发换核。
    // 带 code（BUSY / XRAY_BUSY）：经 IPC 透传到渲染端按 code 出本地化文案。
    if (this.isUpdating || this.coreOps > 0) throw coreOpBusyError('BUSY');
    // 与 Xray 版本切换互斥（判定与持闸同一同步段）：Xray 换核期间不换 sing-box 核，反之 Xray 也拒绝开始。
    if (this.xrayBusy()) throw coreOpBusyError('XRAY_BUSY');
    this.isUpdating = true;
    this.coreOps++;
    let backupMade = false;

    try {
      // 第三方（非官方）内核：拒绝在线更新，避免覆盖用户刻意安装的 fork。force 刷新版本行（本方法守卫前无 getCurrentVersion）。
      if ((await this.getCoreBuild(true)) === 'fork') {
        throw new Error(
          '当前为第三方（非官方）内核，已禁用在线更新；请先回滚或重置到出厂内核后再更新'
        );
      }

      // 1. 下载文件（先取摘要：拿不到就不装——运行期换核会回落第三方镜像，无摘要即无从判断拿到的是什么）
      const sha256 = await this.resolveAssetSha256(downloadUrl);
      if (!sha256) {
        throw new Error(
          '无法获取该内核资产的官方 sha256 摘要，已中止更新（拒绝安装未经校验的内核）。请稍后重试或检查网络。'
        );
      }
      this.logManager.addLog('info', '开始下载核心文件...', 'CoreUpdateService');
      const tempPath = await this.coreDownloader.downloadFile(downloadUrl, false, sha256);

      // 2. 解压文件 (如果需要)
      // Sing-box release 通常是 .tar.gz 或 .zip
      this.logManager.addLog('info', '正在解压核心文件...', 'CoreUpdateService');
      const { corePath, extractDir: tempExtractDir } =
        await this.coreDownloader.extractCore(tempPath);

      // 2.5 预检：新核心可执行 + 可解析当前配置。不通过则不动现役核心（代理继续运行，永不 brick）。
      const preflight = await this.preflightValidate(corePath);
      if (!preflight.ok) {
        if (preflight.version) this.markKnownBad(preflight.version);
        try {
          fs.unlinkSync(tempPath);
          if (tempExtractDir && fs.existsSync(tempExtractDir)) {
            fs.rmSync(tempExtractDir, { recursive: true, force: true });
          }
        } catch {
          /* ignore */
        }
        throw new Error(`核心更新预检失败，已放弃（现役核心继续运行）：${preflight.reason}`);
      }

      // 3. 停止代理
      let wasRunning = false;
      if (this.proxyManager) {
        const status = this.proxyManager.getStatus();
        if (status.running) {
          this.logManager.addLog('info', '正在停止代理服务...', 'CoreUpdateService');
          await this.proxyManager.stop();
          wasRunning = true;
          // 等待进程完全退出
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }

      // 4-5. 备份→替换核心→签名→待验证闩（抽到 installCoreFromDir，手动/自动落位共用，行为零变）。
      // onBackupDone 在 backupCurrentCore() 成功后同点回调，保持原 backupMade 语义（预检前失败不误恢复陈旧 .bak）。
      // core-swap 手动轴门控：标记「二进制替换窗口」开启——installCoreFromDir 执行期间拒绝手动 start/restart/switchMode
      // （防撞半替换核 FATAL）。try/finally 精确覆盖 installCoreFromDir；清位后下方 proxyManager.start 放行。
      this.proxyManager?.setCoreSwapInProgress(true);
      try {
        await this.installCoreFromDir(path.dirname(corePath), preflight.version, () => {
          backupMade = true;
        });
      } finally {
        this.proxyManager?.setCoreSwapInProgress(false);
      }

      // 6. 清理临时文件
      try {
        fs.unlinkSync(tempPath);
        // 清理整个临时解压目录
        if (tempExtractDir && fs.existsSync(tempExtractDir)) {
          fs.rmSync(tempExtractDir, { recursive: true, force: true });
          this.logManager.addLog('info', '已清理临时解压目录', 'CoreUpdateService');
        }
      } catch (err) {
        // 忽略清理错误
        this.logManager.addLog('warn', `清理临时解压目录失败: ${err}`, 'CoreUpdateService');
      }

      // 7. 重启代理（之前在运行才重启）。照 applyStagedNow：configProvider() 拿当前 config → proxyManager.start。
      //    早期此处是空壳占位（只打日志不启动），导致手动「检查更新→更新」换核后代理永不自动拉起 → 断网（P0-1）。
      if (wasRunning && this.proxyManager) {
        this.logManager.addLog('info', '正在重启代理服务...', 'CoreUpdateService');
        const cfg = this.configProvider ? await this.configProvider() : null;
        if (cfg) {
          await this.proxyManager.start(cfg);
        } else {
          this.logManager.addLog(
            'warn',
            '无法获取配置，代理未自动重启，请在主界面手动连接',
            'CoreUpdateService'
          );
        }
      }

      // 用户主动「检查更新 → 更新」换了版本：版本选择里的旧固定随之作废。
      if (this.dropPin('已通过「检查更新」更新内核')) this.emitAutoStatus();
      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logManager.addLog('error', `更新核心失败: ${msg}`, 'CoreUpdateService');

      // 尝试恢复备份（仅当本次确已备份；预检阶段失败时尚无新备份，避免误恢复陈旧 .bak 致降级）
      if (backupMade) await this.restoreBackup();

      throw error;
    } finally {
      this.isUpdating = false;
      this.coreOps--;
      this.afterCoreOpReleased();
    }
  }

  // === 版本选择（含预发布）：列表 / 按 tag 安装 / 安装进度 ===
  //
  // 与「检查更新 → 更新」（checkUpdate / updateCore，只认正式版、受兼容带约束）并存：用户显式挑选的任意 ≥ 随包版本的
  // 官方 release 都可装（含跨带、预发布、降级到随包以上的旧版）。安全不变量（任何一条被改坏都可能「静默装上不是官方
  // 发布的可执行文件」或「装完代理起不来」）：
  //  1. 渲染端只给 tag（+ force / pin 两个布尔）；release / 资产 / 摘要由主进程按 tag 现取（GET /releases/tags/{tag}），
  //     资产按精确名挑（绝不挑 -glibc / -musl / -legacy），下载 URL 必须恰为官方 release 地址；
  //  2. 摘要只认 API asset.digest（上游无 .dgst 兜底）→ 缺席即 NO_HASH 拒装；下载即使回落镜像，字节也要过这个摘要，
  //     落盘后再独立复核一次；
  //  3. 低于随包版本拒装（decideCoreOverride 会在下次连接 / 启动时把它刷回随包核）；
  //  4. 预检：解出的 `sing-box version` 必须恰为所选版本且是官方构建形态；`sing-box check` 当前配置失败 → 标记问题版本、
  //     无 force 越过；新核未编入 gVisor 而 TUN 栈（含 Auto）解析为 gvisor / mixed → GVISOR_MISSING（`check` 查不出，
  //     运行期才 FATAL）；
  //  5. 换核复用 installCoreFromDir（备份 → 落位 → 首启验证闩），由 ProxyManager 换核门控包住；代理在跑则停 → 换 → 起，
  //     起不来 → 撤验证闩、门控内恢复备份、标记问题版本、固定恢复到换核前、以原核再起（START_FAILED + rolledBack）；
  //     起不来但原因与内核无关（TUN 地址冲突 / 取消授权 / 提权引导取消 / 端口被占）→ 新核留用、不回滚不标记（START_BLOCKED）；
  //     期间用户手动停止 / 连接 / 退出 → 让位（新核留用，不回滚、不再起代理）；
  //  6. 与「检查更新 / 自动更新 / 回滚 / 手动替换 / 立即应用 / 恢复随包」及 Xray 版本切换互斥：入口同步 check+set
  //     （isUpdating + coreOps），其它公开入口经 withCoreOp 同样互斥。

  /**
   * SagerNet/sing-box 的 release 列表（剔除草稿 / 低于随包版本 / 无本平台精确资产者，新→旧）。缓存 10 分钟，force 绕过；
   * 并发调用合并为一次请求。失败抛 Error（code：RATE_LIMITED / NETWORK，经 IPC ApiResponse.code 透传到渲染端）。
   * knownBad / currentVersion 每次现算（不进缓存）：前者随预检 / 首启结果变化，后者读 ProxyManager 版本缓存（命中即不 spawn 内核）。
   *
   * 分页取（RELEASE_PAGING.singboxList：每页 10 个、最多 10 页）：sing-box 每个 release 带 168 个资产，4.6.0 的
   * per_page=100 一次 27–34 MB，超过 fetchGithubJson 的 16 MiB 上限 → 必失败（被报成「无法连接 GitHub」）。某页已不含
   * 任何 ≥ 随包版本的 release 即停（更早的只会更旧，列表反正剔除）。第 1 页失败照旧抛错；第 2 页起失败 → 用已取到的
   * 部分（记 warn；并入已有列表，不使其变短），只缓存 SINGBOX_LIST_PARTIAL_TTL_MS，下次打开即重取。
   */
  async listReleases(opts: { force?: boolean } = {}): Promise<SingboxReleaseList> {
    const cache = this.releaseListCache;
    const ttl = cache?.partial ? SINGBOX_LIST_PARTIAL_TTL_MS : SINGBOX_LIST_TTL_MS;
    if (!opts.force && cache && this.now() - cache.fetchedAt < ttl) {
      return this.toReleaseList(cache);
    }
    if (!this.releaseListInflight) {
      this.releaseListInflight = (async () => {
        try {
          const bundled = coreManifest.bundledCoreVersion;
          const { releases, complete, pages, error } =
            await this.coreDownloader.fetchGithubReleasePages(`${SINGBOX_API}/releases`, {
              ...RELEASE_PAGING.singboxList,
              shouldContinue: (page) =>
                page.some((r) => {
                  const v = singboxTagVersion((r as { tag_name?: unknown } | null)?.tag_name);
                  return !!v && compareSemver(v, bundled) >= 0;
                }),
            });
          if (!complete) {
            this.logManager.addLog(
              'warn',
              `sing-box 版本列表只取到前 ${pages} 页（后续页失败，${SINGBOX_LIST_PARTIAL_TTL_MS / 1000}s 后重取）: ${errMsg(error)}`,
              'CoreUpdateService'
            );
          }
          let listed = listableSingboxReleases(releases, this.platform, this.arch, bundled);
          const prev = this.releaseListCache;
          if (!complete && prev) {
            // 残缺结果不得把已有列表变短：以新取到的页为准，补上旧列表里其余版本（下次完整取到时整体替换）。
            const fresh = new Set(listed.map((r) => r.version));
            listed = [...listed, ...prev.releases.filter((r) => !fresh.has(r.version))].sort(
              (a, b) => compareSemver(b.version, a.version)
            );
          }
          const entry: SingboxListCacheEntry = {
            releases: listed,
            fetchedAt: this.now(),
            partial: !complete,
          };
          this.releaseListCache = entry;
          return entry;
        } catch (e) {
          const code =
            (e as { code?: unknown })?.code === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'NETWORK';
          this.logManager.addLog(
            'warn',
            `获取 sing-box 版本列表失败（${code}）: ${errMsg(e)}`,
            'CoreUpdateService'
          );
          throw Object.assign(new Error(errMsg(e)), { code });
        } finally {
          this.releaseListInflight = null;
        }
      })();
    }
    return this.toReleaseList(await this.releaseListInflight);
  }

  private async toReleaseList(entry: SingboxListCacheEntry): Promise<SingboxReleaseList> {
    const currentVersion = await this.getCurrentVersion(false).catch(() => '未知');
    return {
      releases: entry.releases.map((r) => ({ ...r, knownBad: this.isKnownBad(r.version) })),
      fetchedAt: entry.fetchedAt,
      bundledVersion: coreManifest.bundledCoreVersion,
      currentVersion,
    };
  }

  /** 进行中的安装 / 恢复随包（null = 空闲）。 */
  getInstallState(): SingboxInstallState {
    return { installing: this.installProgress ? { ...this.installProgress } : null };
  }

  private emitInstallProgress(): void {
    this.lastInstallProgressEmit = this.now();
    try {
      this.eventSender?.(
        IPC_CHANNELS.EVENT_CORE_INSTALL_PROGRESS,
        this.installProgress ? { ...this.installProgress } : null
      );
    } catch {
      /* 推送失败（窗口已关）不影响安装 */
    }
  }

  /** 阶段切换 / 结束（null）：立即推送（不节流）。 */
  private setInstallProgress(p: SingboxInstallProgress | null): void {
    this.installProgress = p;
    this.emitInstallProgress();
  }

  /**
   * 恢复随包进行中（installProgress.kind === 'reset'）时推进其阶段——replaceManualCore 是 reset 的落位腿，在预检 / 换核 /
   * 重启处调用；普通手动替换时 installProgress 为空（或属在线安装），此处 no-op。
   */
  private advanceResetPhase(phase: SingboxInstallPhase): void {
    const p = this.installProgress;
    if (p?.kind === 'reset' && p.phase !== phase) this.setInstallProgress({ ...p, phase });
  }

  /**
   * 取消固定版本（恢复自动更新）：清持久位 + 清 lastCheckAt 并推状态。固定只由 installTag(pin:true) 写入；
   * 固定期间自动轮次只记 lastCheckAt 不真正检查，若不清它，取消固定后要再等满 24h 才恢复检查——清掉后下个 6h 巡检
   * （或开关变更触发的 kick）即恢复。无固定 → no-op（不推事件）。
   */
  async clearPin(): Promise<void> {
    if (!this.dropPin('用户取消固定，恢复自动更新')) return;
    this.saveAutoState({ lastCheckAt: undefined });
    this.emitAutoStatus();
  }

  // ── 固定版本（pin）──────────────────────────────────────────────────────────────────────────────
  // 语义：用户在版本选择里装了某版本并勾「固定」→ 当前内核仍是该版本时，自动更新暂停（runAutoUpdateCycle 不检查不下载、
  // tryApplyStaged 的自动触发作废暂存核）；「立即应用」/「检查更新 → 更新」这类用户显式动作不受其约束。
  // 版本被其它途径改变即作废：回滚（含首启失败自动回滚）/ 手动替换 / 恢复随包 / 检查更新 / 立即应用 显式清除；
  // App 升级后启动对齐刷回随包核等未经本服务的改变，由 activePin 发现「当前版本 ≠ 固定版本」时惰性清除。

  /** 持久位里形状合法的固定版本（缺失 / 畸形 → null）。 */
  private storedPin(): SingboxPin | null {
    const p = this.loadAutoState().pinned as Partial<SingboxPin> | undefined;
    if (!p || typeof p !== 'object') return null;
    if (typeof p.version !== 'string' || !p.version || typeof p.tag !== 'string') return null;
    return {
      version: p.version,
      tag: p.tag,
      prerelease: p.prerelease === true,
      pinnedAt: typeof p.pinnedAt === 'string' ? p.pinnedAt : '',
    };
  }

  /**
   * 生效中的固定版本：仅当当前内核（可比较形）仍是固定的那个版本时有效，否则视为陈旧——clearStale 时清除并推状态，
   * 否则只是不认（用于读缓存版本的快照：缓存可能滞后于刚完成的换核，不据此做破坏性清除）。
   * current 未知（无 ProxyManager → '未知' / 空）→ 无从判断，按固定生效处理（宁可多停一轮自动更新，不误清用户的选择）。
   *
   * 清除前先用诚实探测复核：ProxyManager.getCoreVersion 探测失败时回落随包版本（不返回 '' / '未知'），一次瞬时的
   * `sing-box version` 失败与「版本被刷回随包」分不开，上面的「未知按生效」接不住。getCoreVersionLine(true) 失败返 ''、
   * 不回落、不吃 B5 指纹缓存——探测失败 → 按未知保留固定；读到的仍是固定版本 → 照常有效。只在「即将清除」时多 spawn
   * 这一次，热路径（版本一致 / 不清除的快照）不变。
   */
  private async activePin(current: string, clearStale = true): Promise<SingboxPin | null> {
    const raw = this.loadAutoState().pinned;
    if (!raw) return null;
    const pin = this.storedPin();
    if (pin && (!current || current === '未知')) return pin;
    if (pin && comparableCoreVersion(current) === comparableCoreVersion(pin.version)) return pin;
    if (!clearStale) return null;
    let actual = current;
    if (pin) {
      let line = '';
      try {
        line = (await this.proxyManager?.getCoreVersionLine(true)) ?? '';
      } catch {
        line = '';
      }
      const probed = extractVersionToken(line);
      if (!/^\d/.test(probed)) {
        this.logManager.addLog(
          'warn',
          `无法确认当前内核版本（版本探测失败），保留固定的 ${pin.version}`,
          'CoreUpdateService'
        );
        return pin;
      }
      if (comparableCoreVersion(probed) === comparableCoreVersion(pin.version)) return pin;
      actual = probed;
    }
    this.saveAutoState({ pinned: undefined });
    this.logManager.addLog(
      'info',
      pin
        ? `当前内核 ${actual} 已不是固定的 ${pin.version}（版本已被其它途径改变），固定失效，恢复自动更新`
        : '固定版本记录已损坏，已清除',
      'CoreUpdateService'
    );
    this.emitAutoStatus();
    return null;
  }

  /** 清固定（版本被其它途径改变 / 用户取消）。返回是否真的清了（调用方据此决定是否推状态，免空推事件）。 */
  private dropPin(why: string): boolean {
    if (!this.loadAutoState().pinned) return false;
    this.saveAutoState({ pinned: undefined });
    this.logManager.addLog('info', `已取消固定 sing-box 版本（${why}）`, 'CoreUpdateService');
    return true;
  }

  /**
   * 按 tag 在线安装并切换到该 sing-box 版本（安全不变量见本节头注）。
   * @param args.tag   所选 tag（`v1.14.3` / `1.15.0-alpha.12`；其它形状 → INVALID_TAG）
   * @param args.force 仅用于「当前是第三方内核」的确认：true = 用户已确认覆盖（fork 由 installCoreFromDir 留作 .bak，
   *                   可回滚找回）。不越过任何完整性 / 预检闸。
   * @param args.pin   true = 安装成功后固定此版本（自动更新暂停）；false = 清除旧固定。
   * 预期内的失败一律以 `{ ok:false, code, detail }` 返回（不抛），便于渲染端按 code 出文案。
   */
  async installTag(
    args: { tag?: unknown; force?: unknown; pin?: unknown } = {}
  ): Promise<SingboxInstallResult> {
    // a) 同步临界区：check+set 在第一个 await 之前完成（修 updateCore 式 TOCTOU：两次调用 / 与自动轮次并发双换核）。
    //    coreOps>0 = 回滚 / 手动替换 / 立即应用在飞（它们不持 isUpdating）——同样不并发换核。
    if (this.isUpdating || this.coreOps > 0) {
      return this.installFailure(
        new SingboxInstallError('BUSY', '内核更新正在进行中，请稍后再试'),
        'sing-box 安装未开始'
      );
    }
    if (this.xrayBusy()) {
      return this.installFailure(
        new SingboxInstallError('XRAY_BUSY', XRAY_BUSY_MSG),
        'sing-box 安装未开始'
      );
    }
    if (this.proxyManager?.isCoreSwapInProgress()) {
      return this.installFailure(
        new SingboxInstallError('BUSY', '内核正在更新，请稍后再试'),
        'sing-box 安装未开始'
      );
    }
    this.isUpdating = true;
    this.coreOps++;
    let tempPath: string | null = null;
    let extractDir: string | null = null;
    try {
      // b) 守卫（不打网络）
      const version = singboxTagVersion(args.tag);
      if (!version) {
        throw new SingboxInstallError('INVALID_TAG', `非法的 sing-box 版本号: ${String(args.tag)}`);
      }
      const tag = `v${version}`;
      const bundled = coreManifest.bundledCoreVersion;
      if (this.proxyManager?.isLifecycleBusy()) {
        throw new SingboxInstallError('PROXY_BUSY', '代理正在启动/停止，请稍后再试');
      }
      if (compareSemver(version, bundled) < 0) {
        throw new SingboxInstallError(
          'BELOW_MINIMUM',
          `sing-box ${version} 低于随包版本 ${bundled}（会在下次连接时被刷回随包内核）`
        );
      }
      // macOS 无 install-core 能力的 helper → 落位目标是 .app 内的随包核：破坏 App 签名、且此后「恢复随包」无从恢复。
      if (this.platform === 'darwin' && !(await this.helperCanInstallCore())) {
        throw new SingboxInstallError(
          'HELPER_REQUIRED',
          'macOS 在线安装内核需要先安装（或升级）提权助手（否则只能改写 App 内的随包内核）'
        );
      }
      const replacingFork = (await this.getCoreBuild(true)) === 'fork';
      if (replacingFork && args.force !== true) {
        throw new SingboxInstallError(
          'FORK_CONFIRM_REQUIRED',
          '当前为第三方（非官方）内核：确认后才会覆盖（原内核保留为备份，可回滚找回）'
        );
      }
      this.setInstallProgress({ kind: 'install', tag, phase: 'downloading' });

      // c) 按 tag 现取 release（不信任渲染端给的任何 URL / 摘要）
      const raw = await this.fetchSingboxReleaseByTag(tag);
      const rel = normalizeSingboxRelease(raw, this.platform, this.arch, bundled);
      if (!rel || rel.tag !== tag) {
        throw new SingboxInstallError('NOT_FOUND', `GitHub 返回的 release 与所选 ${tag} 不符`);
      }
      if (rel.draft) throw new SingboxInstallError('DRAFT', `sing-box ${tag} 是草稿 release`);
      const assets: unknown[] = Array.isArray((raw as { assets?: unknown }).assets)
        ? (raw as { assets: unknown[] }).assets
        : [];
      const assetName = rel.assetName;
      const asset = assetName
        ? assets.find((a) => !!a && (a as { name?: unknown }).name === assetName)
        : undefined;
      if (!assetName || !asset) {
        throw new SingboxInstallError(
          'NO_ASSET',
          `sing-box ${tag} 没有适用于本平台的官方构建（${assetName ?? `${this.platform}-${this.arch}`}）`
        );
      }
      const sha256 = normalizeAssetDigest(asset);
      if (!sha256) {
        throw new SingboxInstallError(
          'NO_HASH',
          `GitHub 未提供 ${assetName} 的 sha256 摘要，已拒绝安装未经校验的内核`
        );
      }
      const url = `${SINGBOX_DOWNLOAD}/${tag}/${assetName}`;
      if ((asset as { browser_download_url?: unknown }).browser_download_url !== url) {
        throw new SingboxInstallError(
          'NO_ASSET',
          `${assetName} 的下载地址不是 SagerNet/sing-box 官方 release 地址，已拒绝`
        );
      }

      // d) 下载（失败回落镜像时字节仍过摘要）→ 独立复核摘要 → 解压
      tempPath = await this.downloadInstallArchive(url, sha256, tag);
      this.setInstallProgress({ kind: 'install', tag, phase: 'verifying' });
      const actual = await sha256OfFile(tempPath).catch(() => null);
      if (actual !== sha256) {
        throw new SingboxInstallError(
          'HASH_MISMATCH',
          `压缩包 sha256 不符：期望 ${sha256}，实得 ${actual ?? '无法读取'}`
        );
      }
      this.setInstallProgress({ kind: 'install', tag, phase: 'extracting' });
      let corePath: string;
      try {
        const extracted = await this.coreDownloader.extractCore(tempPath);
        corePath = extracted.corePath;
        extractDir = extracted.extractDir;
      } catch (e) {
        throw new SingboxInstallError('EXTRACT_FAILED', errMsg(e));
      }

      // e) 预检：版本 = 所选、官方构建、`check` 当前配置、gVisor 兼容
      this.setInstallProgress({ kind: 'install', tag, phase: 'testing' });
      const preflight = await this.preflightValidate(corePath);
      if (!preflight.version) {
        // `<new> version` 都跑不起来（架构不符 / 文件损坏 / 临时目录挂了 noexec）：配置根本没检查，也说明不了版本本身
        // 有问题 → 不标记问题版本，与「check 拒绝当前配置」的 PREFLIGHT_FAILED 分开报。
        throw new SingboxInstallError(
          'EXEC_FAILED',
          preflight.reason ?? '新核心无法执行（架构不符或文件损坏）'
        );
      }
      if (preflight.version !== version) {
        throw new SingboxInstallError(
          'VERSION_MISMATCH',
          `解出的内核报告版本 ${preflight.version}，与所选 ${version} 不符`
        );
      }
      if (classifyCoreBuild(preflight.versionLine) !== 'official') {
        throw new SingboxInstallError(
          'NOT_OFFICIAL',
          `解出的内核不是官方构建形态：${preflight.versionLine}`
        );
      }
      if (!preflight.ok) {
        // 预检用的配置就是按目标版本生成的现役配置：check 不过 = 换上去必起不来 → 无 force 越过；标记供自动更新跳过。
        this.markKnownBad(version);
        throw new SingboxInstallError(
          'PREFLIGHT_FAILED',
          clipTail(preflight.detail || preflight.reason || '新核心无法解析当前配置')
        );
      }
      await this.assertGvisorCompatible(preflight.buildTags, version);

      // f) + g) 切换并（代理原先在跑则）重启
      const pinned = args.pin === true;
      const res = await this.swapInstalledCore({
        tag,
        version,
        prerelease: rel.prerelease,
        sourceDir: path.dirname(corePath),
        pinned,
        retainBackup: replacingFork,
      });
      if (!res.ok) return res;
      this.logManager.addLog(
        'info',
        `sing-box 已切换到 ${tag}${rel.prerelease ? '（预发布）' : ''}${pinned ? '（已固定）' : ''}${res.restarted ? '，代理已重启' : ''}`,
        'CoreUpdateService'
      );
      return {
        ok: true,
        version,
        tag,
        prerelease: rel.prerelease,
        restarted: res.restarted,
        pinned,
      };
    } catch (e) {
      return this.installFailure(e, 'sing-box 安装失败');
    } finally {
      // h) 善后：临时包 / 解压目录、释放锁、推结束事件
      if (tempPath) await fs.promises.unlink(tempPath).catch(() => {});
      if (extractDir) {
        await fs.promises.rm(extractDir, { recursive: true, force: true }).catch(() => {});
      }
      this.isUpdating = false;
      this.coreOps--;
      this.setInstallProgress(null);
      this.afterCoreOpReleased();
    }
  }

  private installFailure(
    e: unknown,
    what: string
  ): { ok: false; code: SingboxInstallErrorCode; detail: string } {
    if (e instanceof SingboxInstallError) {
      this.logManager.addLog('warn', `${what}（${e.code}）: ${e.message}`, 'CoreUpdateService');
      return { ok: false, code: e.code, detail: e.message };
    }
    this.logManager.addLog('error', `${what}: ${errMsg(e)}`, 'CoreUpdateService');
    return { ok: false, code: 'FAILED', detail: clipTail(errMsg(e)) };
  }

  /** helper 是否在位且支持 install-core（按 this.platform 判最低 proto；探测失败 → false）。 */
  private async helperCanInstallCore(): Promise<boolean> {
    if (!this.helperManager) return false;
    try {
      return this.helperSupportsInstallCore(await this.helperManager.getStatus(), this.platform);
    } catch {
      return false;
    }
  }

  private async fetchSingboxReleaseByTag(tag: string): Promise<unknown> {
    try {
      return await this.coreDownloader.fetchGithubJson(`${SINGBOX_API}/releases/tags/${tag}`);
    } catch (e) {
      const err = e as { code?: unknown; status?: unknown };
      if (err?.code === 'RATE_LIMITED') throw new SingboxInstallError('RATE_LIMITED', errMsg(e));
      if (err?.status === 404) {
        throw new SingboxInstallError('NOT_FOUND', `GitHub 上没有 sing-box ${tag}`);
      }
      throw new SingboxInstallError('NETWORK', errMsg(e));
    }
  }

  private async downloadInstallArchive(url: string, sha256: string, tag: string): Promise<string> {
    try {
      return await this.coreDownloader.downloadFile(url, false, sha256, {
        tempPrefix: 'sing-box-core-install',
        onProgress: (done, total) => {
          if (total <= 0) return;
          const percent = Math.min(100, Math.floor((done * 100) / total));
          this.installProgress = { kind: 'install', tag, phase: 'downloading', percent };
          if (
            percent === 100 ||
            this.now() - this.lastInstallProgressEmit >= INSTALL_PROGRESS_THROTTLE_MS
          ) {
            this.emitInstallProgress();
          }
        },
      });
    } catch (e) {
      const msg = errMsg(e);
      // 按下载器给的 code 判（直连摘要不符而镜像腿失败时 message 是…完整性失败本身，code 才是稳定信号）；文案匹配只作兜底。
      if (
        (e as { code?: unknown } | null)?.code === DOWNLOAD_HASH_MISMATCH ||
        /完整性校验失败/.test(msg)
      ) {
        throw new SingboxInstallError('HASH_MISMATCH', msg);
      }
      throw new SingboxInstallError('DOWNLOAD_FAILED', msg);
    }
  }

  /**
   * gVisor 守卫：新核的构建 tag 不含 with_gvisor（1.15.0-alpha.11 起的官方构建）而当前 TUN 栈解析为 gvisor / mixed
   * （Auto 在 macOS / Windows 即 gvisor）→ 拒装。`sing-box check` 对此照样通过，运行期才 FATAL「gVisor is not included」，
   * 用户若只用系统代理、过了首启验证窗口，备份就被清掉，之后开 TUN 才炸且无从自动回滚。
   * 版本输出里没有 Tags 行（buildTags=null，格式未知）→ 无从判断，不拦。读配置失败 → 按 Auto 判（失败安全）。
   */
  private async assertGvisorCompatible(
    buildTags: string[] | null | undefined,
    version: string
  ): Promise<void> {
    if (!Array.isArray(buildTags) || buildTags.includes('with_gvisor')) return;
    let stack: TunStack | undefined;
    try {
      const cfg = this.configProvider ? await this.configProvider() : null;
      stack = cfg?.tunConfig?.stack;
    } catch {
      /* 读不到配置 → stack 缺省 = Auto */
    }
    const effective = resolveTunStack(stack, this.platform);
    if (effective === 'gvisor' || effective === 'mixed') {
      const auto = !stack || stack === 'auto';
      throw new SingboxInstallError(
        'GVISOR_MISSING',
        `sing-box ${version} 未编入 gVisor（构建无 with_gvisor），而当前 TUN 网络栈为 ${effective}${auto ? '（Auto）' : ''}，` +
          'TUN 模式将无法启动。请先在「设置 → 网络」把网络栈改为 System 再安装此版本'
      );
    }
  }

  /**
   * 换核 + （原先在跑则）重启代理；失败回滚。决策见本节头注 5。
   * 门控序列（owner='singbox'）：成功 [true,false]；重启失败回滚 [true,false,true,false]（再起代理时门控已清，否则会被
   * 自己的闸拒绝）。
   */
  private async swapInstalledCore(o: {
    tag: string;
    version: string;
    prerelease: boolean;
    sourceDir: string;
    pinned: boolean;
    /** 被替换的是第三方内核：新核判稳后保留其 .bak（见 retainBackupOnStable）。 */
    retainBackup?: boolean;
  }): Promise<
    | { ok: true; restarted: boolean }
    | { ok: false; code: SingboxInstallErrorCode; detail?: string; rolledBack?: boolean }
  > {
    const pm = this.proxyManager;
    // 下载 / 预检期间用户可能刚点了连接 / 停止 → 复核（PROXY_BUSY：此刻什么都还没动）
    if (pm?.isLifecycleBusy()) {
      throw new SingboxInstallError('PROXY_BUSY', '代理正在启动/停止，请稍后再试');
    }
    // 基线（与 getStatus 同一同步段）：此后除本流程自己那一次 stop / start 外的请求 = 用户介入（停止 / 连接 / 托盘 / 退出）。
    const baseline = pm?.getLifecycleRequestCounts() ?? null;
    const wasRunning = !!pm && pm.getStatus().running;
    let cfg: UserConfig | null = null;
    if (pm && wasRunning) {
      cfg = this.configProvider ? await this.configProvider().catch(() => null) : null;
      if (!cfg) throw new SingboxInstallError('FAILED', '无法读取当前配置，未切换（代理保持运行）');
    }
    // 互斥复核与持门控同一同步段（clearStaged 同步）：防他方（如 Xray）在下载期间占了换核门控。
    if (pm?.isCoreSwapInProgress()) {
      throw new SingboxInstallError('BUSY', '内核正在更新，请稍后再试');
    }
    // 换核前的固定：起不来回滚到原核时连同它的固定一起恢复（这次失败的尝试不该替用户撤销对原版本的固定）。
    const priorPin = this.storedPin();
    // 用户显式选了版本：作废暂存的自动更新核（否则下次停代理 / 启动时被它覆盖回去）。此处刻意**不**推自动更新状态：
    // 设置卡收到状态事件会重拉 getVersionInfo，后者执行 `<.bak> version`，而下方 installCoreFromDir 正要覆盖写 .bak
    // （执行中的文件被写 → ETXTBSY，安装失败）。成功路径在换核后推；失败路径由结束时的进度 null 事件让卡片全量刷新。
    this.clearStaged();
    this.setInstallProgress({ kind: 'install', tag: o.tag, phase: 'switching' });

    let backupMade = false;
    let swapError: unknown = null;
    pm?.setCoreSwapInProgress(true);
    try {
      if (pm && wasRunning) {
        this.logManager.addLog('info', '正在停止代理服务以切换内核...', 'CoreUpdateService');
        await pm.stop();
        await new Promise((resolve) => setTimeout(resolve, this.swapSettleMs)); // 等进程完全退出
      }
      await this.installCoreFromDir(o.sourceDir, o.version, () => {
        backupMade = true;
      });
      // installCoreFromDir 末尾 arm 时已复位；在其后置位，只作用于本轮验证。
      this.retainBackupOnStable = o.retainBackup === true;
    } catch (e) {
      swapError = e;
      // 落位中途失败（已备份）→ 门控内恢复原核（installCoreFromDir 在最后一步才 arm 验证闩，失败路径无需撤闩）
      if (backupMade) await this.restoreBackup();
    } finally {
      pm?.setCoreSwapInProgress(false);
    }
    // 换核窗口内（含本流程 stop 之前的 await）用户停止 / 退出过 → 不再起代理。窗口内被门控拒绝的手动连接不算：
    // 它没起来，恰该由下方重启兑现（最后一次是 start → 照常重启）。
    const stoppedByUser =
      !!pm && !!baseline && this.userStoppedSince(pm, baseline, wasRunning ? 1 : 0);

    if (swapError) {
      if (pm && cfg && !stoppedByUser) {
        const againErr = await this.startProxyForInstall(pm, cfg);
        if (againErr) {
          this.logManager.addLog(
            'error',
            `换核失败后代理未能重新启动: ${againErr.msg}`,
            'CoreUpdateService'
          );
        }
      } else {
        await pm?.refreshCoreVersionAfterExternalReseed().catch(() => {});
      }
      throw new SingboxInstallError('FAILED', `写入新内核失败：${errMsg(swapError)}`);
    }

    // 固定：pin=true 记下此版本（自动更新暂停）；否则清掉旧固定（用户已改选其它版本，旧固定已无意义）。
    this.saveAutoState({
      pinned: o.pinned
        ? {
            version: o.version,
            tag: o.tag,
            prerelease: o.prerelease,
            pinnedAt: new Date(this.now()).toISOString(),
          }
        : undefined,
    });
    this.emitAutoStatus();

    if (!pm || !cfg || stoppedByUser) {
      // 不重启：ProxyManager 缓存的内核路径 / 版本可能陈旧（首次落位到新槽位时路径本身就变了）→ 立即重解析。
      if (stoppedByUser) {
        this.logManager.addLog(
          'info',
          `sing-box 已切换到 ${o.tag}；切换期间代理被手动停止，不再自动重启`,
          'CoreUpdateService'
        );
      }
      await pm?.refreshCoreVersionAfterExternalReseed().catch(() => {});
      return { ok: true, restarted: false };
    }

    this.setInstallProgress({ kind: 'install', tag: o.tag, phase: 'restarting' });
    // 新核的 'started' → index.ts recordSuccessfulVersion 会把 verifiedCeiling 棘轮到新版本带；下方回滚时撤销（同
    // settleStateAfterRollback 的「回滚 = 该带验证失败」）。
    const ceilingBeforeStart = this.loadAutoState().verifiedCeiling;
    const beforeStart = pm.getLifecycleRequestCounts();
    let startErr = await this.startProxyForInstall(pm, cfg);
    if (this.takenOverSince(pm, beforeStart)) {
      // 重启期间用户停止 / 连接 / 退出：代理此刻归用户操作所有。回滚要先 stop——会杀掉用户刚发起的连接，
      // 或在退出拆除后再起 sing-box；判不了成败也不该替用户做主 → 新核留用（首启验证闩仍在，坏核由其兜底）。
      this.logManager.addLog(
        'info',
        `sing-box 已切换到 ${o.tag}；重启代理期间用户已停止或接管代理，未回滚、不再自动重启` +
          (startErr ? `（本次启动: ${startErr.msg}）` : ''),
        'CoreUpdateService'
      );
      // 最近一次是用户停止 / 退出：推迟中的回滚不再替用户把代理拉起来（首启验证闩仍在，下次启动的崩溃照常兜底）。
      if (pm.getLifecycleRequestCounts().last === 'stop') this.rollbackDeferred = false;
      return { ok: true, restarted: false };
    }
    if (!startErr && this.rollbackDeferred) {
      // start() 已返回，但新核在其收尾阶段（'started' 之后的系统代理 / DNS 设置）就崩了：'error' → 首启验证钩子因本流程
      // 持锁而推迟了回滚。不报成功，就地按起不来处理（下方回滚撤验证闩时一并作废那次推迟）。
      startErr = {
        msg: `sing-box ${o.tag} 启动后随即退出`,
        environmental: false,
        tunPersistent: false,
      };
    }
    if (!startErr) return { ok: true, restarted: true };

    // 本次启动中新核已报过错（回滚被推迟）→ 新核确实崩过，不按环境问题放过，走下方回滚。
    if (startErr.environmental && !this.rollbackDeferred) {
      // 起不来的原因与新内核无关（TUN 地址冲突 / 取消授权 / 提权引导取消 / 端口被占，见 isEnvironmentalStartError）：
      // 回滚无益（原核照样起不来），还会把健康的新版本误记为问题版本。新核留用、固定照写、不标记；首启验证闩保持
      // armed——之后真正的首启崩溃仍由 autoRollbackIfPendingUpdate 兜底（它对 TUN_INIT_PERSISTENT 同样不回滚）。
      this.logManager.addLog(
        'warn',
        `sing-box 已切换到 ${o.tag}，但代理未能启动（与内核版本无关，未回滚）: ${startErr.msg}`,
        'CoreUpdateService'
      );
      await pm.refreshCoreVersionAfterExternalReseed().catch(() => {});
      return {
        ok: false,
        code: 'START_BLOCKED',
        detail: clipTail(startErr.msg),
        rolledBack: false,
      };
    }

    // 起不来：照 replaceManualCore 的 catch——撤验证闩（防原核首启被当新核记录/观察）→ 门控内恢复备份 → 标记问题版本 →
    // 固定回到换核前（恢复成功才恢复原固定，否则清除）→ 以原核再起。
    this.logManager.addLog(
      'error',
      `切换到 sing-box ${o.tag} 后代理启动失败，回滚到原内核: ${startErr.msg}`,
      'CoreUpdateService'
    );
    this.disarmPendingValidation();
    let restored = false;
    // 判定与持门控同一同步段（无 await）：其后的手动连接被门控拒绝，不会被下方 stop 误杀。
    pm.setCoreSwapInProgress(true);
    const beforeRollback = pm.getLifecycleRequestCounts();
    try {
      await pm.stop().catch(() => {});
      restored = backupMade && (await this.restoreBackup());
    } finally {
      pm.setCoreSwapInProgress(false);
    }
    // 原核回来了 → 它原先的固定一并回来（pin:false 的这次尝试在换核后清掉了它）、兼容带上限回到起新核前（新核短暂
    // 'started' 时抬上去的作废）；恢复失败 → 现役核不明，清固定。
    this.saveAutoState({
      pinned: restored && priorPin ? priorPin : undefined,
      ...(restored ? { verifiedCeiling: ceilingBeforeStart } : {}),
    });
    this.emitAutoStatus();
    // 回滚窗口内用户停止 / 退出 → 保持停止（不在退出拆除后再拉起 sing-box）
    const stoppedDuringRollback = this.userStoppedSince(pm, beforeRollback, 1);
    const againErr = stoppedDuringRollback ? null : await this.startProxyForInstall(pm, cfg);
    if (stoppedDuringRollback) await pm.refreshCoreVersionAfterExternalReseed().catch(() => {});
    // 标记问题版本放在原核再起之后：泛化的 TUN 持续性终态（无 TUN 层 FATAL）既可能是新核起核前就崩，也可能是真实的
    // wintun 故障。已恢复的原核也以同样终态失败 → 成因是环境，不把健康的新版本记为问题版本。
    if (!(restored && startErr.tunPersistent && againErr?.tunPersistent)) {
      this.markKnownBad(o.version);
    }
    if (!restored) this.logManager.addLog('error', '回滚原内核失败', 'CoreUpdateService');
    if (againErr) {
      this.logManager.addLog('error', `回滚后代理仍未能启动: ${againErr.msg}`, 'CoreUpdateService');
    }
    return {
      ok: false,
      code: 'START_FAILED',
      detail: clipTail(restored ? startErr.msg : `${startErr.msg}；回滚原内核失败`),
      rolledBack: restored,
    };
  }

  /**
   * 起代理：成功 null；失败返回文案 + 是否为与内核无关的环境 / 用户原因（start 失败抛错、不发 'error' 事件，故由调用方
   * 判定回滚）。
   */
  private async startProxyForInstall(
    pm: ProxyManager,
    cfg: UserConfig
  ): Promise<InstallStartFailure | null> {
    try {
      await pm.start(cfg);
      return null;
    } catch (e) {
      return {
        msg: errMsg(e),
        environmental: isEnvironmentalStartError(e),
        tunPersistent: e instanceof CoreStartTunPersistentError,
      };
    }
  }

  /**
   * 自 before 起、扣除本流程自己的 ownStops 次 stop 后仍有 stop 请求，且最近一次请求是 stop（用户停止 / 托盘 / 退出）。
   * 用于持门控的窗口：窗口内的手动 start 被门控拒绝、没起来，最后一次是 start 时仍应由本流程把代理拉回来。
   */
  private userStoppedSince(pm: ProxyManager, before: LifecycleCounts, ownStops: number): boolean {
    const now = pm.getLifecycleRequestCounts();
    return now.stops > before.stops + ownStops && now.last === 'stop';
  }

  /** 自 before 起，除本流程自己那一次 start 外是否还有 start/stop 请求（用户停止 / 连接 / 托盘 / 退出 / 重启）。 */
  private takenOverSince(pm: ProxyManager, before: LifecycleCounts): boolean {
    const now = pm.getLifecycleRequestCounts();
    return now.stops !== before.stops || now.starts !== before.starts + 1;
  }

  /**
   * 落位：备份旧核心 → 把 sourceDir 下的核心+配套文件复制到目标位置 → chmod → ensureCronetBeside →
   * macOS 签名 → naive 警告 → 置「待首启验证」闩+抑制自动重启+兜底解除 timer。
   * 从 updateCore 抽出（手动更新与自动 staged 落位共用），行为逐字节零变。
   * 不变量：**调用方须保证此刻代理进程不存在**（updateCore 已停代理、tryApplyStaged 仅在 !running 时进入）。
   * @param onBackupDone backupCurrentCore() 成功后立即回调（让调用方在同一时点置 backupMade，保留原失败恢复语义）。
   */
  /**
   * helper 是否支持 install-core（受保护/受管核目录持久化写入）——命令级能力门，取代旧的 `ready && !upgradeable`。
   * 为什么不能用 `!upgradeable`：upgradeable 的门槛是 helper 的 EXPECTED_PROTO（macOS=9），远高于 install-core 的
   * 真实契约。install-core 各平台起始 proto 不同（见 HelperManager.installCore / LinuxServiceHelper 注释）：
   *  - macOS：proto ≥ 5（v5 引入受保护目录持久化，proto<5 回 ERR unknown）；
   *  - Linux：proto ≥ 1（v1 起即支持，ready 已含此下限）。
   * 旧门 `ready && !upgradeable` 让 macOS proto 5-8 的旧 helper 用户被判「无 install-core」→ 内核更新走 bundle
   * 写入却仍跑受保护目录旧核，更新静默失效。故改按 ready + 平台最低 proto 判定。version 即 ping 返回的 proto 串。
   */
  private helperSupportsInstallCore(
    st: HelperStatus,
    platform: NodeJS.Platform = process.platform
  ): boolean {
    if (!st.ready) return false;
    const minProto = platform === 'darwin' ? 5 : 1;
    const proto = Number.parseInt(st.version ?? '', 10);
    // version 非数字串（异常 ping 应答/未来格式变体）→ NaN 比较恒 false 会把有能力 helper 误判无能力、
    // 静默走 bundle 分支复现本 bug；回退旧布尔语义（ready && !upgradeable）而非一票否决。
    if (Number.isNaN(proto)) return !st.upgradeable;
    return proto >= minProto;
  }

  private async installCoreFromDir(
    sourceDir: string,
    version: string | null,
    onBackupDone?: () => void
  ): Promise<void> {
    // B 块：macOS + helper v5 → 整个核心目录经 install-core 由 root 写入受保护目录（含 libcronet：先 ensureCronetBeside
    // 把配套放进 sourceDir，再整目录交 helper）。不经普通用户 fs.copy（受保护目录 root-only）。受保护目录回滚靠 B5。
    if ((process.platform === 'darwin' || process.platform === 'linux') && this.helperManager) {
      const st = await this.helperManager.getStatus();
      if (this.helperSupportsInstallCore(st)) {
        await this.backupCurrentCore(); // 备份现役(受保护/受管核可读)→userData，供首启失败回滚
        onBackupDone?.();
        await resourceManager.ensureCronetBeside(sourceDir);
        const res = await this.helperManager.installCore(sourceDir);
        if (!res.ok) throw new Error(`内核写入受保护目录失败：${res.error}`);
        this.armPendingValidation(version); // 待首启验证闩：首启 crash → autoRollback（经 helper，见 rollbackCore）
        return;
      }
    }

    // 4. 备份旧核心
    await this.backupCurrentCore();
    onBackupDone?.();

    // 5. 替换核心
    this.logManager.addLog('info', '正在替换核心文件...', 'CoreUpdateService');
    const targetPath = resourceManager.getSingBoxUpdateTargetPath();

    // 确保目标目录存在
    const targetDir = path.dirname(targetPath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // 复制新核心及配套文件到目标位置（只取文件，不递归目录）
    const files = fs
      .readdirSync(sourceDir)
      .filter((f) => fs.statSync(path.join(sourceDir, f)).isFile());

    if (process.platform === 'win32') {
      // Windows: 目标在 Program Files（UAC 保护），逐文件 elevated 覆盖；无简单原子 rename，保持原行为。
      for (const file of files) {
        this.logManager.addLog('info', `正在复制: ${file}`, 'CoreUpdateService');
        await this.copyFileElevatedWindows(path.join(sourceDir, file), path.join(targetDir, file));
      }
    } else {
      // M2：非 Windows 原子落位——先把全部文件复制到同目录临时名（.flowz-new），全部成功后逐个原子 rename
      // 就位。复制阶段任一失败（磁盘满等）→ 删临时文件、抛错，现役核心目录完全未动（杜绝「新核心 + 旧/坏
      // libcronet」半替换混搭——原逐文件直接覆盖在中途失败时会留下此混搭，而 restoreBackup 仅回滚主二进制救不回）。
      const stagedRenames: Array<{ tmp: string; dest: string }> = [];
      try {
        for (const file of files) {
          this.logManager.addLog('info', `正在复制: ${file}`, 'CoreUpdateService');
          const dest = path.join(targetDir, file);
          const tmp = `${dest}.flowz-new`;
          await this.copyFileWithRetry(path.join(sourceDir, file), tmp);
          stagedRenames.push({ tmp, dest });
        }
        // 全部复制成功 → 逐个原子 rename 就位（同目录 rename 为原子 syscall，不占新磁盘空间，几乎不失败）
        for (const { tmp, dest } of stagedRenames) {
          fs.renameSync(tmp, dest);
        }
      } catch (e) {
        for (const { tmp } of stagedRenames) {
          try {
            if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
          } catch {
            /* ignore */
          }
        }
        throw e;
      }
    }

    // 设置执行权限 (macOS/Linux)
    if (process.platform !== 'win32') {
      fs.chmodSync(targetPath, 0o755);
    }

    // 核心单独更新后，确保 NaiveProxy 库 libcronet 与新核心同目录（官方 sing-box 包不含 libcronet，
    // naive 仍依赖随 app 打包的那个；purego 从核心同目录加载）。
    await resourceManager.ensureCronetBeside(targetDir);

    // macOS: 清除下载隔离标记并重新 ad-hoc 签名
    // 原因: macOS Gatekeeper 对新放入的未公证二进制会拦截执行 (SIGKILL)
    // xattr -cr 清除 quarantine 标记, codesign --force -s - 重新 ad-hoc 签名使其被系统接受
    if (process.platform === 'darwin') {
      try {
        const { execSync } = require('child_process');
        execSync(`xattr -cr "${targetPath}"`, { stdio: 'pipe' });
        execSync(`codesign --force --deep -s - "${targetPath}"`, { stdio: 'pipe' });
        this.logManager.addLog('info', '已完成 macOS Gatekeeper 签名处理', 'CoreUpdateService');
      } catch (signError: any) {
        this.logManager.addLog(
          'warn',
          `macOS 签名处理失败 (可能需要手动运行 sudo codesign --force -s -): ${signError.message}`,
          'CoreUpdateService'
        );
      }
    }

    this.logManager.addLog('info', '核心文件替换成功', 'CoreUpdateService');

    // naive 依赖随 app 打包的 libcronet（匹配出厂核心的 cronet-go 版本）。单独更新核心——尤其跨版本——
    // 可能与打包库 ABI 漂移；该漂移在 dlopen 前不可见，sing-box check 预检无法发现。有 naive 节点则提示。
    if (this.proxyManager?.hasNaiveNodes()) {
      this.logManager.addLog(
        'warn',
        'naive 节点依赖随 app 打包的 libcronet；本次核心更新后如遇 naive 不可用，请回滚核心或等待 app 整体更新',
        'CoreUpdateService'
      );
    }

    // 标记"待首启验证"：稳定运行→删备份（稳定即弃）；首启失败→自动回滚（见 index 'error' 钩子）。
    this.armPendingValidation(version);
  }

  /** 置「待首启验证」闩 + 抑制自动重启 + 超时兜底。bundle 落位与 macOS install-core 落位共用，保证两条路径都有
   *  「首启 crash → autoRollback」保护网（install-core 分支原本早退跳过此闩）。 */
  private armPendingValidation(version: string | null): void {
    // 同时抑制 ProxyManager 自动重启——让新核心首次异常退出立即上报，而非在坏核心上空转重试。
    this.pendingUpdateVersion = version;
    this.pendingUpdateAt = Date.now();
    this.rollbackDeferred = false; // 新一轮验证：此前推迟的回滚（针对上一个待验证版本）作废
    this.retainBackupOnStable = false; // 需要保留备份的调用方（installTag 覆盖第三方核）在 arm 之后再置位
    this.proxyManager?.setAutoRestartSuppressed(true);
    // 兜底：到期仍未被 'started'/'error' 解决，则清待验证态并解除抑制（避免抑制闩永久挂起）。
    if (this.pendingFallbackTimer) clearTimeout(this.pendingFallbackTimer);
    this.pendingFallbackTimer = setTimeout(() => {
      this.pendingFallbackTimer = null;
      if (this.pendingUpdateVersion) {
        this.logManager.addLog(
          'info',
          '核心更新待验证窗口超时未见首启事件，解除自动重启抑制',
          'CoreUpdateService'
        );
        this.pendingUpdateVersion = null;
        this.proxyManager?.setAutoRestartSuppressed(false);
      }
    }, CoreUpdateService.PENDING_MAX_AGE_MS);
  }

  /** 撤销待首启验证闩（arm 后 start 同步失败 / 改以原核重启前调，避免原核首启被当作新版本观察/记录）。 */
  private disarmPendingValidation(): void {
    this.pendingUpdateVersion = null;
    this.rollbackDeferred = false; // 调用方已自行回滚 / 改以原核重启：推迟的自动回滚作废
    this.retainBackupOnStable = false;
    this.proxyManager?.setAutoRestartSuppressed(false);
    if (this.pendingFallbackTimer) {
      clearTimeout(this.pendingFallbackTimer);
      this.pendingFallbackTimer = null;
    }
  }

  /** B 块 macOS：把单个 sing-box 二进制 src 经 helper install-core 持久化写入受保护目录（连带打包的 libcronet）。
   *  调用方须先经 helperSupportsInstallCore(st) 确认 helper 支持 install-core。replaceManualCore / rollbackCore / restoreBackup 共用。 */
  private async installSingleCoreViaHelper(src: string): Promise<void> {
    if (!this.helperManager) throw new Error('helper 不可用');
    const tmpDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'flowz-core-'));
    try {
      fs.copyFileSync(src, path.join(tmpDir, 'sing-box'));
      fs.chmodSync(path.join(tmpDir, 'sing-box'), 0o755);
      await resourceManager.ensureCronetBeside(tmpDir);
      const res = await this.helperManager.installCore(tmpDir);
      if (!res.ok) throw new Error(`内核写入受保护目录失败：${res.error}`);
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  /** B 块 macOS：当前是否启用受保护目录持久化（helper v5 在位且 ready）。回滚/恢复据此决定经 helper 还是普通写。 */
  private async isProtectedCoreActive(): Promise<boolean> {
    if ((process.platform !== 'darwin' && process.platform !== 'linux') || !this.helperManager)
      return false;
    const st = await this.helperManager.getStatus();
    return this.helperSupportsInstallCore(st);
  }

  // === 内核自动更新（仅兼容版本带内）：持久状态 / staged 落位 / 周期检查 ===

  /** 读自动更新持久状态（委托 CoreUpdateStateStore；损坏/缺失→空对象，失败安全）。 */
  private loadAutoState(): CoreAutoUpdateState {
    return this.stateStore.loadAutoState();
  }

  /** 合并写入自动更新持久状态（委托 CoreUpdateStateStore；原子写 tmp+rename，崩溃一致性）。 */
  private saveAutoState(patch: Partial<CoreAutoUpdateState>): void {
    this.stateStore.saveAutoState(patch);
  }

  /**
   * macOS 孤儿受保护核（helper 已卸/坏、helper reseed 写不动 root 目录）启动期一次性 osascript-admin 兜底（用户已定
   * 「首启一次性弹」）：借鉴 app 更新，一次授权把随包核装进受保护核（root 属主、消除「root 跑用户可写二进制」、无 privesc）。
   * 一次性：startupReseedDeclinedVersion 记本随包版本已弹过（授权成功下次 decideCoreOverride 判 keep 不进 / 取消则本版本不再自动弹），
   * 防每启弹。由 startup-tasks 在 proxyManager.reseedBundledCoreOnStartup() 返回 needsMacElevatedReseed 时调。取消授权=正常、吞错。
   */
  async tryElevatedReseedProtectedCoreOnStartup(bundledVersion: string): Promise<void> {
    const pm = this.proxyManager;
    if (process.platform !== 'darwin' || !this.privilegeService || !pm) return;
    // 一次性 gate：本随包版本已弹过 → 跳，防每启弹。
    if (this.loadAutoState().startupReseedDeclinedVersion === bundledVersion) return;
    this.saveAutoState({ startupReseedDeclinedVersion: bundledVersion });
    const src = resourceManager.getBundledSingBoxPath();
    const dest = path.join(resourceManager.getProtectedCoreDir(), 'sing-box');
    const before = await pm.getCoreVersion(false).catch(() => 'unknown');
    this.logManager.addLog(
      'info',
      `macOS 无 helper：一次性授权安装随包核 ${bundledVersion} 到受保护目录...`,
      'CoreUpdateService'
    );
    try {
      await this.privilegeService.installCoreElevatedMac(src, dest);
    } catch (e) {
      // 用户取消授权 / 写失败 = 正常路径（非错误）：info 记录、延后（已记 declinedVersion 本版本不再自动弹）。
      this.logManager.addLog(
        'info',
        `随包核 elevated 安装未完成（${(e as Error)?.message ?? e}），延后；可在「设置·内核·重置到出厂」手动切回随包核`,
        'CoreUpdateService'
      );
      return;
    }
    // 写后 ProxyManager 重解析核路径 + 刷版本缓存；诚实校验（getCoreVersionLine 探测失败返 ''、不回落随包基线）。
    await pm.refreshCoreVersionAfterExternalReseed();
    const lineAfter = await pm.getCoreVersionLine(true);
    const { version, applied } = classifyReseedResult(lineAfter, before, bundledVersion);
    this.logManager.addLog(
      'info',
      applied
        ? `随包核已 elevated 安装至受保护目录: ${version}`
        : `随包核 elevated 安装后仍为 ${version}（期望 ≥ ${bundledVersion}）`,
      'CoreUpdateService'
    );
  }

  /** 清除 staged 暂存（落位成功/作废后调用）：删元数据 + 删暂存目录。 */
  private clearStaged(): void {
    const st = this.loadAutoState();
    const dir = st.staged?.dir;
    this.saveAutoState({ staged: undefined });
    if (dir) {
      try {
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      } catch (e) {
        // L3：删暂存目录失败不致命（下次 stageCore 会 rmSync 重建覆盖），但记一条便于排查残留磁盘垃圾。
        this.logManager.addLog('warn', `清除 staged 暂存目录失败: ${e}`, 'CoreUpdateService');
      }
    }
  }

  private getStagedDir(): string {
    return path.join(app.getPath('userData'), 'core-staged');
  }

  private emitAutoStatus(extra?: { crossBandLatest?: string | null }): void {
    if (!this.eventSender) return;
    try {
      const st = this.loadAutoState();
      // M3：事件 payload 不含 autoUpdateEnabled——其真值需 await configProvider（同步 emit 拿不到），旧实现发
      // 占位 false 会在渲染端覆盖 getAutoStatus 拉到的真值。真值仅由 getAutoStatus 快照提供（UI 另读 config）。
      const payload: Omit<CoreAutoStatus, 'autoUpdateEnabled'> = {
        lastCheckAt: st.lastCheckAt ?? null,
        staged: st.staged ? { version: st.staged.version, stagedAt: st.staged.stagedAt } : null,
        crossBandLatest:
          extra && 'crossBandLatest' in extra
            ? (extra.crossBandLatest ?? null)
            : (st.crossBandNotifiedVersion ?? null),
        // 同步 emit 拿不到当前版本 → 发持久位原值；各改版本路径都先显式清固定再推，陈旧位由 activePin 清后再推。
        pinned: this.storedPin(),
      };
      this.eventSender(IPC_CHANNELS.EVENT_CORE_AUTO_UPDATE_STATUS, payload);
    } catch {
      /* ignore */
    }
  }

  /** UI 拉取的内核自动更新状态快照。 */
  async getAutoStatus(): Promise<CoreAutoStatus> {
    const st = this.loadAutoState();
    let enabled = false;
    try {
      const cfg = this.configProvider ? await this.configProvider() : null;
      enabled = cfg?.autoUpdateCore === true;
    } catch {
      /* ignore */
    }
    // 固定只在当前内核仍是该版本时展示。读版本缓存（命中即不 spawn 内核：快照被设置页 / 调度频繁调用），缓存可能滞后于
    // 刚完成的换核，故只过滤不清除（clearStale=false）；真正的陈旧清除在读活二进制的调度路径 / getVersionInfo 里做。
    const pinned = st.pinned
      ? await this.activePin(await this.getCurrentVersion(false).catch(() => ''), false)
      : null;
    return {
      autoUpdateEnabled: enabled,
      lastCheckAt: st.lastCheckAt ?? null,
      staged: st.staged ? { version: st.staged.version, stagedAt: st.staged.stagedAt } : null,
      crossBandLatest: st.crossBandNotifiedVersion ?? null,
      pinned,
    };
  }

  /** 把解压目录（含核心+配套文件）复制到 userData/core-staged 暂存，写元数据。返回 staged 信息。 */
  private stageCore(sourceDir: string, version: string): StagedCoreInfo {
    const dir = this.getStagedDir();
    // 清掉旧暂存目录，避免不同版本文件残留混入
    try {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    fs.mkdirSync(dir, { recursive: true });
    for (const file of fs.readdirSync(sourceDir)) {
      const src = path.join(sourceDir, file);
      if (fs.statSync(src).isFile()) {
        fs.copyFileSync(src, path.join(dir, file));
      }
    }
    const staged: StagedCoreInfo = { version, dir, stagedAt: new Date().toISOString() };
    this.saveAutoState({ staged });
    this.logManager.addLog(
      'info',
      `新内核 ${version} 已下载预检通过，暂存待代理停止后落位`,
      'CoreUpdateService'
    );
    return staged;
  }

  /**
   * 内核自动更新一轮：检查→（带内）下载+预检+暂存/落位；跨带仅发事件不下载。
   * 唯一入口由 CoreUpdateScheduler.cycleIfDue 调用；isUpdating 防重入。
   * 不变量：自动路径恒强制 sameMajorMinor（跨 minor 绝不自动），不受 restrictCoreUpdateToCompatibleMinor 影响。
   */
  async runAutoUpdateCycle(): Promise<void> {
    // coreOps>0 = 回滚 / 手动替换 / 立即应用在飞（不持 isUpdating）：本轮让开，下个 tick 再来。
    if (this.isUpdating || this.coreOps > 0) return;
    // H1：入口同步持闸（与 isUpdating 检查间无 await，原子），覆盖 check→下载→解压→预检→暂存→落位全程，
    // 防与手动 updateCore 并发双换核（原仅末尾 tryApplyStaged 持闸，数十秒下载/暂存段 isUpdating=false 留并发
    // 窗口，两条链同写 core-staged/目标目录/*.bak 互相覆盖、备份取自半替换核心、回滚失真）。内部 tryApplyStaged
    // 传 lockHeld=true 复用本闸、不二次检查/置/复位。autoUpdateCore 关时短暂持闸即经 finally 复位，无害。
    this.isUpdating = true;
    try {
      const cfg = this.configProvider ? await this.configProvider() : null;
      if (cfg?.autoUpdateCore !== true) return;

      // 用户固定了当前版本 → 本轮不检查、不下载、不暂存（不打 GitHub）。记 lastCheckAt 让调度维持 24h 节奏（取消固定时
      // clearPin 清掉它 → 下个巡检即恢复）。先看持久位再读版本：没固定的用户不多一次版本探测。
      if (this.loadAutoState().pinned) {
        const pin = await this.activePin(await this.getCurrentVersion());
        if (pin) {
          this.saveAutoState({ lastCheckAt: Date.now() });
          this.logManager.addLog(
            'info',
            `已固定 sing-box ${pin.version}，跳过本轮自动更新`,
            'CoreUpdateService'
          );
          return;
        }
      }

      const check = await this.checkUpdate();
      // 仅成功检查才刷新 lastCheckAt：失败轮（network/API 限流等，check.error 有值）保留旧值，
      // 让 6h tick 在下个周期重试，而非把整 24h due 推迟（原无条件刷新致失败后停检一整天）。
      if (!check.error) {
        this.saveAutoState({ lastCheckAt: Date.now() });
      }
      const latest = check.latestVersion;

      const current = check.currentVersion;
      // M3：用户手动升级追上/越过曾提示的跨带版本后，清除残留跨带提示（否则只写不清，旧提示常驻 UI）。
      // current >= notified 或已同带（current 升到 notified 所在 minor）即视为已消化该跨带版本。
      {
        const st = this.loadAutoState();
        const notified = st.crossBandNotifiedVersion;
        if (
          notified &&
          current &&
          current !== '未知' &&
          (this.compareVersions(current, notified) >= 0 || sameMajorMinor(current, notified))
        ) {
          this.saveAutoState({ crossBandNotifiedVersion: undefined });
          this.logManager.addLog(
            'info',
            `当前内核 ${current} 已追上跨带提示版本 ${notified}，清除跨带提示`,
            'CoreUpdateService'
          );
          this.emitAutoStatus({ crossBandLatest: null });
        }
      }

      // 无更新 / 检查失败 / 无可用更新：本轮结束（check 内部已处理 known-bad/ceiling/asset）
      if (!latest) return;
      // 兼容带硬闸：自动路径仅在同 major.minor 内继续；跨带绝不下载/落位，仅发提示事件（每版本只提示一次）
      if (!sameMajorMinor(current, latest)) {
        const crossable = this.compareVersions(latest, current) > 0 && !this.isKnownBad(latest);
        const st = this.loadAutoState();
        if (crossable && st.crossBandNotifiedVersion !== latest) {
          this.saveAutoState({ crossBandNotifiedVersion: latest });
          this.logManager.addLog(
            'info',
            `检测到跨版本带新版 ${latest}（当前 ${current}），不自动更新，已提示用户手动处理`,
            'CoreUpdateService'
          );
          this.emitAutoStatus({ crossBandLatest: latest });
        }
        return;
      }

      // 带内：若已有相同版本 staged，直接尝试落位（避免重复下载）
      const staged = this.loadAutoState().staged;
      if (staged && staged.version === latest) {
        await this.tryApplyStaged('staged-same-version', true);
        return;
      }

      // check.hasUpdate=true 才有 downloadUrl；带内但 hasUpdate=false（已是最新）则无可下
      if (!check.hasUpdate || !check.downloadUrl) return;

      // 下载 → 解压 → 预检（全复用现有手动路径逻辑，零新增回滚代码）
      let tempPath: string | null = null;
      let extractDir: string | null = null;
      try {
        // 与手动路径同一道门：无摘要不装。这条腿是**自动**的（无人值守），降级校验的后果更严重。
        const sha256 = check.downloadSha256 ?? (await this.resolveAssetSha256(check.downloadUrl));
        if (!sha256) {
          this.logManager.addLog(
            'warn',
            '自动更新中止：无法获取内核资产的官方 sha256 摘要（拒绝安装未经校验的内核）',
            'CoreUpdateService'
          );
          return;
        }
        tempPath = await this.coreDownloader.downloadFile(check.downloadUrl, false, sha256);
        const extracted = await this.coreDownloader.extractCore(tempPath);
        extractDir = extracted.extractDir;
        const preflight = await this.preflightValidate(extracted.corePath);
        if (!preflight.ok) {
          if (preflight.version) this.markKnownBad(preflight.version);
          this.logManager.addLog(
            'warn',
            `自动更新预检失败，放弃 ${latest}：${preflight.reason}`,
            'CoreUpdateService'
          );
          return;
        }
        // 暂存（从解压目录复制到 core-staged，因临时目录随后清理）
        this.stageCore(path.dirname(extracted.corePath), preflight.version ?? latest);
        this.emitAutoStatus();
        // 下载后立即尝试落位（代理未运行→直接换；运行中→保持 staged，延到安全窗口）
        await this.tryApplyStaged('post-download', true);
      } finally {
        try {
          if (tempPath) fs.unlinkSync(tempPath);
        } catch {
          /* ignore */
        }
        try {
          if (extractDir && fs.existsSync(extractDir)) {
            fs.rmSync(extractDir, { recursive: true, force: true });
          }
        } catch {
          /* ignore */
        }
      }
    } finally {
      this.isUpdating = false;
      this.afterCoreOpReleased();
    }
  }

  /**
   * 尝试落位 staged 内核：**仅在代理进程不存在时真正换核**（不断流硬不变量）。
   * 运行中 → 保持 staged、发「待生效」事件、不动现役核心。无 staged / isUpdating → 直接返回 noop。
   *
   * 返回 StagedApplyResult，供 applyStagedNow / UI 区分反馈（修 M1：原 void 返回让调用方只能靠
   * 「staged 是否还在」二值推断，把 discarded/deferred/failed 一律误判，UI 误报「已应用」）。
   *
   * @param trigger 触发来源；非 'manual-apply' 的自动触发（startup / proxy-stopped / tick /
   *   post-download / staged-same-version）须经 autoUpdateCore 守门（修 M4：撤回同意后已暂存内核
   *   不应自动换核；保留 staged，用户重开开关或点「立即应用」即生效）。
   */
  async tryApplyStaged(trigger: string, lockHeld = false): Promise<StagedApplyResult> {
    // L1：入口同步置 applying 闸（与 isUpdating 检查间无 await），防并发 tryApplyStaged 双通过。
    // lockHeld=true（runAutoUpdateCycle 内调）→ 复用外层已持的 isUpdating 闸，不二次检查/置/复位（H1）。
    // 自动触发（启动 / 代理停止 / tick）还要让开不持 isUpdating 的回滚 / 手动替换（coreOps>0）——例如手动替换停了
    // 代理、写核加落位后预检超过 5s 时，「代理已停止」触发会与之并发换核。'manual-apply' 只由 applyStagedNow 在其自持
    // 的 coreOps 内调用，故它只看 isUpdating。
    if (!lockHeld && (this.isUpdating || (trigger !== 'manual-apply' && this.coreOps > 0))) {
      return 'noop';
    }
    if (!lockHeld) this.isUpdating = true;
    let heldOp = false;
    try {
      // 第三方（非官方）内核：作废任何暂存的官方核（不落位覆盖用户刻意安装的 fork）。
      // 覆盖「曾官方→自动 staged→用户手动换 fork」时序，杜绝 staged 静默回覆 fork。force 刷新版本行（守卫前无强制刷新）。
      if ((await this.getCoreBuild(true)) === 'fork') {
        if (!this.loadAutoState().staged) return 'noop'; // 无暂存可作废 → noop（保持返回契约：discarded=确有 staged 被清）
        this.logManager.addLog(
          'info',
          '当前为第三方内核，作废暂存的官方内核（不覆盖用户内核）',
          'CoreUpdateService'
        );
        this.clearStaged();
        this.emitAutoStatus();
        return 'discarded';
      }

      const staged = this.loadAutoState().staged;
      if (!staged) return 'noop';

      // 与 Xray 版本切换互斥（判定与持闸同一同步段）：Xray 正在换核 / 重启代理 → 保持 staged，待下个触发点再落位。
      if (this.xrayBusy()) {
        this.logManager.addLog(
          'info',
          `Xray 内核正在切换，内核 ${staged.version} 暂不落位（${trigger}）`,
          'CoreUpdateService'
        );
        this.emitAutoStatus();
        return 'deferred';
      }
      this.coreOps++;
      heldOp = true;

      // 用户固定了当前版本：自动触发一律作废暂存核（否则下次停代理 / 启动时被它覆盖掉用户选的版本）。用户点「立即应用」
      // （manual-apply）是显式意愿，照常落位（落位后固定随版本改变而清除，见下方 applied 分支）。
      if (trigger !== 'manual-apply' && this.loadAutoState().pinned) {
        const pin = await this.activePin(await this.getCurrentVersion());
        if (pin) {
          this.logManager.addLog(
            'info',
            `已固定 sing-box ${pin.version}，作废暂存的自动更新内核 ${staged.version}（${trigger}）`,
            'CoreUpdateService'
          );
          this.clearStaged();
          this.emitAutoStatus();
          return 'discarded';
        }
      }

      // M4：自动触发（非用户「立即应用」）须开关开启才落位；关则保持 staged、不动现役核心。
      if (trigger !== 'manual-apply') {
        let autoEnabled = false;
        try {
          const cfg = this.configProvider ? await this.configProvider() : null;
          autoEnabled = cfg?.autoUpdateCore === true;
        } catch {
          /* 读配置失败 → 失败安全：视作未开启，不自动落位 */
        }
        if (!autoEnabled) {
          this.logManager.addLog(
            'info',
            `自动更新已关闭，内核 ${staged.version} 保持暂存不自动落位（${trigger}）`,
            'CoreUpdateService'
          );
          this.emitAutoStatus();
          return 'deferred';
        }
      }

      // staged 已不再领先当前 / 已知坏：作废清理
      const current = await this.getCurrentVersion();
      if (this.compareVersions(staged.version, current) <= 0 || this.isKnownBad(staged.version)) {
        this.logManager.addLog(
          'info',
          `staged 内核 ${staged.version} 不再适用（当前 ${current}），清理暂存`,
          'CoreUpdateService'
        );
        this.clearStaged();
        this.emitAutoStatus();
        return 'discarded';
      }

      // 代理运行中 → 绝不落位（只下载+暂存，绝不静默断流）。发「待生效」事件供 UI 提示。
      if (this.proxyManager?.getStatus().running) {
        this.logManager.addLog(
          'info',
          `代理运行中，内核 ${staged.version} 暂不落位，待停止后生效（${trigger}）`,
          'CoreUpdateService'
        );
        this.emitAutoStatus();
        return 'deferred';
      }

      // 落位（代理未运行）：重预检（下载到落位间 config 可能变）→ installCoreFromDir
      const corePath = path.join(
        staged.dir,
        process.platform === 'win32' ? 'sing-box.exe' : 'sing-box'
      );
      if (!fs.existsSync(corePath)) {
        this.logManager.addLog(
          'warn',
          `staged 暂存核心缺失，清理：${corePath}`,
          'CoreUpdateService'
        );
        this.clearStaged();
        this.emitAutoStatus();
        return 'discarded';
      }
      const preflight = await this.preflightValidate(corePath);
      if (!preflight.ok) {
        if (preflight.version) this.markKnownBad(preflight.version);
        this.logManager.addLog(
          'warn',
          `落位前重预检失败，放弃 staged ${staged.version}：${preflight.reason}`,
          'CoreUpdateService'
        );
        this.clearStaged();
        this.emitAutoStatus();
        return 'discarded';
      }
      // M2：跟踪本次是否已备份；installCoreFromDir 中途失败（复制半截/磁盘满）时回滚半替换核心，
      // 对齐 updateCore 的 catch restoreBackup（否则留半替换核心，下次启动失败也不 autoRollback）。
      let backupMade = false;
      // core-swap 手动轴门控：标记「二进制替换窗口」开启——installCoreFromDir 执行期间拒绝手动 start/restart/switchMode
      // （防撞半替换核 FATAL）。finally 清位；applyStagedNow 在 tryApplyStaged 返回后的 start（coreSwapInProgress 已清）放行。
      this.proxyManager?.setCoreSwapInProgress(true);
      try {
        await this.installCoreFromDir(staged.dir, preflight.version ?? staged.version, () => {
          backupMade = true;
        });
      } catch (installErr) {
        // N-1：restoreBackup 在 finally 清位前执行（此刻 coreSwapInProgress 仍 true）——但 restoreBackup 仅写核文件、
        // 不调 start/switchMode（不触门控），故无害。与 updateCore/replaceManualCore（restoreBackup 在清位后）略不一致，
        // 系 try/catch/finally 语义所致；后人若给 restoreBackup 加重启逻辑须先清位。
        if (backupMade) await this.restoreBackup();
        throw installErr;
      } finally {
        this.proxyManager?.setCoreSwapInProgress(false);
      }
      this.clearStaged();
      this.logManager.addLog(
        'info',
        `内核已自动更新落位至 ${staged.version}（${trigger}）`,
        'CoreUpdateService'
      );
      // 复用 banner 作成功提示 + 回滚入口。push 型持久通知：先记 pendingChangeNotice（供 banner mount 兜 listener
      // 注册竞态、且展示前重启也不丢），再发即时事件。banner 展示即 ack 清除 → 弹一次非每启（根治旧推断式比对每启误报）。
      this.saveAutoState({
        pendingChangeNotice: { previousVersion: current, currentVersion: staged.version },
      });
      // 版本已变（只有 manual-apply 能在固定生效时走到这里）→ 固定随之作废；下方 emitAutoStatus 一并推出。
      this.dropPin(`已应用暂存内核 ${staged.version}`);
      this.eventSender?.(IPC_CHANNELS.EVENT_CORE_VERSION_CHANGED, {
        previousVersion: current,
        currentVersion: staged.version,
        hasBackup: this.hasBackup(),
      });
      this.emitAutoStatus();
      return 'applied';
    } catch (e) {
      this.logManager.addLog('error', `staged 落位失败: ${e}`, 'CoreUpdateService');
      this.emitAutoStatus();
      return 'failed';
    } finally {
      if (heldOp) this.coreOps--;
      if (!lockHeld) this.isUpdating = false;
      this.afterCoreOpReleased(); // lockHeld 时外层仍持 isUpdating → 空操作，由外层放锁时再触发
    }
  }

  /**
   * 用户点「立即应用」：唯一允许主动断流的路径。运行中则停代理→等2s→落位→重启代理（首启走稳定观察/自动回滚）。
   * 返回 tryApplyStaged 的枚举结果，供 UI 区分反馈（applied→成功 / failed→失败 / discarded→已作废 /
   * deferred→仍待生效）。修 M1：原 boolean「staged 是否清空」会把 discarded（已换过/known-bad）当成功、
   * 把 failed（install 失败、staged 保留）当成功（UI 误报「已应用」），且 wasRunning 在非 applied 分支不恢复
   * 代理，留停止态无反馈。
   */
  async applyStagedNow(): Promise<StagedApplyResult> {
    const staged = this.loadAutoState().staged;
    if (!staged) return 'noop';
    return this.withCoreOp(
      () => this.applyStagedNowLocked(),
      (code) => {
        throw coreOpBusyError(code);
      }
    );
  }

  /** applyStagedNow 本体（已持 coreOps；停代理 → 落位 → 重启）。 */
  private async applyStagedNowLocked(): Promise<StagedApplyResult> {
    const wasRunning = this.proxyManager?.getStatus().running === true;
    if (wasRunning && this.proxyManager) {
      this.logManager.addLog(
        'info',
        '用户点「立即应用」，停止代理以落位新内核...',
        'CoreUpdateService'
      );
      await this.proxyManager.stop();
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    const result = await this.tryApplyStaged('manual-apply');

    // 不变量：wasRunning 时无论落位结果都恢复代理，绝不留停止态（修 M1：install 失败/作废/重预检失败
    // 等非 applied 分支此前不恢复，代理被静默留停）。applied 走稳定观察/自动回滚链路（首启成功→
    // recordSuccessfulVersion+稳定观察；失败→'error'→autoRollbackIfPendingUpdate），其余分支以旧核心重启。
    if (wasRunning && this.proxyManager) {
      this.logManager.addLog(
        'info',
        result === 'applied' ? '新内核已落位，正在重启代理...' : '落位未生效，以原内核重启代理...',
        'CoreUpdateService'
      );
      const cfg = this.configProvider ? await this.configProvider() : null;
      if (cfg) {
        await this.proxyManager.start(cfg);
      }
    }
    return result;
  }

  /*
   * 带重试机制的文件复制，遇到 EBUSY 会尝试强制结束进程 (Windows)
   */
  private async copyFileWithRetry(src: string, dest: string, retries: number = 3): Promise<void> {
    for (let i = 0; i < retries; i++) {
      try {
        fs.copyFileSync(src, dest);
        return;
      } catch (error: any) {
        this.logManager.addLog(
          'warn',
          `Copy failed (attempt ${i + 1}/${retries}): ${error.message}`,
          'CoreUpdateService'
        );

        // 如果是最后一次尝试，直接抛出异常
        if (i === retries - 1) throw error;

        // Windows 下如果是 EBUSY 或 EPERM，尝试强制结束 sing-box 进程
        if (process.platform === 'win32' && (error.code === 'EBUSY' || error.code === 'EPERM')) {
          this.logManager.addLog(
            'info',
            'File locked, attempting to force kill sing-box.exe...',
            'CoreUpdateService'
          );
          try {
            require('child_process').execSync(`"${system32('taskkill.exe')}" /F /IM sing-box.exe`, {
              stdio: 'ignore',
            });
            // 杀进程后多等一会儿
            await new Promise((resolve) => setTimeout(resolve, 1000));
          } catch {
            // 忽略错误（可能进程不存在）
          }
        }

        // 等待后重试
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  async getCurrentVersion(force = true): Promise<string> {
    // 默认 force=true 读活二进制：版本记录/回滚/兼容带(verifiedCeiling)决策等准确性敏感点必须读真实当前核心——
    // 换核/回滚不经 startInternal 的 force 刷新，若吃 getCoreVersion 缓存会读到陈旧失败版本 → 记错版本、回滚 fail-safe 失效。
    // 仅「关于」页显示(version-handlers)显式传 false 走缓存，避免高频进入时 spawn 内核子进程致加载转圈。
    if (this.proxyManager) {
      return await this.proxyManager.getCoreVersion(force);
    }
    return '未知';
  }

  /**
   * 判定当前内核来源（official/fork/unknown）。fork=第三方内核 → 禁在线/自动更新（见 checkUpdate/updateCore/
   * tryApplyStaged 闸门）。读 `sing-box version` 原始行 → classifyCoreBuild（单一真值 shared/core-build）。
   * 不单独缓存 kind：版本行由 getCoreVersion 缓存/换核后 force 刷新，判定恒跟随当前实跑内核。
   */
  async getCoreBuild(force = false): Promise<CoreBuildKind> {
    try {
      if (!this.proxyManager) return 'unknown';
      // force=true：自行刷新版本行（不依赖调用方先 getCurrentVersion(force)），使守卫恒跟随当前实跑内核——
      // 否则会话内换核（官方→fork）后读到陈旧 official 行 → 守卫失效覆盖用户 fork。updateCore/tryApplyStaged
      // 传 true（它们守卫前无强制刷新）；checkUpdate/getVersionInfo 已先 getCurrentVersion(force) 刷新，传 false 复用。
      const line = await this.proxyManager.getCoreVersionLine(force);
      return classifyCoreBuild(line);
    } catch {
      return 'unknown';
    }
  }

  /** 在代理成功启动后调用。 */
  async recordSuccessfulVersion(): Promise<void> {
    try {
      const version = await this.getCurrentVersion();
      // 版本未知时不记录：避免把占位串 '未知' 当作可回滚的「可用版本」持久化
      if (!version || version === '未知') {
        return;
      }
      // core-version.json 持久位已废除（曾仅供内核版本变更横幅推断式比对；已改 push 型 pendingChangeNotice 根治每启误报）。
      // 本方法保留：成功运行 → clearKnownBad + verifiedCeiling 棘轮（回滚安全网走 .bak / known-bad，不依赖此文件）。
      this.logManager.addLog('info', `内核版本 ${version} 成功运行`, 'CoreUpdateService');

      // 该版本成功运行 → 从问题版本名单移除（曾因瞬时原因误标记的版本恢复自动更新资格）
      this.clearKnownBad(version);

      // B0：成功运行即「实证兼容」该版本带 → 棘轮抬高 verifiedCeiling，让兼容带闸放行该带内后续更新。
      // 预发布（1.15.0-alpha.N 等）不算实证：试装一次 alpha 不得永久放宽「检查更新」的兼容带闸（预发布随时还会改 schema；
      // 该带正式版发布后，用户实跑过它才算数）。
      const enc = encodeMajorMinor(version);
      if (
        !hasPrereleaseSuffix(version) &&
        !isNaN(enc) &&
        enc > (this.loadAutoState().verifiedCeiling ?? 0)
      ) {
        this.saveAutoState({ verifiedCeiling: enc });
      }

      // 若处于"更新后待验证"窗口：'started' 仅代表存活 1s、可能假成功，不立即删备份；改启动稳定
      // 观察期，期内无 error 才判稳定→删备份（详见 startStabilityWatch，修复假成功删备份问题）
      // 已报过错、回滚被推迟（rollbackDeferred）的新核绝不进入稳定观察：判稳会删 .bak、清待验证态，回滚网随之消失。
      if (this.pendingUpdateVersion && !this.rollbackDeferred) {
        this.startStabilityWatch();
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logManager.addLog('warn', `记录版本失败: ${msg}`, 'CoreUpdateService');
    }
  }

  hasBackup(): boolean {
    return fs.existsSync(this.getBackupPath());
  }

  /**
   * 获取备份版本号（运行 sing-box.bak version）
   */
  async getBackupVersion(): Promise<string | null> {
    const backupPath = this.getBackupPath();
    if (!fs.existsSync(backupPath)) return null;
    try {
      const { exec } = require('child_process');
      const util = require('util');
      const execAsync = util.promisify(exec);
      const { stdout } = await execAsync(`"${backupPath}" version`);
      const match = stdout.match(/version\s+(\S+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  /**
   * 获取当前核心版本信息（用于 UI 展示）
   */
  async getVersionInfo(): Promise<CoreVersionInfo> {
    const currentVersion = await this.getCurrentVersion();
    const hasBackup = this.hasBackup();
    const backupVersion = hasBackup ? await this.getBackupVersion() : null;
    // getCurrentVersion(force) 已刷新版本行 → getCoreBuild 跟随当前实跑内核。
    const build = await this.getCoreBuild();
    // push 型：banner 读 pendingChangeNotice 决定是否弹（取代旧「持久历史 vs 运行时实际」推断比对；lastKnownVersion 死字段已删）。
    const pendingChangeNotice = this.loadAutoState().pendingChangeNotice ?? null;
    // currentVersion 读的是活二进制（force）→ 可据此清陈旧固定；但换核 / 安装 / 恢复进行中版本在变，只过滤不清。
    const pinned = await this.activePin(currentVersion, !this.isUpdating && this.coreOps === 0);
    return {
      currentVersion,
      backupVersion,
      hasBackup,
      build,
      pendingChangeNotice,
      bundledVersion: coreManifest.bundledCoreVersion,
      pinned,
    };
  }

  /** banner 展示版本变更通知后 ack 清除 pendingChangeNotice（show→ack：弹一次非每启）。无通知则 no-op。 */
  ackPendingChangeNotice(): void {
    if (this.loadAutoState().pendingChangeNotice) {
      this.saveAutoState({ pendingChangeNotice: undefined });
    }
  }

  /**
   * 用户触发的回滚：将 .bak 恢复为当前核心，并重新签名
   */
  async rollbackCore(): Promise<void> {
    return this.withCoreOp(
      () => this.rollbackCoreLocked(),
      (code) => {
        throw coreOpBusyError(code);
      }
    );
  }

  /** rollbackCore 本体（已持 coreOps）。 */
  private async rollbackCoreLocked(): Promise<void> {
    if (!this.hasBackup()) {
      throw new Error('没有可用的备份版本');
    }
    // 回滚（手动 / autoRollbackIfPendingUpdate 自动）使旧「版本已变更」通知作废：清 pendingChangeNotice 防陈旧误弹
    // （核已回退，通知的 A→B 不再成立；回滚本身即反馈，无需再弹。自动回滚不经 banner show→ack 之补口）。
    this.ackPendingChangeNotice();

    if (this.proxyManager) {
      const status = this.proxyManager.getStatus();
      if (status.running) {
        this.logManager.addLog('info', '回滚前停止代理服务...', 'CoreUpdateService');
        await this.proxyManager.stop();
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }

    // core-swap 手动轴门控（补 F-1 缺口）：rollbackCore 经 installSingleCoreViaHelper/普通 copy 写核，不经
    // installCoreFromDir，需独立置位。无恢复性 start（写核后 record+return），try/finally 仅保证清位防闩挂死。
    this.proxyManager?.setCoreSwapInProgress(true);
    try {
      const backupPath = this.getBackupPath();
      // B 块 macOS（helper v5）：受保护目录 root-only，经 helper install-core 把 backup 写回（连带 libcronet）。普通
      // fs.copy 写不了；且读路径优先受保护目录，必须写那里，否则「写了读不到」。
      if (await this.isProtectedCoreActive()) {
        await this.installSingleCoreViaHelper(backupPath);
        try {
          fs.unlinkSync(backupPath);
        } catch {
          /* ignore */
        }
        this.logManager.addLog('info', '核心回滚成功（写回受保护目录）', 'CoreUpdateService');
        await this.recordSuccessfulVersion();
        await this.settleStateAfterRollback();
        return;
      }

      const currentPath = resourceManager.getSingBoxUpdateTargetPath();
      this.logManager.addLog(
        'info',
        `正在回滚核心: ${backupPath} → ${currentPath}`,
        'CoreUpdateService'
      );

      if (process.platform === 'win32') {
        await this.copyFileElevatedWindows(backupPath, currentPath);
      } else {
        fs.copyFileSync(backupPath, currentPath);
        fs.chmodSync(currentPath, 0o755);
      }

      // macOS: 重新签名
      if (process.platform === 'darwin') {
        try {
          const { execSync } = require('child_process');
          execSync(`xattr -cr "${currentPath}"`, { stdio: 'pipe' });
          execSync(`codesign --force --deep -s - "${currentPath}"`, { stdio: 'pipe' });
          this.logManager.addLog('info', '回滚：已完成 macOS 签名处理', 'CoreUpdateService');
        } catch (signError: any) {
          this.logManager.addLog(
            'warn',
            `回滚签名处理失败: ${signError.message}`,
            'CoreUpdateService'
          );
        }
      }

      this.logManager.addLog('info', '核心回滚成功', 'CoreUpdateService');

      // 删除备份（回滚后备份不再有意义）
      try {
        fs.unlinkSync(backupPath);
      } catch {
        // ignore
      }

      // 更新版本记录
      await this.recordSuccessfulVersion();
      await this.settleStateAfterRollback();
    } finally {
      this.proxyManager?.setCoreSwapInProgress(false);
    }
  }

  /**
   * 回滚成功后的状态收尾（受保护目录 / 普通两条回滚腿共用；手动回滚与首启失败自动回滚同经此处）：
   *  - B0：回滚 = 被回滚版本带验证失败 → 把 verifiedCeiling 重置到回滚后实跑带（撤销更高带的「已验证」，兼容带闸不再放行
   *    那个出问题的更高带）。recordSuccessfulVersion 的棘轮 max 不会下降，故此处显式覆盖。回滚后是预发布核时只降不升
   *    （与「预发布不算实证」一致：从正式版回滚到先前试装的 alpha，不得借回滚把上限抬到 alpha 的带）；
   *  - 固定作废：版本已回退，「固定 X」不再成立（首启失败自动回滚时更是 X 本身有问题）。
   */
  private async settleStateAfterRollback(): Promise<void> {
    const rolled = await this.getCurrentVersion();
    const rolledEnc = encodeMajorMinor(rolled);
    if (!isNaN(rolledEnc)) {
      const prev = this.loadAutoState().verifiedCeiling ?? BUNDLED_CEILING;
      this.saveAutoState({
        verifiedCeiling: hasPrereleaseSuffix(rolled) ? Math.min(rolledEnc, prev) : rolledEnc,
      });
    }
    if (this.dropPin('内核已回滚')) this.emitAutoStatus();
  }

  /**
   * 用户手动选择本地 sing-box 二进制并替换当前核心（也供 resetCoreToFactory 复用）。
   * @param opts.filePath 源文件路径（省略则弹系统文件选择器）
   * @param opts.force 跳过同版本短路（reset 到出厂常与现役同版本，仍要覆盖）
   * @param opts.skipBackup reset 到出厂时=true：跳过备份/验证闩/回退（现役核是用户要丢弃的，出厂核已知稳定）
   */
  async replaceManualCore(opts?: {
    filePath?: string;
    force?: boolean;
    skipBackup?: boolean; // reset 到出厂时跳过备份/验证闩（现役核是用户要丢弃的，出厂核已知稳定）
  }): Promise<ManualCoreReplaceResult> {
    return this.withCoreOp(
      () => this.replaceManualCoreLocked(opts),
      (code) => ({ ok: false, code, error: code === 'BUSY' ? CORE_BUSY_MSG : XRAY_BUSY_MSG })
    );
  }

  /**
   * replaceManualCore 本体（已持 coreOps；含选文件对话框——其间 Xray 切换与其它内核操作被拒，免得两边同时换核）。
   * resetCoreToFactory 持锁后直接调本体（经公开入口会被自己的锁拒为 BUSY）。
   */
  private async replaceManualCoreLocked(opts?: {
    filePath?: string;
    force?: boolean;
    skipBackup?: boolean;
  }): Promise<ManualCoreReplaceResult> {
    // 源文件：确认流程二次调用显式传入 filePath，否则弹系统文件选择器
    let sourcePath = opts?.filePath;
    if (!sourcePath) {
      const result = await dialog.showOpenDialog({
        title: '选择 sing-box 可执行文件',
        filters:
          process.platform === 'win32'
            ? [{ name: 'Executable', extensions: ['exe'] }]
            : [{ name: 'All Files', extensions: ['*'] }],
        properties: ['openFile'],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { ok: false }; // 用户取消
      }
      sourcePath = result.filePaths[0];
    }

    // 预检源文件（可执行 + 解析当前配置）——在停代理前，预检失败时现役核心继续运行、不动。
    this.advanceResetPhase('testing');
    const preSrc = await this.preflightValidate(sourcePath);
    if (!preSrc.ok) {
      return {
        ok: false,
        error: `所选文件未通过核心预检（${preSrc.reason}）。\nMac 用户请注意：\n1. 请先双击解压下载的 .tar.gz，选择解压出的名为 sing-box 的 UNIX 可执行文件。\n2. 请确保架构 (arm64/amd64) 与当前 Mac 匹配。`,
      };
    }

    // 内核来源 + 可比较版本：uploadBuild 判官方/fork/unknown；uploadComparable 截断 fork/dev 尾段，与启动时
    // startInternal 的 reseed 决策（this.coreVersion 经 getCoreVersion 同款截断）喂进 compareSemver 的 token **同形**。
    // 否则官方 dev（X.Y.Z-alpha.N-hex）/ fork 的完整后缀会污染 prerelease 段比较，令预判与实际 reseed 分歧（B-2 空头支票复发）。
    const uploadBuild = classifyCoreBuild(preSrc.versionLine);
    const uploadComparable = comparableCoreVersion(preSrc.version ?? '');

    // B-2 基线预判（诚实告知，**先于同版本短路**：官方旧核即便与现役同版也应告知「会被刷回」，而非只弹同版本框）：
    // 上传的官方核旧于随包种子基线 → 下次连接 startInternal 必 reseed 打回随包核，「替换成功」将是空头支票。
    // 预判 decideCoreOverride（与 startInternal 同函数、同基线 coreManifest.bundledCoreVersion、同形 token），
    // 若会被 reseed 则返回 needConfirm+baselineOverride，前端弹框告知；用户确认（force）后照常替换，临时用到下次连接为止。
    // fork/unknown 不会被 reseed（decideCoreOverride 恒 keep）→ 不触发此闸，走后续短路/替换 + B-3 来源提示。
    const { reseed: willReseed } = decideCoreOverride(
      uploadBuild,
      uploadComparable,
      coreManifest.bundledCoreVersion
    );
    if (willReseed && !opts?.force) {
      return {
        ok: false,
        needConfirm: true,
        baselineOverride: true,
        uploadVersion: preSrc.version ?? undefined, // 展示用完整 token
        bundledVersion: coreManifest.bundledCoreVersion,
        filePath: sourcePath,
      };
    }

    // 同版本短路（提示确认）：可比较版本与当前一致且未 force → needConfirm 由前端弹确认框，保留「换不同 build /
    // 重签修损坏核」的能力。用 comparable 形两侧比较（current 侧 getCoreVersion 本就是截断形），使 fork / 官方 dev
    // 上传同一核也能正确短路（B-1 完整覆盖，不再只兑现 prerelease 半边）。
    const currentVersion = await this.getCurrentVersion();
    if (!opts?.force && preSrc.version && uploadComparable === currentVersion) {
      return { ok: false, needConfirm: true, sameVersion: preSrc.version, filePath: sourcePath };
    }

    // 停止代理（记录 wasRunning 供落位后重启——统一不变量：停了就在落位后恢复，不留停止态致断网）
    this.advanceResetPhase('switching');
    let wasRunning = false;
    if (this.proxyManager) {
      const status = this.proxyManager.getStatus();
      if (status.running) {
        this.logManager.addLog('info', '手动替换核心：停止代理服务...', 'CoreUpdateService');
        await this.proxyManager.stop();
        wasRunning = true;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }

    let backupMade = false;
    try {
      // core-swap 手动轴门控：标记「二进制替换窗口」开启——手动替换核心写入期间拒绝手动 start/restart/switchMode
      // （防撞半替换核 FATAL）。补 T1 覆盖缺口：replaceManualCore 走 installSingleCoreViaHelper/writeManualCoreToBundle，
      // 不经 installCoreFromDir，需独立置位。内层 try/finally 精确覆盖置位+backup+写核；清位后下方恢复性 start 放行（同 updateCore）。
      try {
        this.proxyManager?.setCoreSwapInProgress(true);
        // skipBackup（reset 到出厂）：不备份现役核（用户要丢弃的），写入失败直接抛错让用户重试
        if (!opts?.skipBackup) {
          await this.backupCurrentCore();
          backupMade = true;
        }

        // 写入新核心：macOS + helper v5 → install-core 进受保护目录；否则 → bundle 写入腿（含签名 + 落位后预检）。
        // 源已 preSrc 预检过；install-core 内 sha256 校验保证落位字节 == 预检源，无需二次预检。
        if ((process.platform === 'darwin' || process.platform === 'linux') && this.helperManager) {
          const st = await this.helperManager.getStatus();
          if (this.helperSupportsInstallCore(st)) {
            await this.installSingleCoreViaHelper(sourcePath);
            this.logManager.addLog(
              'info',
              '手动替换核心已写入受保护/受管核目录',
              'CoreUpdateService'
            );
          } else {
            await this.writeManualCoreToBundle(sourcePath);
          }
        } else {
          await this.writeManualCoreToBundle(sourcePath);
        }
      } finally {
        this.proxyManager?.setCoreSwapInProgress(false);
      }
      // 现役核已是用户所选：作废上一个待验证版本及其被推迟的首启失败回滚——否则放锁时那次推迟的回滚会把刚备份进 .bak
      // 的旧待验证核拷回、盖掉用户所选（代理未运行时还会把它拉起来）。之前在运行 → 下方 arm 立即为新核重新上闩。
      this.disarmPendingValidation();

      // 待验证闩 + 重启：之前运行 → arm（新版本），重启后由首启 'started' 记录版本+稳定观察、'error'（运行时首启崩溃）
      // → autoRollbackIfPendingUpdate 自动回滚（对齐 updateCore，手动换坏核运行时崩溃也有回滚网，修 M-1）；之前未运行
      // → 无首启可验证，直接 record。
      if (wasRunning && this.proxyManager) {
        // skipBackup（出厂核）：不 arm 验证闩（无备份可 autoRollback），直接 record + 重启
        if (!opts?.skipBackup) {
          this.armPendingValidation(preSrc.version);
        } else {
          await this.recordSuccessfulVersion();
        }
        this.logManager.addLog('info', '手动替换完成，正在重启代理服务...', 'CoreUpdateService');
        this.advanceResetPhase('restarting');
        const cfg = this.configProvider ? await this.configProvider() : null;
        if (cfg) await this.proxyManager.start(cfg);
      } else {
        await this.recordSuccessfulVersion();
      }
      // 内核已换成用户选的文件（或随包核）：版本选择里的旧固定随之作废。
      if (this.dropPin(opts?.skipBackup ? '已恢复随包版本' : '内核已手动替换'))
        this.emitAutoStatus();
      // B-3：回传内核来源（预检 versionLine 判定），前端替换成功后据此对 fork/unknown 追加来源提示。
      return { ok: true, build: uploadBuild };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logManager.addLog('error', `手动替换核心失败: ${msg}`, 'CoreUpdateService');
      // 撤销可能已 arm 的待验证闩（防下面以原核重启被首启钩子当新核记录/观察）
      this.disarmPendingValidation();
      // 失败回滚：恢复备份的原核心；之前在运行则尽力以原核心重启代理恢复网络
      if (backupMade) await this.restoreBackup();
      if (wasRunning && this.proxyManager) {
        try {
          const cfg = this.configProvider ? await this.configProvider() : null;
          if (cfg) await this.proxyManager.start(cfg);
        } catch {
          /* 尽力恢复，不掩盖原错误 */
        }
      }
      return { ok: false, error: msg };
    }
  }

  /** 手动换核的 bundle 写入腿（非 macOS-v5）：copy → 签名 → 落位后预检。失败抛出由 replaceManualCore 外层 catch 回滚。 */
  private async writeManualCoreToBundle(sourcePath: string): Promise<void> {
    const targetPath = resourceManager.getSingBoxUpdateTargetPath();
    const targetDir = path.dirname(targetPath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    this.logManager.addLog(
      'info',
      `手动替换核心: ${sourcePath} → ${targetPath}`,
      'CoreUpdateService'
    );
    if (process.platform === 'win32') {
      await this.copyFileElevatedWindows(sourcePath, targetPath);
    } else {
      fs.copyFileSync(sourcePath, targetPath);
      fs.chmodSync(targetPath, 0o755);
    }
    // naive 依赖：libcronet 与新核心同目录（linux/win dlopen；macOS 静态编入为 no-op）
    await resourceManager.ensureCronetBeside(targetDir);
    if (process.platform === 'darwin') {
      try {
        const { execSync } = require('child_process');
        execSync(`xattr -cr "${targetPath}"`, { stdio: 'pipe' });
        execSync(`codesign --force --deep -s - "${targetPath}"`, { stdio: 'pipe' });
      } catch (signError: any) {
        this.logManager.addLog(
          'warn',
          `手动替换签名处理失败: ${signError.message}`,
          'CoreUpdateService'
        );
      }
    }
    // 落位 + 签名后预检（确认落位核能跑）；失败抛出 → 外层 catch restoreBackup。
    const preflight = await this.preflightValidate(targetPath);
    if (!preflight.ok) {
      throw new Error(`落位后核心预检失败（${preflight.reason}）`);
    }
    // record 不在此做——由 replaceManualCore 统一处理（wasRunning ? 待验证闩+首启钩子 : 直接 record）
  }

  /** 重置内核到出厂版本：把随 App 出厂的 bundled 核 force 落位回受保护目录（macOS-v5）/bundle。
   *  skipBackup=true：出厂核是用户要的终态，现役核是用户要丢弃的——不备份/不验证闩/不回退（去冗余）。
   *  force 跳过同版本短路（出厂核常与现役同版本，重置仍要覆盖回去）。 */

  /**
   * 校验随包出厂核是否仍是 manifest 里 pin 的那一份（`coreBinarySha256`）。
   *
   * 存在的理由：`resetCoreToFactory` 的语义是「回到已知良好的出厂状态」。若 app 安装目录里的出厂核已被
   * 替换（portable 安装目录用户可写，普通权限的恶意程序即可改），reset 就会把恶意核**当作干净核装回去**，
   * 而且这是用户主动求助时最信任的一步。
   *
   * **仅 win/linux 校验，macOS 跳过**——不是偷懒，是 pin 在 mac 上本就对不上：release 流程对 .app 做
   * `codesign --force --deep --sign -`，深签会重写嵌套二进制（真机实测：同一文件签名前后 sha 不同），
   * 而 pin 取自上游 release 原件。硬校验会对每个 mac 用户误报。mac 侧的等价保护由 .app 自身的代码签名
   * （Gatekeeper 校验嵌套内容）承担。
   *
   * @returns null=通过或不适用；字符串=拒绝理由
   */
  private verifyFactoryCore(bundlePath: string): string | null {
    if (process.platform === 'darwin') return null; // 见上：深签重写字节，pin 不适用
    const key =
      process.platform === 'win32' ? 'win' : process.platform === 'linux' ? 'linux' : null;
    if (!key) return null;
    const pin = (coreManifest as { coreBinarySha256?: Record<string, string> }).coreBinarySha256?.[
      key
    ];
    if (!pin) return null; // 无 pin 不阻断（与 fetch-core 同口径：pin 是自证锚，缺它退回原行为）
    try {
      const actual = createHash('sha256').update(fs.readFileSync(bundlePath)).digest('hex');
      if (actual === pin) return null;
      return `随包出厂内核与官方指纹不符（期望 ${pin.slice(0, 12)}…，实得 ${actual.slice(0, 12)}…）。安装目录内的内核可能已被替换，已拒绝重置；请重新安装 FlowZ。`;
    } catch (e) {
      return `无法读取随包出厂内核以校验完整性：${e}`;
    }
  }

  /**
   * 恢复随包（出厂）版本。也是版本选择里「恢复随包」的落位腿。
   *  - 入口同步 check+set isUpdating（同 installTag）：与在线安装 / 检查更新 / 自动轮次 / staged 落位互斥——否则 reset 停代理
   *    后 onProxyStopped 5s 内可把暂存核落位回去，或与安装并发双换核。已有内核操作在飞 → BUSY；Xray 正在切换 → XRAY_BUSY；
   *  - 进度以 kind 'reset' 推送（设置卡卸载重挂后经 getInstallState 找回），结束推 null；
   *  - 成功后回到干净状态：删旧备份、清固定 / 暂存核、verifiedCeiling 重置为出厂带（试过的预发布 / 跨带不再放宽
   *    「检查更新」的兼容带闸）。问题版本名单 / 跨带提示等其它状态不动。
   */
  async resetCoreToFactory(): Promise<CoreFactoryResetResult> {
    // 同步临界区：check+set（isUpdating + coreOps，同 installTag）在第一个 await 之前；落位腿直接调 replaceManualCoreLocked
    // （公开的 replaceManualCore 会被这把锁拒为 BUSY）。
    if (this.isUpdating || this.coreOps > 0) {
      this.logManager.addLog('warn', '恢复随包内核未开始：内核更新正在进行中', 'CoreUpdateService');
      return { ok: false, code: 'BUSY', error: CORE_BUSY_MSG };
    }
    if (this.xrayBusy()) {
      this.logManager.addLog('warn', `恢复随包内核未开始：${XRAY_BUSY_MSG}`, 'CoreUpdateService');
      return { ok: false, code: 'XRAY_BUSY', error: XRAY_BUSY_MSG };
    }
    this.isUpdating = true;
    this.coreOps++;
    try {
      this.logManager.addLog('info', '重置内核到出厂版本...', 'CoreUpdateService');
      this.setInstallProgress({
        kind: 'reset',
        tag: `v${coreManifest.bundledCoreVersion}`,
        phase: 'testing',
      });
      const bundlePath = resourceManager.getBundledSingBoxPath();
      // 出厂核完整性：reset 是「回到已知良好」的动作，装回一个已被替换的二进制比不 reset 更糟。
      const bad = this.verifyFactoryCore(bundlePath);
      if (bad) {
        this.logManager.addLog('error', `重置内核被拒绝：${bad}`, 'CoreUpdateService');
        return { ok: false, error: bad };
      }
      const r = await this.replaceManualCoreLocked({
        filePath: bundlePath,
        force: true,
        skipBackup: true,
      });
      if (r.ok) {
        this.pruneBackup(); // 清理旧备份（reset 到出厂 = 干净状态，残留 .bak 无意义）
        this.clearStaged();
        this.saveAutoState({ pinned: undefined, verifiedCeiling: BUNDLED_CEILING });
        this.emitAutoStatus();
        this.logManager.addLog('info', '内核已重置到出厂版本', 'CoreUpdateService');
      }
      return { ok: r.ok, error: r.error };
    } finally {
      // 先清暂存（上方）再放锁，同一同步段：放锁后才可能进入的 tryApplyStaged 看不到旧暂存。
      this.isUpdating = false;
      this.coreOps--;
      this.setInstallProgress(null);
      this.afterCoreOpReleased();
    }
  }

  // === 核心更新健壮性：预检 / 问题版本跳过 / 备份生命周期 / 自动回滚 ===

  /**
   * 取任意 sing-box 二进制的版本（执行 `<bin> version` 解析）。返回 { version, versionLine }：
   * version=完整 token（保留 prerelease/fork 后缀，形状不符或不可执行 → null）、versionLine=原始首行（供来源判定）。
   */
  private async getBinaryVersion(
    binPath: string
  ): Promise<{ version: string | null; versionLine: string; buildTags: string[] | null }> {
    try {
      const execFileAsync = require('util').promisify(require('child_process').execFile);
      // 超时：外来 / 挂起的二进制不得永久持有更新锁（见 CORE_EXEC_TIMEOUT_MS）；超时 = 不可执行。
      const { stdout } = await execFileAsync(binPath, ['version'], {
        timeout: CORE_EXEC_TIMEOUT_MS,
        windowsHide: true,
      });
      // 保留完整后缀：同版本短路需精确匹配预览版、B-2 基线预判 / B-3 来源识别需原始行（单一真值 shared/core-build）。
      // buildTags：`Tags:` 行（with_gvisor 等），供 installTag 的 gVisor 守卫。
      return {
        ...parseUploadedCoreVersion(String(stdout)),
        buildTags: parseSingboxBuildTags(String(stdout)),
      };
    } catch {
      return { version: null, versionLine: '', buildTags: null };
    }
  }

  /** 标记问题版本（委托 CoreUpdateStateStore）：预检/启动失败的版本自动更新跳过，手动仍可强装。 */
  private markKnownBad(version: string): void {
    this.stateStore.markKnownBad(version);
  }

  isKnownBad(version: string): boolean {
    return this.stateStore.isKnownBad(version);
  }

  /** 从问题版本名单移除某版本（委托 CoreUpdateStateStore；该版本成功运行后调用，使误标记可恢复）。 */
  private clearKnownBad(version: string): void {
    this.stateStore.clearKnownBad(version);
  }

  private async isRestrictToCompatibleMinor(): Promise<boolean> {
    try {
      if (!this.configProvider) return true;
      const cfg = await this.configProvider();
      return cfg?.restrictCoreUpdateToCompatibleMinor !== false; // 默认 true
    } catch {
      return true;
    }
  }

  /**
   * 核心更新预检：新核心二进制可执行 + 能解析"针对其版本生成的"当前配置（sing-box check）。
   * 在替换现役核心之前调用 —— 不通过则现役核心不动、代理继续运行（永不 brick）。
   */
  private async preflightValidate(newCorePath: string): Promise<{
    ok: boolean;
    version: string | null;
    versionLine: string;
    reason?: string;
    /** `sing-box check` 失败时的完整输出（stderr 优先，过长取尾部）；仅 check 失败时有。 */
    detail?: string;
    /** 新核构建 tag（`sing-box version` 的 Tags 行）；输出无此行为 null。 */
    buildTags?: string[] | null;
  }> {
    const { version, versionLine, buildTags } = await this.getBinaryVersion(newCorePath);
    if (!version) {
      return {
        ok: false,
        version: null,
        versionLine,
        buildTags,
        reason: '新核心无法执行（架构不符或文件损坏）',
      };
    }

    const cfgJson = this.proxyManager ? this.proxyManager.buildPreflightConfigJson(version) : null;
    if (!cfgJson) {
      // 无活动配置（代理从未启动）→ 二进制可执行即视为通过
      this.logManager.addLog(
        'info',
        `预检：新核心 ${version} 可执行（无活动配置，跳过 check）`,
        'CoreUpdateService'
      );
      return { ok: true, version, versionLine, buildTags };
    }

    const tmpCfg = path.join(app.getPath('temp'), `flowz-preflight-${Date.now()}.json`);
    try {
      fs.writeFileSync(tmpCfg, cfgJson, 'utf-8');
      const execFileAsync = require('util').promisify(require('child_process').execFile);
      await execFileAsync(newCorePath, ['check', '-c', tmpCfg], {
        timeout: CORE_EXEC_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
      this.logManager.addLog(
        'info',
        `预检通过：新核心 ${version} 可解析当前配置`,
        'CoreUpdateService'
      );
      return { ok: true, version, versionLine, buildTags };
    } catch (e: any) {
      if (e?.killed) {
        const reason = `新核心检查当前配置超时（${CORE_EXEC_TIMEOUT_MS / 1000}s 未结束）`;
        return { ok: false, version, versionLine, buildTags, reason, detail: reason };
      }
      // sing-box 即使输出到管道也带 ANSI 色码（实测 `\x1b[31mFATAL\x1b[0m[0000] …`）→ 先剥，再给渲染端 / 日志。
      const out = stripAnsi(String(e?.stderr || e?.message || e)).trim();
      // 摘要取 FATAL 行：1.15 起 check 会先打 WARN（如 TUN stack 弃用提示），首行不再是失败原因。
      const headline =
        extractLastFatal(out) ??
        out
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find(Boolean) ??
        '';
      return {
        ok: false,
        version,
        versionLine,
        buildTags,
        reason: `新核心无法解析当前配置：${headline}`,
        detail: clipTail(out),
      };
    } finally {
      try {
        fs.unlinkSync(tmpCfg);
      } catch {
        /* ignore */
      }
    }
  }

  /** 删除旧核心备份（新核心已稳定运行后调用 —— 稳定即不再回滚，省磁盘）。 */
  private pruneBackup(): void {
    try {
      const bak = this.getBackupPath();
      if (fs.existsSync(bak)) {
        fs.unlinkSync(bak);
        this.logManager.addLog('info', '新核心已稳定运行，已删除旧核心备份', 'CoreUpdateService');
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * 新核心首启成功后启动"稳定观察期"：STABILITY_DWELL_MS 内无 'error' 才判定稳定 → 删旧备份、清待
   * 验证标记、恢复自动重启。期内若 'error' 触发 autoRollback 会先取消本计时器（备份仍在，可回滚）。
   */
  private startStabilityWatch(): void {
    if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
    const watching = this.pendingUpdateVersion;
    this.stabilityTimer = setTimeout(() => {
      this.stabilityTimer = null;
      if (this.pendingUpdateVersion !== watching) return; // 已被回滚/其它路径清除
      if (this.retainBackupOnStable) {
        this.logManager.addLog(
          'info',
          `新核心 ${watching} 已稳定运行 ${CoreUpdateService.STABILITY_DWELL_MS / 1000}s；原内核为第三方内核，保留其备份以便回滚`,
          'CoreUpdateService'
        );
      } else {
        this.logManager.addLog(
          'info',
          `新核心 ${watching} 已稳定运行 ${CoreUpdateService.STABILITY_DWELL_MS / 1000}s，删除旧核心备份`,
          'CoreUpdateService'
        );
        this.pruneBackup();
      }
      this.retainBackupOnStable = false;
      if (this.pendingFallbackTimer) clearTimeout(this.pendingFallbackTimer);
      this.pendingFallbackTimer = null;
      this.pendingUpdateVersion = null;
      this.proxyManager?.setAutoRestartSuppressed(false);
    }, CoreUpdateService.STABILITY_DWELL_MS);
  }

  /**
   * 更新后新核心"首次启动失败"时调用（由上层在 proxy 'error' 事件中触发）：回滚到备份核心并标记
   * 问题版本。返回 true 表示已回滚（调用方应以旧核心重启代理）。先清除待验证标记防重入/回滚循环。
   */
  async autoRollbackIfPendingUpdate(): Promise<boolean> {
    // 另一内核操作持锁（在线安装 / 更新 / 恢复随包 / 回滚 / 手动替换 / 立即应用 / 自动轮次在飞，或手动替换的选文件
    // 对话框开着）：此刻回滚会与之并发写同一核槽位与 .bak（并先于它放开换核门控）。故**推迟**而非丢弃：持锁方放锁时
    // afterCoreOpReleased 再跑本方法（持锁方若自行回滚 / 重新 arm，则经 disarm / arm 作废这次推迟）。报过错的新核不得被
    // 稳定观察判稳（会删 .bak）→ 撤稳定观察计时器；待验证闩与兜底计时器原样保留（PENDING_MAX_AGE 过期保护照常）。
    // 判定与下方 rollbackCore 的持闸之间无 await。
    if (this.isUpdating || this.coreOps > 0) {
      if (this.pendingUpdateVersion) {
        if (this.stabilityTimer) {
          clearTimeout(this.stabilityTimer);
          this.stabilityTimer = null;
        }
        this.rollbackDeferred = true;
        this.logManager.addLog(
          'warn',
          `新核心 ${this.pendingUpdateVersion} 报错，另一内核操作正在进行，待其结束后再自动回滚`,
          'CoreUpdateService'
        );
      }
      return false;
    }
    this.rollbackDeferred = false;
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
    if (this.pendingFallbackTimer) {
      clearTimeout(this.pendingFallbackTimer);
      this.pendingFallbackTimer = null;
    }
    const pending = this.pendingUpdateVersion;
    const pendingAge = Date.now() - this.pendingUpdateAt;
    this.pendingUpdateVersion = null;
    this.proxyManager?.setAutoRestartSuppressed(false); // 回滚后旧核心恢复正常自动重启
    if (!pending) return false;
    // 过期保护：距本次更新过久仍未成功运行，此刻的 error 多半与核心更新无关（如用户改了配置）→ 不回滚
    if (pendingAge > CoreUpdateService.PENDING_MAX_AGE_MS) {
      this.logManager.addLog(
        'info',
        `待验证版本 ${pending} 距更新已超 ${CoreUpdateService.PENDING_MAX_AGE_MS / 60000} 分钟仍未成功运行，本次错误不触发回滚`,
        'CoreUpdateService'
      );
      return false;
    }
    if (!this.hasBackup()) return false;
    this.logManager.addLog(
      'error',
      `新核心 ${pending} 启动失败，自动回滚到备份核心`,
      'CoreUpdateService'
    );
    try {
      await this.rollbackCore(); // 恢复 .bak → 现役（内部停代理 + 删备份 + 记录版本）
      this.markKnownBad(pending);
      return true;
    } catch (e) {
      this.logManager.addLog('error', `自动回滚失败: ${e}`, 'CoreUpdateService');
      return false;
    }
  }

  // --- 私有辅助方法 ---

  // 版本比较收口到 shared/version.compareSemver（与 UpdateService.isNewerVersion 共用单一权威）。
  // 保留薄包装：内部 3 处调用 this.compareVersions 签名不变，行为等价（容忍前导 v 与 -/+ 后缀）。
  private compareVersions(v1: string, v2: string): number {
    return compareSemver(v1, v2);
  }

  private getBackupPath(): string {
    // Windows: store backup in userData (user-writable), NOT in Program Files
    // macOS/Linux: keep it alongside the binary (we have write access there)
    if (process.platform === 'win32') {
      return path.join(app.getPath('userData'), 'sing-box.exe.bak');
    }
    // macOS 受保护目录 / Linux root 受管核目录都是 root-only，.bak 不能落那 → 统一放 userData（用户可写）；备份内容
    // 从 getSingBoxPath（受保护/受管核或 bundle，均可读）复制来。（Linux setcap 兜底态核在 userData 亦可读，一致。）
    if (process.platform === 'darwin' || process.platform === 'linux') {
      return path.join(app.getPath('userData'), 'core-backup', 'sing-box.bak');
    }
    return resourceManager.getSingBoxPath() + '.bak';
  }

  private async backupCurrentCore(): Promise<void> {
    const currentPath = resourceManager.getSingBoxPath();
    const backupPath = this.getBackupPath();
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });

    if (fs.existsSync(currentPath)) {
      if (process.platform === 'win32') {
        // On Windows copy to userData dir (no UAC needed)
        await this.copyFileElevatedWindows(currentPath, backupPath);
      } else {
        // 原子落位：先写同目录临时名，再 rename 覆盖。.bak 可能正被执行（设置页 getVersionInfo 的 `<.bak> version`），
        // 原地 copyFileSync（O_TRUNC 打开执行中的文件）→ ETXTBSY，安装 / 更新随之失败；rename 只替换目录项，执行中的
        // 进程继续持有旧 inode（同 ensureWritableCore 的 atomicCopy、installCoreFromDir 的 .flowz-new）。
        const tmp = `${backupPath}.tmp`;
        try {
          fs.copyFileSync(currentPath, tmp);
          fs.renameSync(tmp, backupPath);
        } catch (e) {
          try {
            fs.unlinkSync(tmp);
          } catch {
            /* 临时文件可能根本没建起来 */
          }
          throw e;
        }
      }
      this.logManager.addLog('info', `已备份当前核心到: ${backupPath}`, 'CoreUpdateService');
    }
  }

  /** 从 .bak 恢复现役核心。返回是否真的恢复了（无备份 / 写失败 → false；错误只记日志不抛，调用方多在 catch 内兜底）。 */
  private async restoreBackup(): Promise<boolean> {
    const backupPath = this.getBackupPath();
    if (!fs.existsSync(backupPath)) return false;
    try {
      // B 块 macOS（helper v5）：经 helper install-core 把 backup 写回受保护目录（与 rollbackCore 同源）。
      if (await this.isProtectedCoreActive()) {
        await this.installSingleCoreViaHelper(backupPath);
        this.logManager.addLog('info', '已从备份恢复核心（受保护目录）', 'CoreUpdateService');
        return true;
      }
      const currentPath = resourceManager.getSingBoxUpdateTargetPath();
      if (process.platform === 'win32') {
        await this.copyFileElevatedWindows(backupPath, currentPath);
      } else {
        fs.copyFileSync(backupPath, currentPath);
        fs.chmodSync(currentPath, 0o755);
      }
      this.logManager.addLog('info', '已从备份恢复核心', 'CoreUpdateService');
      return true;
    } catch {
      this.logManager.addLog('error', '恢复备份失败', 'CoreUpdateService');
      return false;
    }
  }

  /**
   * Windows 专用：通过 PowerShell 以管理员权限复制文件
   * 解决将文件写入 C:\Program Files (UAC 保护目录) 时的 EPERM 问题
   */
  private async copyFileElevatedWindows(src: string, dest: string): Promise<void> {
    // 恒经 PlatformPrivilegeService（index.ts 无条件注入）。旧内联 PowerShell RunAs 实现已删：它不可达，
    // 且缺 service 侧的两处加固（脚本落盘随机名 + 不盲杀同名 sing-box 进程）——留着=误触发即复现已修 bug。
    if (!this.privilegeService) {
      throw new Error('privilegeService 未注入：copyFileElevatedWindows 不可用');
    }
    return this.privilegeService.copyFileElevated(src, dest);
  }
}
