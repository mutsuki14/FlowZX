/**
 * Xray 内核「版本选择」的纯逻辑与跨进程契约（主进程 XrayCoreUpdateService / IPC / 渲染端设置卡共用）。
 *
 * 背景（详见 docs/XRAY.md）：随包 Xray 由 core-manifest.json 的 bundledXrayVersion 钉死；用户可在设置页从 XTLS
 * 官方 GitHub Releases 选择其它版本（含预发布）在线安装到 `<userData>/xray_core/xray[.exe]`（与手动放入同一槽位）。
 *  - Xray tag 形如 `vYY.M.D`，compareSemver 可正确排序（26.10.10 > 26.3.27）；
 *  - 预发布只能看 GitHub API 的 `prerelease` 标志（tag 本身是纯数字），故与 tag 分开存；
 *  - 每个 `<asset>.zip` 都附 `<asset>.zip.dgst`（含一行 `SHA2-256= <hex>`），是 API `digest` 缺席时的摘要来源；
 *  - 低于 minXrayVersion 的版本会**静默忽略** FlowZX 生成的安全字段（Xray 对未知键不报错），故永不提供、拒装。
 *
 * 纯模块：不 import electron/node，可在渲染端直接使用。
 */
import { compareSemver } from './version';

/** 已打包架构 → XTLS release 资产名（scripts/fetch-core.mjs 的 XRAY_TARGETS 是 .mjs 无法 import，另持一份，须同步）。 */
export const XRAY_ASSET_BY_PLATFORM: Readonly<Record<string, string>> = {
  'win32-x64': 'Xray-windows-64.zip',
  'win32-arm64': 'Xray-windows-arm64-v8a.zip',
  'darwin-x64': 'Xray-macos-64.zip',
  'darwin-arm64': 'Xray-macos-arm64-v8a.zip',
  'linux-x64': 'Xray-linux-64.zip',
  'linux-arm64': 'Xray-linux-arm64-v8a.zip',
};

/** 平台/架构 → 资产名；未打包的组合（如 linux-ia32）返回 null（UI 据 hasAsset 禁用安装）。 */
export function xrayAssetName(platform: string, arch: string): string | null {
  return XRAY_ASSET_BY_PLATFORM[`${platform}-${arch}`] ?? null;
}

/** 现役槽位 / 压缩包内的可执行文件名（killOrphan 按进程名 `xray(.exe)` 确认，故绝不改名）。 */
export function xrayBinaryName(platform: string): 'xray.exe' | 'xray' {
  return platform === 'win32' ? 'xray.exe' : 'xray';
}

/** 合法 tag：`v?X.Y.Z`（纯数字三段；不接受任意字符串进入 URL 拼接）。 */
export const XRAY_TAG_RE = /^v?\d+\.\d+\.\d+$/;

/** tag → 版本号（去 `v`）；形状不符返回 null。 */
export function xrayTagVersion(tag: unknown): string | null {
  if (typeof tag !== 'string') return null;
  const t = tag.trim();
  return XRAY_TAG_RE.test(t) ? t.replace(/^v/i, '') : null;
}

/**
 * 解析 `<asset>.dgst`：取 `SHA2-256= <64 hex>` 行 → 小写 hex。缺行 / 非 64 位 hex → null（调用方 fail-closed）。
 * 实测格式（v26.10.10 Xray-linux-64.zip.dgst）为四行 `MD5= … / SHA1= … / SHA2-256= … / SHA2-512= …`。
 */
export function parseXrayDgst(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const m = /^[ \t]*SHA2-256[ \t]*=[ \t]*([0-9a-fA-F]{64})[ \t]*\r?$/m.exec(text);
  return m ? m[1].toLowerCase() : null;
}

/** 渲染端可见的单个 release（不含下载 URL / 摘要——安装时由主进程按 tag 现取，渲染端只回传 tag）。 */
export interface XrayRelease {
  /** GitHub tag_name 原值（如 `v26.10.10`）。 */
  tag: string;
  /** 去 `v` 的版本号（如 `26.10.10`）。 */
  version: string;
  /** release 标题（缺省回落 tag）。 */
  name: string;
  /** GitHub `prerelease` 标志（Xray 的预发布 tag 是纯数字，只能看此标志）。 */
  prerelease: boolean;
  draft: boolean;
  /** ISO 时间串；缺失为 null。 */
  publishedAt: string | null;
  /** 发行说明页（恒为 https://github.com/XTLS/Xray-core/… ，渲染端 openExternal 安全）。 */
  htmlUrl: string;
  /** 本平台资产名（未打包的平台为 null）。 */
  assetName: string | null;
  /** 该 release 是否带本平台资产。 */
  hasAsset: boolean;
  /** 是否低于 minXrayVersion（列表恒剔除；install 拒装）。 */
  belowMinimum: boolean;
}

const XRAY_RELEASES_PAGE = 'https://github.com/XTLS/Xray-core/releases/';

/**
 * GitHub release JSON → XrayRelease。tag 不是 `v?X.Y.Z` 形状（或整体非对象）返回 null。
 * htmlUrl 只接受 XTLS/Xray-core 的 github.com 页面，否则按 tag 重建——渲染端会把它交给 openExternal。
 */
export function normalizeXrayRelease(
  raw: unknown,
  platform: string,
  arch: string,
  minVersion: string
): XrayRelease | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const tag = typeof r.tag_name === 'string' ? r.tag_name.trim() : '';
  const version = xrayTagVersion(tag);
  if (!version) return null;
  const assetName = xrayAssetName(platform, arch);
  const assets = Array.isArray(r.assets) ? r.assets : [];
  const hasAsset =
    !!assetName && assets.some((a) => !!a && (a as { name?: unknown }).name === assetName);
  const rawHtml = typeof r.html_url === 'string' ? r.html_url : '';
  const htmlUrl = rawHtml.startsWith(XRAY_RELEASES_PAGE)
    ? rawHtml
    : `${XRAY_RELEASES_PAGE}tag/${tag}`;
  const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : tag;
  return {
    tag,
    version,
    name,
    prerelease: r.prerelease === true,
    draft: r.draft === true,
    publishedAt: typeof r.published_at === 'string' && r.published_at ? r.published_at : null,
    htmlUrl,
    assetName,
    hasAsset,
    belowMinimum: compareSemver(version, minVersion) < 0,
  };
}

/** 可供选择的 release：剔除非法 tag / 草稿 / 低于最低版本，按版本号新→旧排序（同版本保留首个）。 */
export function listableXrayReleases(
  raws: unknown,
  platform: string,
  arch: string,
  minVersion: string
): XrayRelease[] {
  if (!Array.isArray(raws)) return [];
  const seen = new Set<string>();
  const out: XrayRelease[] = [];
  for (const raw of raws) {
    const rel = normalizeXrayRelease(raw, platform, arch, minVersion);
    if (!rel || rel.draft || rel.belowMinimum || seen.has(rel.version)) continue;
    seen.add(rel.version);
    out.push(rel);
  }
  return out.sort((a, b) => compareSemver(b.version, a.version));
}

/** 现役 Xray 来源：随包 / 应用内在线安装（槽位二进制与 marker 哈希一致）/ 用户自行放入的文件。 */
export type XraySource = 'bundled' | 'downloaded' | 'custom';

/** 来源详情（downloaded 时附 marker 中记录的 tag / 预发布标志 / 安装时间）。 */
export interface XraySourceInfo {
  source: XraySource;
  tag?: string;
  prerelease?: boolean;
  installedAt?: string;
}

/** 安装阶段（渲染端据此显示文案；percent 仅 downloading 阶段有意义）。 */
export type XrayInstallPhase =
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'testing'
  | 'switching'
  | 'restarting';

/** 进行中的安装/恢复进度（主进程持有：设置卡卸载重挂后经 getInstallState 找回）。 */
export interface XrayInstallProgress {
  /** 目标 tag（restore 时为随包版本 `v<bundled>`）。 */
  tag: string;
  phase: XrayInstallPhase;
  /** 0-100；仅下载阶段且已知总长时给出。 */
  percent?: number;
  /** install = 在线安装；restore = 恢复随包版本。 */
  kind: 'install' | 'restore';
}

/** EVENT_XRAY_CORE_INSTALL_PROGRESS 载荷：进度快照；null = 本次操作已结束（渲染端据此刷新状态）。 */
export type XrayInstallProgressEvent = XrayInstallProgress | null;

export interface XrayInstallState {
  installing: XrayInstallProgress | null;
}

/** listReleases 结果（列表已剔除草稿与低于最低版本者；是否显示预发布由渲染端按开关过滤）。 */
export interface XrayReleaseList {
  releases: XrayRelease[];
  /** 列表取自 GitHub 的时间（ms epoch；主进程缓存 10 分钟，force 绕过）。 */
  fetchedAt: number;
  bundledVersion: string;
  minVersion: string;
}

/** listReleases 抛出的错误 code（经 IPC ApiResponse.code 透传到渲染端 error.code）。 */
export type XrayListErrorCode = 'RATE_LIMITED' | 'NETWORK';

/** install / restoreBundled 失败码（渲染端 errorMessageKey 映射文案）。 */
export type XrayInstallErrorCode =
  | 'BUSY' // 已有安装/恢复在进行
  | 'PROXY_BUSY' // 代理正在启动/停止/重启
  | 'CORE_BUSY' // sing-box 内核更新（或另一换核窗口）正在进行，两者互斥
  | 'INVALID_TAG'
  | 'NOT_FOUND' // GitHub 无此 tag
  | 'RATE_LIMITED'
  | 'NETWORK'
  | 'DRAFT'
  | 'NO_ASSET' // 该 release 无本平台资产
  | 'BELOW_MINIMUM'
  | 'NO_HASH' // 既无 API digest 也取不到 .dgst
  | 'HASH_MISMATCH'
  | 'DOWNLOAD_FAILED'
  | 'EXTRACT_FAILED'
  | 'VERSION_MISMATCH' // 解出的 `xray version` 与 tag 不符
  | 'CONFIG_TEST_FAILED' // 新内核 `run -test` 当前配置失败（可 force 重试）
  | 'IN_USE' // Windows：xray.exe 被占用（如测速临时会话）
  | 'START_FAILED' // 切换后代理起不来（已回滚到原内核）
  | 'FAILED'; // 其它异常（detail 为原始错误）

export type XrayInstallResult =
  | { ok: true; version: string; tag: string; prerelease: boolean; restarted: boolean }
  | { ok: false; code: XrayInstallErrorCode; detail?: string; rolledBack?: boolean };

export type XrayRestoreResult =
  | { ok: true; restarted: boolean }
  | { ok: false; code: XrayInstallErrorCode; detail?: string; rolledBack?: boolean };
