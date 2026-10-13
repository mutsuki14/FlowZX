/**
 * GitHub Releases API「真实体量」夹具：按 api.github.com 实际返回的形状造 release JSON——每个资产都带一整份 uploader
 * 用户对象、digest、browser_download_url，release 带 author 与发行说明；页面文本按 API 的缩进格式输出
 * （JSON.stringify(x, null, 2)）。供分页逻辑与「单页体量远低于 MAX_GITHUB_JSON_BYTES」的回归单测共用。
 *
 * 实测锚点（2026-10）：sing-box v1.15.0-alpha.12 有 168 个资产（SFA apk、openwrt apk/ipk、deb/rpm、众多 linux 架构、
 * windows、darwin…），单个资产 ≈ 1.7 KB（紧凑）/ ≈ 2.1 KB（缩进），一个 release ≈ 280–350 KB；Xray 每个 release
 * ≈ 64 个资产（32 个 zip + 各自的 .dgst）。4.6.0 的 sing-box 版本列表一次取 100 个 release（27–34 MB）→ 超上限必失败。
 */
import { createHash } from 'crypto';

export const SINGBOX_REPO = 'SagerNet/sing-box';
export const XRAY_REPO = 'XTLS/Xray-core';
export const SINGBOX_ASSETS_PER_RELEASE = 168;
export const XRAY_ASSETS_PER_RELEASE = 64;

/** API 里的用户对象（uploader / author），字段与真实响应一致。 */
function githubUser(login: string, id: number): Record<string, unknown> {
  const api = `https://api.github.com/users/${login}`;
  return {
    login,
    id,
    node_id: `MDQ6VXNlcj${id.toString(36).padStart(8, 'Q')}`,
    avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
    gravatar_id: '',
    url: api,
    html_url: `https://github.com/${login}`,
    followers_url: `${api}/followers`,
    following_url: `${api}/following{/other_user}`,
    gists_url: `${api}/gists{/gist_id}`,
    starred_url: `${api}/starred{/owner}{/repo}`,
    subscriptions_url: `${api}/subscriptions`,
    organizations_url: `${api}/orgs`,
    repos_url: `${api}/repos`,
    events_url: `${api}/events{/privacy}`,
    received_events_url: `${api}/received_events`,
    type: 'User',
    user_view_type: 'public',
    site_admin: false,
  };
}

const SINGBOX_UPLOADER = githubUser('nekohasekai', 23_314_224);
const XRAY_UPLOADER = githubUser('github-actions[bot]', 41_898_282);

/** sing-box 一个 release 的资产名（含本应用打包的四个精确名；其余是真实存在的各类变体），恰好 count 个。 */
export function singboxAssetNames(version: string, count = SINGBOX_ASSETS_PER_RELEASE): string[] {
  const p = `sing-box-${version}`;
  const names = new Set<string>([
    `${p}-linux-amd64.tar.gz`,
    `${p}-darwin-amd64.tar.gz`,
    `${p}-darwin-arm64.tar.gz`,
    `${p}-windows-amd64.zip`,
  ]);
  const linuxArches = [
    '386',
    'amd64',
    'amd64v3',
    'arm64',
    'armv5',
    'armv6',
    'armv7',
    'loong64',
    'mips-softfloat',
    'mipsle',
    'mipsle-softfloat',
    'mips64',
    'mips64le',
    'ppc64le',
    'riscv64',
    's390x',
  ];
  for (const a of linuxArches) {
    for (const v of ['', '-glibc', '-musl']) names.add(`${p}-linux-${a}${v}.tar.gz`);
    names.add(`sing-box_${version}_linux_${a}.deb`);
    names.add(`sing-box_${version}_linux_${a}.rpm`);
    names.add(`sing-box_${version}_linux_${a}.pkg.tar.zst`);
    names.add(`sing-box_${version}_openwrt_${a}.ipk`);
    names.add(`sing-box_${version}_openwrt_${a}.apk`);
  }
  for (const a of ['386', 'amd64', 'arm64', 'armv7']) {
    names.add(`${p}-android-${a}.tar.gz`);
    names.add(`${p}-freebsd-${a}.tar.gz`);
    names.add(`${p}-windows-${a}.zip`);
    names.add(`${p}-windows-${a}-legacy-windows-7.zip`);
    names.add(`SFA-${version}-${a}.apk`);
    names.add(`SFA-${version}-${a}-legacy-android-5.apk`);
  }
  names.add(`${p}-darwin-amd64-legacy-macos-10.13.tar.gz`);
  names.add(`SFA-${version}-universal.apk`);
  names.add(`SFA-${version}-universal-legacy-android-5.apk`);
  for (let i = 1; names.size < count; i++) names.add(`${p}-linux-amd64-variant${i}.tar.gz`);
  return [...names].slice(0, count);
}

/** Xray 一个 release 的资产名：count/2 个 zip（含本应用打包的六个精确名）+ 各自的 `.dgst`。 */
export function xrayAssetNames(count = XRAY_ASSETS_PER_RELEASE): string[] {
  const zips = [
    'Xray-windows-64.zip',
    'Xray-windows-arm64-v8a.zip',
    'Xray-macos-64.zip',
    'Xray-macos-arm64-v8a.zip',
    'Xray-linux-64.zip',
    'Xray-linux-arm64-v8a.zip',
    'Xray-windows-32.zip',
    'Xray-windows-arm32-v7a.zip',
    'Xray-windows-win7-64.zip',
    'Xray-windows-win7-32.zip',
    'Xray-linux-32.zip',
    'Xray-linux-arm32-v5.zip',
    'Xray-linux-arm32-v6.zip',
    'Xray-linux-arm32-v7a.zip',
    'Xray-linux-loong64.zip',
    'Xray-linux-mips32.zip',
    'Xray-linux-mips32le.zip',
    'Xray-linux-mips64.zip',
    'Xray-linux-mips64le.zip',
    'Xray-linux-ppc64.zip',
    'Xray-linux-ppc64le.zip',
    'Xray-linux-riscv64.zip',
    'Xray-linux-s390x.zip',
    'Xray-android-amd64.zip',
    'Xray-android-arm64-v8a.zip',
    'Xray-freebsd-32.zip',
    'Xray-freebsd-64.zip',
    'Xray-freebsd-arm32-v7a.zip',
    'Xray-freebsd-arm64-v8a.zip',
    'Xray-openbsd-32.zip',
    'Xray-openbsd-64.zip',
    'Xray-openbsd-arm64-v8a.zip',
  ];
  for (let i = 1; zips.length < count / 2; i++) zips.push(`Xray-linux-variant${i}.zip`);
  return zips
    .slice(0, Math.ceil(count / 2))
    .flatMap((z) => [z, `${z}.dgst`])
    .slice(0, count);
}

const contentType = (name: string): string =>
  name.endsWith('.zip')
    ? 'application/zip'
    : name.endsWith('.apk')
      ? 'application/vnd.android.package-archive'
      : name.endsWith('.dgst')
        ? 'text/plain'
        : name.endsWith('.deb')
          ? 'application/vnd.debian.binary-package'
          : 'application/gzip';

const RELEASE_NOTES = [
  '#### Changes',
  '',
  '* Fixes and improvements',
  '* Update quic-go to v0.55.0',
  '* Add `ech` support for naive outbound',
  '* Fix route rule set loading when the rule set file is missing on first start',
  '* Fix DNS cache not being invalidated after the outbound changes',
  '* Improve TUN auto route on macOS when a VPN profile is already active',
  '',
  '**Full Changelog**: https://github.com/SagerNet/sing-box/compare/v1.14.2...v1.14.3',
  '',
  '_Please note that pre-release versions may contain breaking changes; read the documentation before upgrading._',
].join('\r\n');

export interface FixtureReleaseOpts {
  /** release id（跨页去重的键；缺省由 tag 推出）。 */
  id?: number;
  prerelease?: boolean;
  draft?: boolean;
  /** 资产名（缺省按仓库给真实数量）。 */
  assetNames?: string[];
}

/** 按 GitHub API 的真实字段造一个 release 对象。 */
export function makeGithubRelease(
  repo: string,
  tag: string,
  opts: FixtureReleaseOpts = {}
): Record<string, unknown> {
  const version = tag.replace(/^v/, '');
  const id =
    opts.id ??
    250_000_000 + [...tag].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1_000_000_007, 7);
  const isXray = repo === XRAY_REPO;
  const uploader = isXray ? XRAY_UPLOADER : SINGBOX_UPLOADER;
  const names = opts.assetNames ?? (isXray ? xrayAssetNames() : singboxAssetNames(version));
  const api = `https://api.github.com/repos/${repo}`;
  return {
    url: `${api}/releases/${id}`,
    assets_url: `${api}/releases/${id}/assets`,
    upload_url: `https://uploads.github.com/repos/${repo}/releases/${id}/assets{?name,label}`,
    html_url: `https://github.com/${repo}/releases/tag/${tag}`,
    id,
    author: uploader,
    node_id: `RE_kwDOGB5Wl84${id.toString(36).toUpperCase()}`,
    tag_name: tag,
    target_commitish: 'testing',
    name: tag,
    draft: opts.draft === true,
    immutable: false,
    prerelease: opts.prerelease ?? /-(alpha|beta|rc)\./.test(version),
    created_at: '2026-10-09T06:58:12Z',
    updated_at: '2026-10-09T07:31:40Z',
    published_at: '2026-10-09T07:31:40Z',
    assets: names.map((name, i) => {
      const assetId = id * 1000 + i;
      return {
        url: `${api}/releases/assets/${assetId}`,
        id: assetId,
        node_id: `RA_kwDOGB5Wl84${assetId.toString(36).toUpperCase()}`,
        name,
        label: '',
        uploader,
        content_type: contentType(name),
        state: 'uploaded',
        size: 10_000_000 + ((assetId * 7919) % 40_000_000),
        digest: `sha256:${createHash('sha256').update(String(assetId)).digest('hex')}`,
        download_count: (assetId * 31) % 250_000,
        created_at: '2026-10-09T07:12:31Z',
        updated_at: '2026-10-09T07:12:35Z',
        browser_download_url: `https://github.com/${repo}/releases/download/${tag}/${name}`,
      };
    }),
    tarball_url: `${api}/tarball/${tag}`,
    zipball_url: `${api}/zipball/${tag}`,
    body: RELEASE_NOTES,
  };
}

/** API 回的页面文本（GitHub 对 API 请求返回缩进 2 的 JSON）。 */
export function githubPageText(releases: unknown[]): string {
  return JSON.stringify(releases, null, 2);
}

/** 由完整（新→旧）release 列表按 URL 的 per_page / page（缺省 30 / 1，同 GitHub）切出那一页。 */
export function pageFromUrl<T>(all: readonly T[], url: string): T[] {
  const q = new URL(url).searchParams;
  const perPage = Number(q.get('per_page') ?? 30);
  const page = Number(q.get('page') ?? 1);
  return all.slice((page - 1) * perPage, page * perPage);
}
