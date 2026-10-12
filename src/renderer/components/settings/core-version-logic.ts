/**
 * 设置 · 内核「版本选择」的内核无关纯逻辑：Xray 卡（xray-version-logic.ts）与 sing-box 内核管理卡
 * （singbox-version-logic.ts）共用。无 React / IPC / i18n 前缀知识——各内核的差异（「当前」的判定、i18n 前缀、
 * 失败码 / 阶段集合、恢复随包的 progress.kind）由调用方以谓词 / 参数传入。node 环境单测经两个内核模块覆盖。
 */
import { compareSemver } from '../../../shared/version';

/** 两种内核 release 的结构子集（XrayRelease / SingboxRelease 均满足）。 */
export interface CoreReleaseLike {
  tag: string;
  version: string;
  prerelease: boolean;
  draft: boolean;
  publishedAt: string | null;
  /** 该 release 是否带本平台构建。 */
  hasAsset: boolean;
  /** 低于该内核的可选地板（Xray 最低支持版本 / sing-box 随包版本）：恒不列出。 */
  belowMinimum: boolean;
}

/** 两个版本号是否相同（任一为空 → false；compareSemver 口径：忽略前导 v 与 +build）。 */
export function sameVersion(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && compareSemver(a, b) === 0;
}

/**
 * 下拉框可选的版本：只保留带本平台构建、非草稿、不低于地板的 release；开关关闭时隐藏预发布——但 keepVisible
 * 命中者（如现役版本 / 随包版本）即使是预发布也保留，免得下拉框里找不到它们。保持入参顺序（主进程已按版本新→旧排好）。
 */
export function filterReleasesWith<T extends CoreReleaseLike>(
  releases: readonly T[],
  includePrerelease: boolean,
  keepVisible: (release: T) => boolean
): T[] {
  return releases.filter(
    (r) =>
      r.hasAsset &&
      !r.draft &&
      !r.belowMinimum &&
      (includePrerelease || !r.prerelease || keepVisible(r))
  );
}

/** 列表刷新 / 开关切换后的选中项：原选中仍在列表中则保留，否则选最新一项（列表为空 → 空串）。 */
export function pickSelection(filtered: readonly { tag: string }[], prevTag: string): string {
  if (prevTag && filtered.some((r) => r.tag === prevTag)) return prevTag;
  return filtered[0]?.tag ?? '';
}

/** ISO 时间串 → `YYYY-MM-DD`（与语言无关，GitHub published_at 为 UTC）；无法识别 → null。 */
export function releaseDate(publishedAt: string | null | undefined): string | null {
  if (typeof publishedAt !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(publishedAt);
  return m ? m[1] : null;
}

/**
 * 下拉选项的组成部分。staged / crossBand / knownBad 只有 sing-box 给出——可选，使 Xray 的五键结构保持不变。
 */
export interface CoreOptionParts {
  /** `v1.14.3` */
  tag: string;
  /** `2026-10-09`；无发布时间 → null */
  date: string | null;
  prerelease: boolean;
  current: boolean;
  bundled: boolean;
  /** 自动更新已下载、待生效的版本。 */
  staged?: boolean;
  /** 跨出随包版本的 major.minor 带（FlowZX 配置生成未针对它验证）。 */
  crossBand?: boolean;
  /** 曾预检 / 首启失败。 */
  knownBad?: boolean;
}

/** 各标记的文案（自带各语言的括号与空格，如 zh「（预发布）」/ en「 (pre-release)」）；可选标记缺文案则不显示。 */
export interface CoreOptionSuffix {
  prerelease: string;
  current: string;
  bundled: string;
  staged?: string;
  crossBand?: string;
  knownBad?: string;
}

/** 拼选项文案：`v1.15.0-alpha.12 · 2026-10-11（预发布）（跨版本带）`。标记顺序固定：预发布 / 当前 / 随包 / 待生效 / 跨带 / 问题版本。 */
export function composeOptionLabel(parts: CoreOptionParts, suffix: CoreOptionSuffix): string {
  const flag = (on: boolean | undefined, text: string | undefined): string =>
    on && text ? text : '';
  return [
    parts.tag,
    parts.date ? ` · ${parts.date}` : '',
    flag(parts.prerelease, suffix.prerelease),
    flag(parts.current, suffix.current),
    flag(parts.bundled, suffix.bundled),
    flag(parts.staged, suffix.staged),
    flag(parts.crossBand, suffix.crossBand),
    flag(parts.knownBad, suffix.knownBad),
  ].join('');
}

/** 进度条宽度：下载阶段按百分比（未知总长 → 0）；下载之后的阶段视为下载已完成（100）。 */
export function progressBarPercent(progress: { phase: string; percent?: number }): number {
  if (progress.phase !== 'downloading') return 100;
  const p = progress.percent;
  return typeof p === 'number' && Number.isFinite(p)
    ? Math.max(0, Math.min(100, Math.floor(p)))
    : 0;
}

/** 截断长 detail（按码点，不劈开代理对）。 */
export function clipDetail(detail: string | undefined, max = 240): string {
  const s = (detail ?? '').trim();
  const chars = Array.from(s);
  return chars.length <= max ? s : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/**
 * 把版本号这类 LTR 片段包成 Unicode 方向隔离段（LRI U+2066 … PDI U+2069），供插进译文显示。RTL 界面（fa）里，
 * `1.14.0-rc.1` 这种以数字开头、中间带连字符的版本号会被双向算法重排成 `rc.1-1.14.0`（实测设置卡截图）；
 * 隔离后按 LTR 原样显示。LTR 语言下两个控制符不可见、不占宽。空串原样返回（不插出一对孤立控制符）。
 */
export function isolateLtr(text: string): string {
  return text ? `⁦${text}⁩` : text;
}

/** 列表加载失败的 code（只区分限流与其它网络错误；listReleases 的 reject 经 IPC 透传 error.code）。 */
export function listErrorCode(error: unknown): 'RATE_LIMITED' | 'NETWORK' {
  return (error as { code?: unknown } | null)?.code === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'NETWORK';
}

/**
 * 失败码 → i18n 键工厂：`${prefix}.errors.<code>`。START_FAILED 且未能回滚（rolledBack === false）→
 * START_FAILED_NO_ROLLBACK；不在 codes 内 / 非字符串（含 `toString` 等原型键）→ FAILED。
 */
export function createErrorMessageKey(
  prefix: string,
  codes: readonly string[]
): (code: unknown, rolledBack?: boolean) => string {
  const known: ReadonlySet<string> = new Set(codes);
  return (code, rolledBack) => {
    if (code === 'START_FAILED' && rolledBack === false) {
      return `${prefix}.errors.START_FAILED_NO_ROLLBACK`;
    }
    return typeof code === 'string' && known.has(code)
      ? `${prefix}.errors.${code}`
      : `${prefix}.errors.FAILED`;
  };
}

/**
 * 进度阶段 → i18n 键工厂：`${prefix}.phase<Phase>`（首字母大写，如 phaseDownloading）。恢复随包版本
 * （progress.kind === restoreKind）的 switching 用专属文案 phaseRestoring；不在 phases 内的阶段 → phaseSwitching
 * （两种内核共用 downloading / verifying / extracting / testing / switching / restarting 这套阶段词）。
 */
export function createPhaseKey(
  prefix: string,
  phases: readonly string[],
  restoreKind: string
): (progress: { phase: string; kind?: string }) => string {
  const known: ReadonlySet<string> = new Set(phases);
  return (progress) => {
    if (progress.phase === 'switching' && progress.kind === restoreKind) {
      return `${prefix}.phaseRestoring`;
    }
    const phase = known.has(progress.phase) ? progress.phase : 'switching';
    return `${prefix}.phase${phase.charAt(0).toUpperCase()}${phase.slice(1)}`;
  };
}
