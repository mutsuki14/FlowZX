/**
 * 设置 · sing-box 内核管理卡（core-management-card.tsx）「选择版本」的纯决策逻辑：版本列表过滤 / 选项文案拆件 /
 * 动作按钮 / 确认理由 / 版本通道徽章 / 进度文案 / 错误码 → i18n 键（settings.coreManagement.*）。无 React / IPC
 * 依赖，node 环境单测（__tests__/singbox-version-logic.test.ts）。内核无关的部分在 core-version-logic.ts（与 Xray 卡
 * 共用），此处原名转出，卡片只需从本模块取。
 *
 * 语义约定（与主进程 CoreUpdateService.installTag / resetCoreToFactory / 自动更新轮次一致）：
 *  - 列表：主进程已剔除草稿 / 低于随包版本（= 最低可选版本）/ 无本平台资产者并按版本新→旧排好；开关关闭时隐藏预发布，
 *    但现役版本与随包版本恒可见（随包 1.14.0-rc.1 本身就是预发布）。
 *  - 「当前」= 现役内核报告的可比较版本与该 release 相同，且不是第三方（fork）构建——fork 同版本也允许用官方构建
 *    替换（与 Xray 卡「custom 永不算当前」同理）。unknown 构建按官方处理（主进程同样只拦 fork）。
 *  - 动作：current（已是当前，按钮置灰）/ restore（选中随包版本且现役不是它 → 走 resetFactory，本地落位无需下载）/
 *    install（其余：installTag 按 tag 在线下载安装）。
 *  - 确认理由（按此顺序展示；空数组 = 直接执行）：
 *      prerelease（预发布）/ crossBand（跨出随包版本的 major.minor 带，配置生成未针对它验证）/ downgrade（旧于现役）/
 *      knownBad（曾预检或首启失败）——以上仅 install；
 *      fork（会替换第三方内核：install 留 .bak 可回滚、需 force；restore 不留备份）/ staged（待生效的自动更新会作废）/
 *      autoUpdate（自动更新稍后会把它升到同带最新正式版：install 时对话框给「固定此版本」，即 pin；restore 走
 *      resetFactory 无从固定，只警示并提示先关自动更新）/ restart（代理在跑，切换会整体重启代理）。
 */
import { compareSemver, encodeMajorMinor, sameMajorMinor } from '../../../shared/version';
import { comparableCoreVersion, type CoreBuildKind } from '../../../shared/core-build';
import { extractLastFatal, stripAnsi } from '../../../shared/singbox-fatal';
import type {
  SingboxInstallErrorCode,
  SingboxInstallPhase,
  SingboxInstallProgress,
  SingboxRelease,
} from '../../../shared/singbox-release';
import {
  clipDetail,
  createErrorMessageKey,
  createPhaseKey,
  filterReleasesWith,
  releaseDate,
  sameVersion,
  type CoreOptionParts,
  type CoreReleaseLike,
} from './core-version-logic';

export {
  clipDetail,
  composeOptionLabel,
  isolateLtr,
  listErrorCode,
  pickSelection,
  progressBarPercent,
  releaseDate,
} from './core-version-logic';
export type { CoreOptionParts, CoreOptionSuffix } from './core-version-logic';

/**
 * 卡片状态的子集：getVersionInfo 结果可直接传入（currentVersion / build / bundledVersion）；stagedVersion 取
 * getAutoStatus().staged?.version，autoUpdateEnabled 取 getAutoStatus().autoUpdateEnabled（或 config.autoUpdateCore）。
 */
export interface SingboxStatusLike {
  /** 现役内核的可比较版本（如 `1.14.0-rc.1`）；未知为 '未知' / 空。 */
  currentVersion: string | null;
  build: CoreBuildKind;
  /** 随包版本 = 最低可选版本。 */
  bundledVersion: string;
  /** 自动更新已下载、待生效的版本；无 → null / 缺省。 */
  stagedVersion?: string | null;
  /** 自动更新是否开启；缺省按关闭。 */
  autoUpdateEnabled?: boolean;
}

export type SingboxReleaseAction = 'current' | 'restore' | 'install';
export type SingboxConfirmReason =
  | 'prerelease'
  | 'crossBand'
  | 'downgrade'
  | 'knownBad'
  | 'fork'
  | 'staged'
  | 'autoUpdate'
  | 'restart';

/** 徽章：cls 对应 conduit.css 的 `.pill.<cls>`，key 为 settings.coreManagement 下的 i18n 键。 */
export interface SingboxPill {
  cls: 'ok' | 'warn';
  key: string;
}

const I18N = 'settings.coreManagement';

/** 现役版本的可比较形（与主进程固定版本判定同口径）；'未知' / 空 / 非版本串 → null。 */
function currentComparable(status: SingboxStatusLike | null): string | null {
  const v = comparableCoreVersion(status?.currentVersion ?? '');
  return /^\d+\.\d+/.test(v) ? v : null;
}

/** 现役版本剥到官方形 X.Y.Z[-(alpha|beta|rc).N]：fork / dev 尾段（-reF1nd、-<commit>）不参与新旧比较。 */
function currentReleaseBase(status: SingboxStatusLike | null): string | null {
  const m = /^(\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?)/.exec(currentComparable(status) ?? '');
  return m ? m[1] : null;
}

/** 现役内核是否就是这个 release（fork 永不算「当前」，见头注）。 */
export function isActiveSingboxRelease(
  release: Pick<SingboxRelease, 'version'>,
  status: SingboxStatusLike | null
): boolean {
  return (
    !!status && status.build !== 'fork' && sameVersion(currentComparable(status), release.version)
  );
}

/** 是否为本版 FlowZX 随包的 sing-box 版本。 */
export function isBundledSingboxRelease(
  release: Pick<SingboxRelease, 'version'>,
  status: SingboxStatusLike | null
): boolean {
  return !!status && sameVersion(release.version, status.bundledVersion);
}

/** 跨带：版本的 major.minor 高于随包版本的（如随包 1.14.x 时的 1.15.0-alpha.12）。任一无法解析 → false。 */
export function crossBand(version: string, bundledVersion: string | null | undefined): boolean {
  if (!bundledVersion) return false;
  const v = encodeMajorMinor(version);
  const b = encodeMajorMinor(bundledVersion);
  return !Number.isNaN(v) && !Number.isNaN(b) && v > b;
}

/**
 * 下拉框可选的版本：只保留带本平台构建、非草稿、不低于随包版本的 release；开关关闭时隐藏预发布——现役版本与随包
 * 版本除外（否则随包的 rc 与用户装的 alpha 会从下拉框里消失）。保持入参顺序（主进程已按版本新→旧排好）。
 */
export function filterSingboxReleases(
  releases: readonly SingboxRelease[],
  includePrerelease: boolean,
  status: SingboxStatusLike | null
): SingboxRelease[] {
  return filterReleasesWith(
    releases,
    includePrerelease,
    (r) => isActiveSingboxRelease(r, status) || isBundledSingboxRelease(r, status)
  );
}

/** 下拉选项的组成部分（文案由组件用 composeOptionLabel 按 i18n 拼：「v1.15.0-alpha.12 · 2026-10-11（预发布）（跨版本带）」）。 */
export function optionParts(
  release: SingboxRelease,
  status: SingboxStatusLike | null
): Required<CoreOptionParts> {
  return {
    tag: `v${release.version}`,
    date: releaseDate(release.publishedAt),
    prerelease: release.prerelease,
    current: isActiveSingboxRelease(release, status),
    bundled: isBundledSingboxRelease(release, status),
    staged: sameVersion(status?.stagedVersion, release.version),
    crossBand: crossBand(release.version, status?.bundledVersion),
    knownBad: release.knownBad === true,
  };
}

/** 选中 release 的动作（见头注）。状态未取到时按 install 处理（组件在状态未取到时禁用按钮）。 */
export function singboxReleaseAction(
  release: SingboxRelease,
  status: SingboxStatusLike | null
): SingboxReleaseAction {
  if (isActiveSingboxRelease(release, status)) return 'current';
  if (isBundledSingboxRelease(release, status)) return 'restore';
  return 'install';
}

/** 最新正式版（按版本号取最大，不按列表 / API 顺序；草稿与预发布不算）；没有 → null。 */
export function latestStable<T extends CoreReleaseLike>(releases: readonly T[]): T | null {
  let best: T | null = null;
  for (const r of releases) {
    if (r.prerelease || r.draft) continue;
    if (!best || compareSemver(r.version, best.version) > 0) best = r;
  }
  return best;
}

/**
 * 自动更新开启时，装上 release 之后会被自动更新换成的版本；不会被换 → null。与主进程自动轮次同一规则：目标恒为
 * 「全部正式版里版本号最大者」，它曾验证失败则整轮跳过；只在它与现役（即装上后的 release）同 major.minor 且更新时才
 * 落位——跨带只提示不自动。故全局最新正式版在别的带时，同带里即使有更新的补丁也不会被自动换（主进程不回退去找次新）。
 */
export function autoUpdateSupersedes(
  release: Pick<SingboxRelease, 'version'>,
  releases: readonly SingboxRelease[],
  status: SingboxStatusLike | null
): string | null {
  if (status?.autoUpdateEnabled !== true) return null;
  const latest = latestStable(releases);
  if (!latest || latest.knownBad === true) return null;
  return sameMajorMinor(latest.version, release.version) &&
    compareSemver(latest.version, release.version) > 0
    ? latest.version
    : null;
}

/**
 * 执行前需要用户确认的理由（按头注顺序）；空数组 = 直接执行。releases 传主进程给的完整列表（不受预发布开关影响，
 * 用于推算自动更新目标）。
 */
export function singboxConfirms(
  release: SingboxRelease,
  releases: readonly SingboxRelease[],
  status: SingboxStatusLike | null,
  proxyRunning: boolean
): SingboxConfirmReason[] {
  const action = singboxReleaseAction(release, status);
  if (action === 'current') return [];
  const out: SingboxConfirmReason[] = [];
  if (action === 'install') {
    if (release.prerelease) out.push('prerelease');
    if (crossBand(release.version, status?.bundledVersion)) out.push('crossBand');
    const base = currentReleaseBase(status);
    if (base && compareSemver(release.version, base) < 0) out.push('downgrade');
    if (release.knownBad === true) out.push('knownBad');
  }
  if (status?.build === 'fork') out.push('fork');
  if (status?.stagedVersion && !sameVersion(status.stagedVersion, release.version)) {
    out.push('staged');
  }
  // 恢复随包同样会被自动更新升走（resetFactory 还会清掉固定）→ 一并警示；它无从固定，对话框只对 install 给「固定此版本」，
  // restore 用专属文案提示先关自动更新（confirmReasonKey）。
  if (autoUpdateSupersedes(release, releases, status)) out.push('autoUpdate');
  if (proxyRunning) out.push('restart');
  return out;
}

const CONFIRM_KEYS: Readonly<Record<SingboxConfirmReason, string>> = {
  prerelease: `${I18N}.confirmPrerelease`,
  crossBand: `${I18N}.confirmCrossBand`,
  downgrade: `${I18N}.confirmDowngrade`,
  knownBad: `${I18N}.confirmKnownBad`,
  fork: `${I18N}.confirmFork`,
  staged: `${I18N}.confirmStaged`,
  autoUpdate: `${I18N}.confirmAutoUpdate`,
  restart: `${I18N}.confirmRestart`,
};

/**
 * 理由 → i18n 键。恢复随包时两条用专属文案：fork（resetFactory 不留备份，第三方内核无从找回）、autoUpdate（无从固定，
 * 提示先关自动更新才能停在随包版本）。
 */
export function confirmReasonKey(
  reason: SingboxConfirmReason,
  action: SingboxReleaseAction = 'install'
): string {
  if (action === 'restore' && reason === 'fork') return `${I18N}.confirmForkReset`;
  if (action === 'restore' && reason === 'autoUpdate') return `${I18N}.confirmAutoUpdateReset`;
  return CONFIRM_KEYS[reason];
}

const RISK_REASONS: ReadonlySet<SingboxConfirmReason> = new Set<SingboxConfirmReason>([
  'prerelease',
  'crossBand',
  'downgrade',
  'knownBad',
  'fork',
]);

/** 确认按钮是否用「仍然安装」措辞（理由里有风险项；只有 staged / autoUpdate / restart 时是普通「安装」）。 */
export function confirmAnyway(reasons: readonly SingboxConfirmReason[]): boolean {
  return reasons.some((r) => RISK_REASONS.has(r));
}

/**
 * 确认后传给 installTag 的选项：force 只在用户确认过 fork 理由时给（主进程据此才覆盖第三方内核）；pin 只在出现
 * autoUpdate 理由且「固定此版本」勾选时给（pin:false 会清掉旧的固定）。
 */
export function installOptions(
  reasons: readonly SingboxConfirmReason[],
  pinChecked: boolean
): { force: boolean; pin: boolean } {
  return {
    force: reasons.includes('fork'),
    pin: pinChecked && reasons.includes('autoUpdate'),
  };
}

/** 当前版本行的通道徽章：随包 ok / 用户装的预发布 warn / 其余（在线装的正式版、fork、unknown、版本未知）不显示。 */
export function channelPill(status: SingboxStatusLike | null): SingboxPill | null {
  if (!status || status.build !== 'official') return null;
  const current = currentComparable(status);
  if (!current) return null;
  if (sameVersion(current, status.bundledVersion))
    return { cls: 'ok', key: `${I18N}.channelBundled` };
  if (/^\d+\.\d+\.\d+-(?:alpha|beta|rc)\.\d+$/.test(current)) {
    return { cls: 'warn', key: `${I18N}.channelPrerelease` };
  }
  return null;
}

/** sing-box 安装阶段全集（Record 键穷举：SingboxInstallPhase 增删时此处编译报错，提醒补 i18n）。 */
const PHASES: Readonly<Record<SingboxInstallPhase, true>> = {
  downloading: true,
  verifying: true,
  extracting: true,
  testing: true,
  switching: true,
  restarting: true,
};
export const SINGBOX_INSTALL_PHASES = Object.keys(PHASES) as readonly SingboxInstallPhase[];

/** sing-box 安装 / 恢复失败码全集（同上，SingboxInstallErrorCode 增删时编译报错）。 */
const ERROR_CODES: Readonly<Record<SingboxInstallErrorCode, true>> = {
  BUSY: true,
  XRAY_BUSY: true,
  PROXY_BUSY: true,
  INVALID_TAG: true,
  NOT_FOUND: true,
  RATE_LIMITED: true,
  NETWORK: true,
  DRAFT: true,
  NO_ASSET: true,
  BELOW_MINIMUM: true,
  NO_HASH: true,
  HASH_MISMATCH: true,
  DOWNLOAD_FAILED: true,
  EXTRACT_FAILED: true,
  VERSION_MISMATCH: true,
  NOT_OFFICIAL: true,
  EXEC_FAILED: true,
  PREFLIGHT_FAILED: true,
  GVISOR_MISSING: true,
  HELPER_REQUIRED: true,
  FORK_CONFIRM_REQUIRED: true,
  START_FAILED: true,
  START_BLOCKED: true,
  FAILED: true,
};
export const SINGBOX_INSTALL_ERROR_CODES = Object.keys(
  ERROR_CODES
) as readonly SingboxInstallErrorCode[];

const RESET_KIND: SingboxInstallProgress['kind'] = 'reset';
const singboxPhaseKey = createPhaseKey(I18N, SINGBOX_INSTALL_PHASES, RESET_KIND);
const singboxErrorKey = createErrorMessageKey(I18N, SINGBOX_INSTALL_ERROR_CODES);

/** 进度阶段 → i18n 键（settings.coreManagement.phase*；恢复随包版本的 switching 用 phaseRestoring）。 */
export function phaseKey(progress: Pick<SingboxInstallProgress, 'phase' | 'kind'>): string {
  return singboxPhaseKey(progress);
}

/**
 * 失败码 → i18n 键（settings.coreManagement.errors.*）。START_FAILED 且未能回滚 → START_FAILED_NO_ROLLBACK；
 * 未知 / 缺省 code → FAILED。listReleases 的 reject（error.code 为 RATE_LIMITED / NETWORK）与 resetFactory 的
 * code（BUSY / XRAY_BUSY）同样适用。
 */
export function errorMessageKey(code: unknown, rolledBack?: boolean): string {
  return singboxErrorKey(code, rolledBack);
}

const DETAIL_CODES: ReadonlySet<string> = new Set<SingboxInstallErrorCode>([
  'FAILED',
  'NETWORK',
  'DOWNLOAD_FAILED',
  'EXTRACT_FAILED',
  'VERSION_MISMATCH',
  'NOT_OFFICIAL',
  'PREFLIGHT_FAILED',
  'START_FAILED',
  'START_BLOCKED',
]);

/**
 * 这些失败码的主进程 detail 有额外信息（原始错误 / 实际版本 / `sing-box check` 输出），值得附在提示里；其余文案
 * 已足够（GVISOR_MISSING 等的 detail 只是中文说明，由各语言文案代替）。
 */
export function errorShowsDetail(code: unknown): boolean {
  return typeof code === 'string' && DETAIL_CODES.has(code);
}

/**
 * 附在失败提示里的 detail（不该附 → 空串）。detail 含 sing-box 日志时取最后一条 FATAL 行：1.15 起 `check` 会先打
 * WARN（如 TUN stack 弃用提示），按头截断会只剩 WARN、丢掉真正的失败原因。其余剥色码后截断。
 */
export function failureDetail(code: unknown, detail: string | undefined): string {
  if (!errorShowsDetail(code) || typeof detail !== 'string') return '';
  return clipDetail(extractLastFatal(detail) ?? stripAnsi(detail));
}
