/**
 * sing-box 主内核「版本选择」的纯逻辑与跨进程契约（主进程 CoreUpdateService / IPC / 渲染端内核管理卡共用）。
 *
 * 背景：随包 sing-box 由 core-manifest.json 的 bundledCoreVersion 钉死；用户可在设置页从 SagerNet 官方 GitHub
 * Releases 选择其它版本（含预发布）在线安装（与「检查更新」同一落位链：预检 → 备份 → 换核 → 首启验证 / 回滚）。
 *  - sing-box tag 形如 `v1.14.3` / `v1.15.0-alpha.12`，compareSemver 可正确排序（alpha < beta < rc < 正式）；
 *  - 预发布：API 的 `prerelease` 标志 **或** tag 带 -alpha/-beta/-rc 后缀（两者任一即算，后缀是可离线验证的硬信号）；
 *  - 上游**不发布** .dgst / checksums：API asset.digest 是唯一摘要来源（缺席 → 拒装）；
 *  - **最低可选版本 = 随包版本**（动态取 manifest，不硬编码）：更旧的官方核会被 decideCoreOverride 在下次连接 /
 *    启动时静默刷回随包核（1.13.x 还不认 FlowZX 生成的 1.14 字段），提供即是空头支票，故列表剔除、安装拒绝。
 *
 * 纯模块：不 import electron/node，可在渲染端直接使用。
 */
import { compareSemver } from './version';
import type { CoreBuildKind } from './core-build';

/**
 * 合法 tag：`v?X.Y.Z` 或 `v?X.Y.Z-(alpha|beta|rc).N`（与 core-build 的官方版本形态同一文法）。
 * 不接受任意字符串进入 URL 拼接（`../`、`?`、空白等一律不匹配）。捕获组 1 = 去 `v` 的版本号。
 */
export const SINGBOX_TAG_RE = /^v?(\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?)$/;

/** tag → 版本号（去 `v`）；形状不符（或非字符串）返回 null。 */
export function singboxTagVersion(tag: unknown): string | null {
  if (typeof tag !== 'string') return null;
  const m = SINGBOX_TAG_RE.exec(tag.trim());
  return m ? m[1] : null;
}

/**
 * 已打包平台/架构 → 官方资产名后缀（与 scripts/fetch-core.mjs 的 TARGETS 同一组精确名，.mjs 无法 import，另持一份，须同步）。
 * 刻意只认这四个：同一 release 还有 -glibc / -musl / -legacy-* / arm64 等变体，它们与随包构建不同（如 -glibc 是 CGO 动态链接、
 * 不带 libcronet），绝不能被挑中。
 */
export const SINGBOX_ASSET_SUFFIX_BY_PLATFORM: Readonly<Record<string, string>> = {
  'win32-x64': 'windows-amd64.zip',
  'darwin-x64': 'darwin-amd64.tar.gz',
  'darwin-arm64': 'darwin-arm64.tar.gz',
  'linux-x64': 'linux-amd64.tar.gz',
};

/**
 * 版本 + 平台/架构 → 精确资产名（如 `sing-box-1.14.3-linux-amd64.tar.gz`）。
 * 未打包的组合（如 linux-arm64、win32-arm64）或版本号形状不符 → null（调用方据此报 NO_ASSET）。
 */
export function singboxAssetName(version: string, platform: string, arch: string): string | null {
  const v = singboxTagVersion(version);
  const suffix = SINGBOX_ASSET_SUFFIX_BY_PLATFORM[`${platform}-${arch}`];
  return v && suffix ? `sing-box-${v}-${suffix}` : null;
}

/**
 * 解析 `sing-box version` 完整输出里的 `Tags:` 行 → 构建 tag 列表（如 with_gvisor / with_purego）。
 * 没有 Tags 行（输出格式未知）→ null：调用方视为「无从判断」，不据此拒装。
 * 实测：1.15.0-alpha.11 起官方构建不再含 with_gvisor（TUN stack gvisor / mixed 运行期才报错，`check` 照过）。
 */
export function parseSingboxBuildTags(versionOutput: unknown): string[] | null {
  if (typeof versionOutput !== 'string') return null;
  const m = /^[ \t]*Tags:[ \t]*(.*?)[ \t]*\r?$/m.exec(versionOutput);
  if (!m) return null;
  return m[1]
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

/** 发布通道（只看 tag 后缀；纯 X.Y.Z 为 stable）。 */
export type SingboxChannel = 'stable' | 'rc' | 'beta' | 'alpha';

/** 版本号 → 通道（-alpha.N / -beta.N / -rc.N；其余 stable）。 */
export function singboxChannel(version: string): SingboxChannel {
  const m = /-(alpha|beta|rc)\.\d+$/.exec(version);
  return m ? (m[1] as SingboxChannel) : 'stable';
}

/**
 * 现役 sing-box 版本的简短标注（「报告问题」预填正文与诊断报告共用；中文，与 zh-CN settings.coreManagement 的
 * channelBundled / channelPrerelease / sourceFork 同词）：
 *  - 第三方（fork）构建 → 只标「第三方」（其版本号截断了 fork 尾段，与随包 / 预发布比较无意义）；
 *  - 就是本版 FlowZX 随包的版本 →「随包」；否则带 -alpha/-beta/-rc.N →「预发布」；
 *  - 固定的正是这个版本 →「已固定」（自动更新暂停中）。
 * 比较取官方形 X.Y.Z[-(alpha|beta|rc).N]（剥前导 v；dev 构建的 -<commit> 尾段不计）。版本未知 / 非版本串 → []。
 */
export function singboxChannelLabels(
  version: string | null | undefined,
  opts: {
    build?: CoreBuildKind | null;
    bundledVersion?: string | null;
    pinnedVersion?: string | null;
  } = {}
): string[] {
  const m = /^v?(\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?)/.exec(
    typeof version === 'string' ? version.trim() : ''
  );
  if (!m) return [];
  if (opts.build === 'fork') return ['第三方'];
  const base = m[1];
  const same = (other: string | null | undefined): boolean =>
    typeof other === 'string' &&
    /^v?\d+\.\d+\.\d+/.test(other.trim()) &&
    compareSemver(base, other.trim()) === 0;
  const out: string[] = [];
  if (same(opts.bundledVersion)) out.push('随包');
  else if (singboxChannel(base) !== 'stable') out.push('预发布');
  if (same(opts.pinnedVersion)) out.push('已固定');
  return out;
}

/** 渲染端可见的单个 release（不含下载 URL / 摘要——安装时由主进程按 tag 现取，渲染端只回传 tag）。 */
export interface SingboxRelease {
  /** GitHub tag_name 原值（如 `v1.14.3`）。 */
  tag: string;
  /** 去 `v` 的版本号（如 `1.14.3`）。 */
  version: string;
  /** release 标题（缺省回落 tag）。 */
  name: string;
  /** 预发布：GitHub `prerelease` 标志或 tag 带 -alpha/-beta/-rc 后缀。 */
  prerelease: boolean;
  /** 由 tag 后缀推出的通道（纯 X.Y.Z → stable）。 */
  channel: SingboxChannel;
  draft: boolean;
  /** ISO 时间串；缺失为 null。 */
  publishedAt: string | null;
  /** 发行说明页（恒为 https://github.com/SagerNet/sing-box/releases/… ，渲染端 openExternal 安全）。 */
  htmlUrl: string;
  /** 本平台资产名（未打包的平台为 null）。 */
  assetName: string | null;
  /** 该 release 是否带本平台资产。 */
  hasAsset: boolean;
  /** 是否低于随包版本（列表恒剔除；installTag 拒装）。 */
  belowMinimum: boolean;
  /** 曾预检 / 首启失败（core-known-bad.json）。由 listReleases 每次现算附上，纯函数不产出。 */
  knownBad?: boolean;
}

const SINGBOX_RELEASES_PAGE = 'https://github.com/SagerNet/sing-box/releases/';

/**
 * GitHub release JSON → SingboxRelease。tag 不是合法形状（或整体非对象）返回 null。
 * htmlUrl 只接受 SagerNet/sing-box 的 github.com 页面，否则按 tag 重建——渲染端会把它交给 openExternal。
 * @param bundledVersion 随包版本 = 最低可选版本（低于它 → belowMinimum）
 */
export function normalizeSingboxRelease(
  raw: unknown,
  platform: string,
  arch: string,
  bundledVersion: string
): SingboxRelease | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const tag = typeof r.tag_name === 'string' ? r.tag_name.trim() : '';
  const version = singboxTagVersion(tag);
  if (!version) return null;
  const channel = singboxChannel(version);
  const assetName = singboxAssetName(version, platform, arch);
  const assets = Array.isArray(r.assets) ? r.assets : [];
  const hasAsset =
    !!assetName && assets.some((a) => !!a && (a as { name?: unknown }).name === assetName);
  const rawHtml = typeof r.html_url === 'string' ? r.html_url : '';
  const htmlUrl = rawHtml.startsWith(SINGBOX_RELEASES_PAGE)
    ? rawHtml
    : `${SINGBOX_RELEASES_PAGE}tag/${tag}`;
  const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : tag;
  return {
    tag,
    version,
    name,
    prerelease: r.prerelease === true || channel !== 'stable',
    channel,
    draft: r.draft === true,
    publishedAt: typeof r.published_at === 'string' && r.published_at ? r.published_at : null,
    htmlUrl,
    assetName,
    hasAsset,
    belowMinimum: compareSemver(version, bundledVersion) < 0,
  };
}

/**
 * 可供选择的 release：剔除非法 tag / 草稿 / 低于随包版本 / 无本平台资产，按版本号新→旧排序（同版本保留首个）。
 * 上游多分支交错发布（1.13.x 补丁夹在 1.14 预发布之间），API 的时间序不是版本序，故必须按 compareSemver 重排。
 */
export function listableSingboxReleases(
  raws: unknown,
  platform: string,
  arch: string,
  bundledVersion: string
): SingboxRelease[] {
  if (!Array.isArray(raws)) return [];
  const seen = new Set<string>();
  const out: SingboxRelease[] = [];
  for (const raw of raws) {
    const rel = normalizeSingboxRelease(raw, platform, arch, bundledVersion);
    if (!rel || rel.draft || rel.belowMinimum || !rel.hasAsset || seen.has(rel.version)) continue;
    seen.add(rel.version);
    out.push(rel);
  }
  return out.sort((a, b) => compareSemver(b.version, a.version));
}

/** listReleases 结果（列表已剔除草稿 / 低于随包版本 / 无本平台资产者；是否显示预发布由渲染端按开关过滤）。 */
export interface SingboxReleaseList {
  releases: SingboxRelease[];
  /** 列表取自 GitHub 的时间（ms epoch；主进程缓存 10 分钟，force 绕过）。 */
  fetchedAt: number;
  /** 随包版本 = 最低可选版本。 */
  bundledVersion: string;
  /** 当前实跑内核的可比较版本（取主进程缓存，不为列表 spawn 内核）；未知为 '未知'。 */
  currentVersion: string;
}

/** listReleases 抛出的错误 code（经 IPC ApiResponse.code 透传到渲染端 error.code）。 */
export type SingboxListErrorCode = 'RATE_LIMITED' | 'NETWORK';

/** 安装阶段（渲染端据此显示文案；percent 仅 downloading 阶段有意义）。 */
export type SingboxInstallPhase =
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'testing'
  | 'switching'
  | 'restarting';

/** 进行中的安装 / 恢复随包进度（主进程持有：设置卡卸载重挂后经 getInstallState 找回）。 */
export interface SingboxInstallProgress {
  /** install = 在线安装；reset = 恢复随包版本（resetCoreToFactory）。 */
  kind: 'install' | 'reset';
  /** 目标 tag（reset 时为随包版本 `v<bundled>`）。 */
  tag: string;
  phase: SingboxInstallPhase;
  /** 0-100；仅下载阶段且已知总长时给出。 */
  percent?: number;
}

/** EVENT_CORE_INSTALL_PROGRESS 载荷：进度快照；null = 本次操作已结束（渲染端据此刷新状态）。 */
export type SingboxInstallProgressEvent = SingboxInstallProgress | null;

export interface SingboxInstallState {
  installing: SingboxInstallProgress | null;
}

/** installTag 失败码（渲染端 errorMessageKey 映射文案）。 */
export type SingboxInstallErrorCode =
  | 'BUSY' // 已有内核更新 / 安装 / 恢复在进行（或换核窗口被占用）
  | 'XRAY_BUSY' // Xray 版本切换正在进行，两者互斥
  | 'PROXY_BUSY' // 代理正在启动 / 停止 / 重启
  | 'INVALID_TAG'
  | 'NOT_FOUND' // GitHub 无此 tag（或 API 回的 tag 与所选不符）
  | 'RATE_LIMITED'
  | 'NETWORK'
  | 'DRAFT'
  | 'NO_ASSET' // 该 release 无本平台精确资产（或下载地址不是官方 release 地址）
  | 'BELOW_MINIMUM' // 低于随包版本（会被启动对齐刷回随包核）
  | 'NO_HASH' // API 未给 sha256 摘要（上游无 .dgst 兜底 → fail-closed）
  | 'HASH_MISMATCH'
  | 'DOWNLOAD_FAILED'
  | 'EXTRACT_FAILED'
  | 'VERSION_MISMATCH' // 解出的 `sing-box version` 与 tag 不符
  | 'NOT_OFFICIAL' // 解出的内核版本行不是官方构建形态
  | 'EXEC_FAILED' // 新核无法执行（架构不符 / 文件损坏 / 临时目录不可执行）；不标记问题版本
  | 'PREFLIGHT_FAILED' // 新核 `sing-box check` 当前配置失败（已标记问题版本；无 force 越过）
  | 'GVISOR_MISSING' // 新核未编入 gVisor，而当前 TUN 栈（含 Auto 解析）是 gvisor / mixed
  | 'HELPER_REQUIRED' // macOS：提权 helper 不支持 install-core（否则只能写进 .app 内的随包核）
  | 'FORK_CONFIRM_REQUIRED' // 当前是第三方内核：需用户确认（force）后才覆盖（fork 留作 .bak 可回滚）
  | 'START_FAILED' // 切换后代理起不来（rolledBack 表示是否已回滚到原内核）
  | 'START_BLOCKED' // 已切换，但代理因与内核无关的原因（取消授权 / 提权引导 / TUN 地址冲突 / 端口被占）没起来：新核留用、未回滚
  | 'FAILED'; // 其它异常（detail 为原始错误）

export type SingboxInstallResult =
  | {
      ok: true;
      version: string;
      tag: string;
      prerelease: boolean;
      /** 代理此前在跑且已用新核重启。 */
      restarted: boolean;
      /** 已固定此版本（自动更新暂停，直到取消固定 / 版本被其它途径改变）。 */
      pinned: boolean;
    }
  | { ok: false; code: SingboxInstallErrorCode; detail?: string; rolledBack?: boolean };

/** 固定版本（core-update-state.json 的 pinned）：自动更新在当前内核仍是该版本时暂停。 */
export interface SingboxPin {
  version: string;
  tag: string;
  prerelease: boolean;
  /** ISO 时间串。 */
  pinnedAt: string;
}
