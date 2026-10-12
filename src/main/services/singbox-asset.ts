/**
 * 从 GitHub release assets 中挑选适配 (platform, arch) 的 sing-box 构建。
 * 纯函数：平台/架构由参数注入（不读 process），无 electron 依赖 → 可独立单测。
 * 从 CoreUpdateService.findSuitableAsset 抽出。
 */
import { singboxAssetName } from '../../shared/singbox-release';

/** 资产名里的版本段（`sing-box-<版本>-…`），版本形状同 SINGBOX_TAG_RE。 */
const ASSET_VERSION_RE = /^sing-box-(\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?)-/;
/** 与随包构建不同的变体（-glibc 为 CGO 动态链接且不带 libcronet、-musl 静态、-legacy-* 为旧系统兼容版）。 */
const VARIANT_RE = /-(glibc|musl|legacy)\b/;

/**
 * 规范资产：`sing-box-<v>-<平台>-<架构>.<ext>` 原名，不带任何变体后缀——即 scripts/fetch-core.mjs 打包进 App 的那一款。
 * 已打包平台以 shared/singbox-release 的精确名为准（与版本选择 installTag 同一真值）；未打包平台（linux-arm64 /
 * win32-arm64 等）按同一命名规则推出。
 */
function isCanonicalAsset(
  name: string,
  platform: NodeJS.Platform,
  arch: string,
  plainSuffix: string
): boolean {
  const m = ASSET_VERSION_RE.exec(name);
  if (!m) return false;
  const exact = singboxAssetName(m[1], platform, arch);
  return exact ? name === exact : name === `sing-box-${m[1]}${plainSuffix}`;
}

/**
 * 挑选逻辑：
 *  1. 先按平台关键词(windows/darwin/linux) + 架构关键词(amd64/arm64) + 后缀(平台默认 ext 或 .zip) 过滤；
 *  2. 在命中集合内按优先级取：① 规范资产（与随包同款，见 isCanonicalAsset）② 含 with-naive/full（旧版本时代的带 naive
 *     构建，现已不发布）③ 非 legacy 且非 -glibc / -musl ④ 非 legacy ⑤ 首个命中。
 * 规范资产在场时**绝不**挑 -glibc / -musl / -legacy：GitHub API 按名字排序列资产，`…-linux-amd64-glibc.tar.gz` 排在
 * `…-linux-amd64.tar.gz` 之前（'-' < '.'），旧逻辑「首个非 legacy」在 Linux 上实际装的是 CGO 的 glibc 构建。
 * 无任何命中返回 undefined。
 */
export function findSuitableSingboxAsset(
  assets: any[],
  platform: NodeJS.Platform,
  arch: string
): any {
  let keyword = '';
  let ext = '';

  if (platform === 'win32') {
    keyword = 'windows';
    ext = '.zip';
  } else if (platform === 'darwin') {
    keyword = 'darwin';
    ext = '.tar.gz'; // 通常是 tar.gz 或者 zip
  } else if (platform === 'linux') {
    keyword = 'linux';
    ext = '.tar.gz';
  }

  let archKeyword = '';
  if (arch === 'x64') {
    archKeyword = 'amd64';
  } else if (arch === 'arm64') {
    archKeyword = 'arm64';
  }

  // 优先查找包含特定架构的
  const filteredAssets = assets.filter(
    (a: any) =>
      a.name.toLowerCase().includes(keyword) &&
      a.name.toLowerCase().includes(archKeyword) &&
      (a.name.endsWith(ext) || a.name.endsWith('.zip'))
  );

  if (filteredAssets.length === 0) return undefined;

  // 优先顺序：
  // 1. 规范资产（与随包同款）
  // 2. 包含 with-naive 或 full 的版本 (针对 Windows 的旧发布)
  // 3. 不含 legacy、也不是 -glibc / -musl 变体的版本
  // 4. 不含 legacy 的版本
  // 5. 其他匹配项
  const canonical = filteredAssets.find((a: any) =>
    isCanonicalAsset(String(a.name), platform, arch, `-${keyword}-${archKeyword}${ext}`)
  );
  if (canonical) return canonical;

  const preferred = filteredAssets.find(
    (a: any) => a.name.toLowerCase().includes('with-naive') || a.name.toLowerCase().includes('full')
  );
  if (preferred) return preferred;

  const plain = filteredAssets.find((a: any) => !VARIANT_RE.test(a.name.toLowerCase()));
  if (plain) return plain;

  const nonLegacy = filteredAssets.find((a: any) => !a.name.toLowerCase().includes('legacy'));
  if (nonLegacy) return nonLegacy;

  return filteredAssets[0];
}

/**
 * 取 release asset 的 sha256 摘要 —— GitHub REST 对每个 asset 返回 `digest: "sha256:<64 hex>"`
 * （实测 v1.12.0 / v1.13.0 / v1.14.0-beta.7 均有，官方对全部 asset 回填，故可据它 fail-closed）。
 *
 * 用途是**运行期换核的完整性锚**：下载走 net.request 且失败会回落 gh-proxy 第三方镜像，只比对
 * Content-Length 挡不住「长度对得上但内容被换」的镜像投毒。摘要本身取自 api.github.com 直连响应，
 * 不经镜像，故可用来校验镜像给的字节。
 *
 * 归一为小写裸 hex；形状不符（缺失 / 非 sha256 / 非 64hex）一律返回 null，由调用方决定拒装——
 * **不要在此处兜底放行**，否则「拿不到摘要」会静默退化成「不校验」。
 */
export function normalizeAssetDigest(asset: unknown): string | null {
  const raw = (asset as { digest?: unknown } | null | undefined)?.digest;
  if (typeof raw !== 'string') return null;
  const m = /^sha256:([0-9a-fA-F]{64})$/.exec(raw.trim());
  return m ? m[1].toLowerCase() : null;
}
