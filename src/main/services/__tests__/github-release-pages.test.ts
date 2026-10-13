/**
 * GitHub release 列表分页（github-release-pages，纯逻辑、零网络）+ 「真实体量」回归。
 *
 * 背景（FlowZX 4.6.0，各平台必现）：sing-box 版本列表一次取 per_page=100，sing-box 每个 release 带 168 个资产（每个资产
 * 都有一整份 uploader 对象），响应 27–34 MB，超过 fetchGithubJson 的 MAX_GITHUB_JSON_BYTES（16 MiB）被中止，渲染端
 * 显示「获取版本列表失败 · 无法连接 GitHub」。旧单测把 fetchGithubJson 整个 mock 掉，从没碰到过这个上限。
 *
 * 钉住：
 *  - URL 形状 `?per_page=N&page=n`；停止条件（短页 / shouldContinue=false / maxPages）；跨页按 id（退回 tag_name）去重；
 *  - 第 1 页失败原样抛出（code / status 不丢）、非数组 → 格式异常；第 2 页起失败 → 返回已取部分（complete=false）；
 *  - 体量：按 GitHub 真实形状（缩进 JSON）造页面——100 个 sing-box release 超上限（即 4.6.0 的 bug），而各调用方的单页
 *    即便资产数翻倍也 ≤ 上限的一半；Xray 同理（64 个资产，100 个 release 已逼近上限）。
 */
import {
  RELEASE_LIST_FORMAT_ERROR,
  RELEASE_PAGING,
  fetchGithubReleasePages,
} from '../github-release-pages';
import { MAX_GITHUB_JSON_BYTES } from '../../utils/http-limits';
import {
  SINGBOX_ASSETS_PER_RELEASE,
  SINGBOX_REPO,
  XRAY_ASSETS_PER_RELEASE,
  XRAY_REPO,
  githubPageText,
  makeGithubRelease,
  pageFromUrl,
  singboxAssetNames,
  xrayAssetNames,
} from './github-release-fixtures';

const BASE = 'https://api.github.com/repos/SagerNet/sing-box/releases';
const rel = (id: number, tag = `v1.0.${id}`) => ({ id, tag_name: tag });
const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => rel(from + i));

/** fetchJson 桩：按 URL 的 per_page / page 从完整列表切页，记录请求过的 URL。 */
function pagedFetch(all: unknown[]) {
  const urls: string[] = [];
  const fn = jest.fn(async (url: string) => {
    urls.push(url);
    return pageFromUrl(all, url);
  });
  return { fn, urls };
}

const pageOf = (url: string) => Number(new URL(url).searchParams.get('page'));

describe('fetchGithubReleasePages：请求形状与停止条件', () => {
  it('URL = baseUrl?per_page=N&page=n（逐页递增）；短页即停；结果按页序拼接', async () => {
    const all = range(1, 23);
    const { fn, urls } = pagedFetch(all);
    const r = await fetchGithubReleasePages(fn, BASE, { perPage: 10, maxPages: 10 });
    expect(urls).toEqual([
      `${BASE}?per_page=10&page=1`,
      `${BASE}?per_page=10&page=2`,
      `${BASE}?per_page=10&page=3`,
    ]);
    expect(r).toEqual({ releases: all, complete: true, pages: 3 });
  });

  it('baseUrl 已带查询串 → 用 & 拼接', async () => {
    const { fn, urls } = pagedFetch(range(1, 2));
    await fetchGithubReleasePages(fn, `${BASE}?foo=1`, { perPage: 5, maxPages: 2 });
    expect(urls).toEqual([`${BASE}?foo=1&per_page=5&page=1`]);
  });

  it('总数恰为 perPage 的整数倍 → 多取一个空页后停（空页也是短页）', async () => {
    const { fn, urls } = pagedFetch(range(1, 20));
    const r = await fetchGithubReleasePages(fn, BASE, { perPage: 10, maxPages: 10 });
    expect(urls.map(pageOf)).toEqual([1, 2, 3]);
    expect(r.releases).toHaveLength(20);
    expect(r.complete).toBe(true);
  });

  it('取满 maxPages 页即停（覆盖范围由调用方定，不算残缺）', async () => {
    const { fn, urls } = pagedFetch(range(1, 100));
    const r = await fetchGithubReleasePages(fn, BASE, { perPage: 10, maxPages: 3 });
    expect(urls.map(pageOf)).toEqual([1, 2, 3]);
    expect(r).toEqual({ releases: range(1, 30), complete: true, pages: 3 });
  });

  it('shouldContinue 返回 false → 收下本页后停；入参是本页原始条目', async () => {
    const { fn, urls } = pagedFetch(range(1, 100));
    const seen: unknown[][] = [];
    const r = await fetchGithubReleasePages(fn, BASE, {
      perPage: 10,
      maxPages: 10,
      shouldContinue: (page) => {
        seen.push(page);
        return seen.length < 2;
      },
    });
    expect(urls.map(pageOf)).toEqual([1, 2]);
    expect(seen).toEqual([range(1, 10), range(11, 10)]);
    expect(r).toEqual({ releases: range(1, 20), complete: true, pages: 2 });
  });

  it('短页不再询问 shouldContinue（已到末页）', async () => {
    const { fn } = pagedFetch(range(1, 4));
    const shouldContinue = jest.fn(() => true);
    await fetchGithubReleasePages(fn, BASE, { perPage: 10, maxPages: 10, shouldContinue });
    expect(shouldContinue).not.toHaveBeenCalled();
  });
});

describe('fetchGithubReleasePages：跨页去重', () => {
  it('翻页期间发布新 release（整体后移一位）→ 上一页末条在下一页重现，按 id 只留首次出现', async () => {
    const pages: Record<number, unknown[]> = {
      1: range(1, 10),
      // 新 release 发布后 #10 被挤到第 2 页开头
      2: [rel(10), ...range(11, 9)],
      3: [rel(20), rel(21)],
    };
    const fn = jest.fn(async (url: string) => pages[pageOf(url)] ?? []);
    const r = await fetchGithubReleasePages(fn, BASE, { perPage: 10, maxPages: 10 });
    expect(r.releases).toEqual(range(1, 21));
    expect(r.pages).toBe(3);
  });

  it('无 id 时退回 tag_name 去重；两者都没有的条目原样保留（交给规范化逻辑剔除）', async () => {
    const pages: Record<number, unknown[]> = {
      1: [{ tag_name: 'v1' }, { tag_name: 'v2' }, null, 'junk'],
      2: [{ tag_name: 'v2' }, { tag_name: 'v3' }, null],
    };
    const fn = jest.fn(async (url: string) => pages[pageOf(url)] ?? []);
    const r = await fetchGithubReleasePages(fn, BASE, { perPage: 4, maxPages: 5 });
    expect(r.releases).toEqual([
      { tag_name: 'v1' },
      { tag_name: 'v2' },
      null,
      'junk',
      { tag_name: 'v3' },
      null,
    ]);
  });

  it('id 相同但 tag 不同 → 仍视为同一 release（id 优先）', async () => {
    const pages: Record<number, unknown[]> = {
      1: [rel(1, 'v1.0.0'), rel(2, 'v1.0.1')],
      2: [rel(2, 'v1.0.1-renamed')],
    };
    const fn = jest.fn(async (url: string) => pages[pageOf(url)] ?? []);
    const r = await fetchGithubReleasePages(fn, BASE, { perPage: 2, maxPages: 5 });
    expect(r.releases).toEqual([rel(1, 'v1.0.0'), rel(2, 'v1.0.1')]);
  });
});

describe('fetchGithubReleasePages：失败处理', () => {
  it('第 1 页失败 → 原样抛出（同一对象，code / status 不丢），不再取后续页', async () => {
    const err = Object.assign(new Error('GitHub API 访问频率限制 (403)'), {
      code: 'RATE_LIMITED',
      status: 403,
    });
    const fn = jest.fn(async () => {
      throw err;
    });
    await expect(fetchGithubReleasePages(fn, BASE, { perPage: 10, maxPages: 10 })).rejects.toBe(
      err
    );
    expect(fn).toHaveBeenCalledTimes(1);

    const notFound = Object.assign(new Error('GitHub API 错误: 404'), { status: 404 });
    fn.mockRejectedValueOnce(notFound);
    await expect(
      fetchGithubReleasePages(fn, BASE, { perPage: 10, maxPages: 10 })
    ).rejects.toMatchObject({ status: 404, message: 'GitHub API 错误: 404' });
  });

  it('第 1 页不是数组 → 抛格式异常', async () => {
    const fn = jest.fn(async () => ({ message: 'Not Found' }));
    await expect(fetchGithubReleasePages(fn, BASE, { perPage: 10, maxPages: 10 })).rejects.toThrow(
      RELEASE_LIST_FORMAT_ERROR
    );
  });

  it('第 2 页起失败 → 返回已取到的部分（complete=false，带错误），不再继续', async () => {
    const boom = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
    const fn = jest.fn(async (url: string) => {
      if (pageOf(url) === 3) throw boom;
      return range((pageOf(url) - 1) * 10 + 1, 10);
    });
    const r = await fetchGithubReleasePages(fn, BASE, { perPage: 10, maxPages: 10 });
    expect(fn).toHaveBeenCalledTimes(3);
    expect(r).toEqual({ releases: range(1, 20), complete: false, pages: 2, error: boom });
  });

  it('第 2 页起不是数组 → 同样按残缺结束', async () => {
    const fn = jest.fn(async (url: string) => (pageOf(url) === 1 ? range(1, 10) : { oops: 1 }));
    const r = await fetchGithubReleasePages(fn, BASE, { perPage: 10, maxPages: 10 });
    expect(r.releases).toEqual(range(1, 10));
    expect(r.complete).toBe(false);
    expect(r.pages).toBe(1);
    expect((r.error as Error).message).toBe(RELEASE_LIST_FORMAT_ERROR);
  });
});

// ── 真实体量回归 ─────────────────────────────────────────────────────────────────────────────────

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
const HALF_CAP = MAX_GITHUB_JSON_BYTES / 2;

const singboxReleases = (n: number, assetCount = SINGBOX_ASSETS_PER_RELEASE) =>
  Array.from({ length: n }, (_, i) => {
    const v = `1.15.0-alpha.${n - i}`;
    return makeGithubRelease(SINGBOX_REPO, `v${v}`, {
      assetNames: singboxAssetNames(v, assetCount),
    });
  });
const xrayReleases = (n: number, assetCount = XRAY_ASSETS_PER_RELEASE) =>
  Array.from({ length: n }, (_, i) =>
    makeGithubRelease(XRAY_REPO, `v26.${(i % 12) + 1}.${n - i}`, {
      assetNames: xrayAssetNames(assetCount),
    })
  );

describe('真实体量：夹具贴合 GitHub 实测形状', () => {
  it('sing-box 一个 release 168 个资产；单个资产 ≈ 1.7 KB 紧凑 / ≈ 2.1 KB 缩进（实测锚点 v1.15.0-alpha.12）', () => {
    const one = makeGithubRelease(SINGBOX_REPO, 'v1.15.0-alpha.12');
    const assets = one.assets as unknown[];
    expect(assets).toHaveLength(168);
    expect(new Set(assets.map((a) => (a as { name: string }).name)).size).toBe(168);
    const bare = { ...one, assets: [] };
    const perAssetPretty =
      (bytes(githubPageText([one])) - bytes(githubPageText([bare]))) / assets.length;
    const perAssetCompact = (bytes(JSON.stringify(one)) - bytes(JSON.stringify(bare))) / 168;
    expect(perAssetCompact).toBeGreaterThan(1400);
    expect(perAssetCompact).toBeLessThan(2000);
    expect(perAssetPretty).toBeGreaterThan(1800);
    expect(perAssetPretty).toBeLessThan(2400);
    // 一个 release ≈ 280–350 KB
    expect(bytes(githubPageText([one]))).toBeGreaterThan(280 * 1000);
    expect(bytes(githubPageText([one]))).toBeLessThan(360 * 1000);
  });

  it('Xray 一个 release 64 个资产（32 个 zip + 各自 .dgst），含六个打包平台的精确资产', () => {
    const names = xrayAssetNames();
    expect(names).toHaveLength(64);
    expect(names.filter((n) => n.endsWith('.dgst'))).toHaveLength(32);
    for (const n of ['Xray-linux-64.zip', 'Xray-macos-arm64-v8a.zip', 'Xray-windows-64.zip']) {
      expect(names).toContain(n);
      expect(names).toContain(`${n}.dgst`);
    }
  });
});

describe('真实体量：4.6.0 的单次大页超上限，分页后单页 ≤ 上限一半', () => {
  it('sing-box：100 个 release（4.6.0 版本列表 per_page=100）超过 MAX_GITHUB_JSON_BYTES——即 bug 本身', () => {
    expect(bytes(githubPageText(singboxReleases(100)))).toBeGreaterThan(MAX_GITHUB_JSON_BYTES);
  });

  it('sing-box：4.6.0「检查更新」的默认 30 个已超过上限一半（资产再涨 ~60% 就会撞上）', () => {
    expect(bytes(githubPageText(singboxReleases(30)))).toBeGreaterThan(HALF_CAP);
  });

  it.each([
    ['singboxList', RELEASE_PAGING.singboxList.perPage],
    ['singboxCheck', RELEASE_PAGING.singboxCheck.perPage],
  ])('sing-box %s：一页（%i 个）即便资产数翻倍（336 个）也 ≤ 上限一半', (_name, perPage) => {
    const page = singboxReleases(perPage, SINGBOX_ASSETS_PER_RELEASE * 2);
    expect(bytes(githubPageText(page))).toBeLessThanOrEqual(HALF_CAP);
  });

  it('Xray：100 个 release 已用掉上限的六成以上；资产翻倍即超上限（4.6.0 的 per_page=100 是定时炸弹）', () => {
    expect(bytes(githubPageText(xrayReleases(100)))).toBeGreaterThan(MAX_GITHUB_JSON_BYTES * 0.6);
    expect(bytes(githubPageText(xrayReleases(100, XRAY_ASSETS_PER_RELEASE * 2)))).toBeGreaterThan(
      MAX_GITHUB_JSON_BYTES
    );
  });

  it('Xray xrayList：一页（20 个）即便资产数翻倍（128 个）也 ≤ 上限一半', () => {
    const page = xrayReleases(RELEASE_PAGING.xrayList.perPage, XRAY_ASSETS_PER_RELEASE * 2);
    expect(bytes(githubPageText(page))).toBeLessThanOrEqual(HALF_CAP);
  });

  it('覆盖范围不缩水：版本列表 ≥ 100 个 release（同 4.6.0 的 per_page=100）；检查更新 = 30 个（同 GitHub 默认页）', () => {
    const cover = (p: { perPage: number; maxPages: number }) => p.perPage * p.maxPages;
    expect(cover(RELEASE_PAGING.singboxList)).toBeGreaterThanOrEqual(100);
    expect(cover(RELEASE_PAGING.xrayList)).toBeGreaterThanOrEqual(100);
    expect(cover(RELEASE_PAGING.singboxCheck)).toBe(30);
  });
});
