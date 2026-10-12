/**
 * 设置 · Xray 卡（xray-core-card.tsx）的纯决策逻辑：版本列表过滤 / 选项文案拆件 / 动作按钮 / 确认理由 /
 * 来源与运行态徽章 / 警示条 / 进度文案 / 错误码 → i18n 键。无 React / IPC 依赖，node 环境单测
 * （__tests__/xray-version-logic.test.ts）。
 *
 * 语义约定：
 *  - 「当前」= 现役二进制报告的版本与该 release 相同，且来源不是 custom（用户自放的文件不等同于官方发布，
 *    同版本也允许用官方构建替换它）。
 *  - 动作：current（已是当前，按钮置灰）/ switch（选中随包版本且现役不是随包 → 走 restoreBundled，无需下载）/
 *    install（其余：按 tag 在线下载安装）。
 *  - 确认理由：prerelease（预发布）/ downgrade（旧于随包版本）/ custom（会替换用户自放文件）/ restart（代理在跑，
 *    切换会整体重启代理）。为空则直接执行。
 *
 * 内核无关的部分（选中保持 / 日期 / 选项拼接 / 进度条 / detail 截断 / 列表错误码 / 错误码与阶段键工厂）在
 * core-version-logic.ts，与 sing-box 内核管理卡共用；此处原名转出，导出与行为不变。
 */
import { compareSemver } from '../../../shared/version';
import type {
  XrayInstallErrorCode,
  XrayInstallPhase,
  XrayInstallProgress,
  XrayRelease,
  XraySource,
} from '../../../shared/xray-release';
import {
  createErrorMessageKey,
  createPhaseKey,
  filterReleasesWith,
  releaseDate,
} from './core-version-logic';

export {
  clipDetail,
  composeOptionLabel,
  listErrorCode,
  pickSelection,
  progressBarPercent,
  releaseDate,
} from './core-version-logic';

/** getXrayStatus 结果的子集（整份 IPC 结果可直接传入；本模块只读这些字段）。 */
export interface XrayStatusLike {
  available: boolean;
  version: string | null;
  running: boolean;
  nodes: number;
  source: XraySource;
  bundledVersion: string;
  minVersion: string;
  belowMinimum: boolean;
  tag?: string;
  prerelease?: boolean;
}

export type XrayReleaseAction = 'current' | 'install' | 'switch';
export type XrayConfirmReason = 'prerelease' | 'downgrade' | 'custom' | 'restart';
export type XrayStatusNoteKind = 'custom' | 'belowMinimum' | 'olderThanBundled';

/** 徽章：cls 对应 conduit.css 的 `.pill.<cls>`，key 为 settings.xrayCore 下的 i18n 键。 */
export interface XrayPill {
  cls: 'ok' | 'info' | 'warn' | 'idle';
  key: string;
}

const I18N = 'settings.xrayCore';

/** 现役二进制是否就是这个 release（custom 文件永不算「当前」，见头注）。 */
export function isActiveRelease(release: XrayRelease, status: XrayStatusLike | null): boolean {
  if (!status || !status.available || !status.version || status.source === 'custom') return false;
  return compareSemver(status.version, release.version) === 0;
}

/** 是否为本版 FlowZX 随包的 Xray 版本。 */
export function isBundledRelease(release: XrayRelease, bundledVersion: string | null): boolean {
  return !!bundledVersion && compareSemver(release.version, bundledVersion) === 0;
}

/**
 * 下拉框可选的版本：只保留带本平台构建的 release；开关关闭时隐藏预发布——但现役版本即使是预发布也保留，
 * 免得下拉框里找不到「当前」。保持入参顺序（主进程已按版本新→旧排好）。
 */
export function filterReleases(
  releases: readonly XrayRelease[],
  includePrerelease: boolean,
  status: XrayStatusLike | null
): XrayRelease[] {
  return filterReleasesWith(releases, includePrerelease, (r) => isActiveRelease(r, status));
}

export interface XrayOptionParts {
  /** `v26.10.10` */
  tag: string;
  /** `2026-10-10`；无发布时间 → null */
  date: string | null;
  prerelease: boolean;
  current: boolean;
  bundled: boolean;
}

/**
 * 下拉选项的组成部分（文案由组件按 i18n 拼：「v26.10.10 · 2026-10-10（预发布）（当前）」，见 composeOptionLabel）。
 * 恰好这五个键：sing-box 专有的 staged / crossBand / knownBad 标记 Xray 不给出。
 */
export function optionLabelParts(
  release: XrayRelease,
  status: XrayStatusLike | null
): XrayOptionParts {
  return {
    tag: `v${release.version}`,
    date: releaseDate(release.publishedAt),
    prerelease: release.prerelease,
    current: isActiveRelease(release, status),
    bundled: isBundledRelease(release, status?.bundledVersion ?? null),
  };
}

/** 选中 release 的动作（见头注）。状态未取到时按 install 处理（组件在状态未取到时禁用按钮）。 */
export function releaseAction(
  release: XrayRelease,
  status: XrayStatusLike | null
): XrayReleaseAction {
  if (isActiveRelease(release, status)) return 'current';
  if (status && status.source !== 'bundled' && isBundledRelease(release, status.bundledVersion)) {
    return 'switch';
  }
  return 'install';
}

/** 执行前需要用户确认的理由（按展示顺序）；空数组 = 直接执行。 */
export function confirmsNeeded(
  release: XrayRelease,
  status: XrayStatusLike | null,
  proxyRunning: boolean
): XrayConfirmReason[] {
  const action = releaseAction(release, status);
  if (action === 'current') return [];
  const out: XrayConfirmReason[] = [];
  if (action === 'install') {
    if (release.prerelease) out.push('prerelease');
    if (status && compareSemver(release.version, status.bundledVersion) < 0) out.push('downgrade');
  }
  if (status?.source === 'custom') out.push('custom');
  if (proxyRunning) out.push('restart');
  return out;
}

/** 「恢复随包版本」确认框里追加的理由（恢复本身总要确认，此处只给附加说明）。 */
export function restoreConfirms(
  status: XrayStatusLike | null,
  proxyRunning: boolean
): XrayConfirmReason[] {
  const out: XrayConfirmReason[] = [];
  if (status?.source === 'custom') out.push('custom');
  if (proxyRunning) out.push('restart');
  return out;
}

/** 理由 → i18n 键。 */
export function confirmReasonKey(reason: XrayConfirmReason): string {
  switch (reason) {
    case 'prerelease':
      return `${I18N}.confirmPrerelease`;
    case 'downgrade':
      return `${I18N}.confirmDowngrade`;
    case 'custom':
      return `${I18N}.confirmCustom`;
    case 'restart':
      return `${I18N}.confirmRestart`;
  }
}

/** 运行态徽章：缺失 warn / 运行中 ok（带节点数）/ 未运行 idle。 */
export function runStatePill(status: XrayStatusLike): XrayPill & { n?: number } {
  if (!status.available) return { cls: 'warn', key: `${I18N}.missing` };
  if (status.running) {
    const n = Number.isFinite(status.nodes) && status.nodes > 0 ? Math.floor(status.nodes) : 0;
    return { cls: 'ok', key: `${I18N}.running`, n };
  }
  return { cls: 'idle', key: `${I18N}.idle` };
}

/** 来源徽章：随包 ok / 在线安装 info / 在线安装的预发布 warn / 自定义文件 idle。 */
export function sourcePill(status: XrayStatusLike): XrayPill {
  switch (status.source) {
    case 'downloaded':
      return status.prerelease
        ? { cls: 'warn', key: `${I18N}.sourcePrerelease` }
        : { cls: 'info', key: `${I18N}.sourceDownloaded` };
    case 'custom':
      return { cls: 'idle', key: `${I18N}.sourceCustom` };
    default:
      return { cls: 'ok', key: `${I18N}.sourceBundled` };
  }
}

/**
 * 当前版本下方的警示条：custom（自放文件会被在线安装替换）/ belowMinimum（低于最低支持版本，安全字段被静默忽略）/
 * olderThanBundled（在线安装的版本旧于随包——多见于 App 升级后）。
 */
export function statusNotes(status: XrayStatusLike | null): XrayStatusNoteKind[] {
  if (!status) return [];
  const out: XrayStatusNoteKind[] = [];
  if (status.source === 'custom') out.push('custom');
  if (status.belowMinimum) out.push('belowMinimum');
  if (
    status.source === 'downloaded' &&
    status.version &&
    compareSemver(status.version, status.bundledVersion) < 0
  ) {
    out.push('olderThanBundled');
  }
  return out;
}

/** Xray 安装阶段全集（Record 键穷举：XrayInstallPhase 增删时此处编译报错，提醒补 i18n）。 */
const XRAY_PHASES: Readonly<Record<XrayInstallPhase, true>> = {
  downloading: true,
  verifying: true,
  extracting: true,
  testing: true,
  switching: true,
  restarting: true,
};
const RESTORE_KIND: XrayInstallProgress['kind'] = 'restore';
const xrayPhaseKey = createPhaseKey(I18N, Object.keys(XRAY_PHASES), RESTORE_KIND);

/** 进度阶段 → i18n 键（恢复随包版本的 switching 用专属文案）。 */
export function phaseKey(progress: Pick<XrayInstallProgress, 'phase' | 'kind'>): string {
  return xrayPhaseKey(progress);
}

const KNOWN_CODES: readonly XrayInstallErrorCode[] = [
  'BUSY',
  'PROXY_BUSY',
  'CORE_BUSY',
  'INVALID_TAG',
  'NOT_FOUND',
  'RATE_LIMITED',
  'NETWORK',
  'DRAFT',
  'NO_ASSET',
  'BELOW_MINIMUM',
  'NO_HASH',
  'HASH_MISMATCH',
  'DOWNLOAD_FAILED',
  'EXTRACT_FAILED',
  'VERSION_MISMATCH',
  'CONFIG_TEST_FAILED',
  'IN_USE',
  'START_FAILED',
  'FAILED',
];
const xrayErrorKey = createErrorMessageKey(I18N, KNOWN_CODES);

/**
 * 失败码 → i18n 键（settings.xrayCore.errors.*）。START_FAILED 且未能回滚 → START_FAILED_NO_ROLLBACK；
 * 未知 / 缺省 code → FAILED。listReleases 的 reject（error.code 为 RATE_LIMITED / NETWORK）同样适用。
 */
export function errorMessageKey(code: unknown, rolledBack?: boolean): string {
  return xrayErrorKey(code, rolledBack);
}

/** 这些失败码的主进程 detail 有额外信息（原始错误 / 实际版本），值得附在提示里；其余文案已足够。 */
export function errorShowsDetail(code: unknown): boolean {
  return (
    code === 'FAILED' ||
    code === 'NETWORK' ||
    code === 'DOWNLOAD_FAILED' ||
    code === 'EXTRACT_FAILED' ||
    code === 'VERSION_MISMATCH' ||
    code === 'START_FAILED'
  );
}

const XRAY_BANNER_RE = /^Xray \d+\.\d+\.\d+\b/;
const XRAY_TAGLINE_RE = /^A unified platform for anti-censorship/i;
/** Xray 自身的 Info / Debug 日志行（如 `2026/10/11 03:14:21.847919 [Info] infra/conf/serial: Reading config…`）。 */
const XRAY_INFO_LOG_RE = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)? \[(?:Info|Debug)\]/;

/**
 * `xray run -test` 失败输出（主进程给的是 stdout+stderr 末尾 2000 字符）→ 只留真正的错误行：去掉版本横幅、
 * 标语与 Info/Debug 日志，取最后 maxLines 行。全被过滤掉时回落原文（去首尾空白）。
 */
export function summarizeConfigTestDetail(detail: string | undefined, maxLines = 6): string {
  const raw = (detail ?? '').replace(/^…/, '').trim();
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(
      (l) =>
        l.trim() !== '' &&
        !XRAY_BANNER_RE.test(l) &&
        !XRAY_TAGLINE_RE.test(l) &&
        !XRAY_INFO_LOG_RE.test(l)
    );
  return lines.length > 0 ? lines.slice(-maxLines).join('\n') : raw;
}
