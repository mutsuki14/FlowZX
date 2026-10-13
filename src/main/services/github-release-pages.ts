/**
 * GitHub Releases 列表分页拉取（纯逻辑：网络由注入的 fetchJson 完成，生产传 CoreDownloader.fetchGithubJson）。
 *
 * 为何要分页（FlowZX 4.6.0 的「获取版本列表失败 · 无法连接 GitHub」，各平台必现）：GitHub 的 release JSON 里每个资产都
 * 带一整份 uploader 用户对象，单个资产 ≈ 1.7 KB（紧凑）/ ≈ 2.1 KB（API 实际回的缩进格式）。sing-box 现在每个 release
 * 有 168 个资产（≈ 280–350 KB / release），`per_page=100` 一次就是 27–34 MB，远超 fetchGithubJson 的
 * MAX_GITHUB_JSON_BYTES（16 MiB，OOM 防护）→ 被当成「疑似劫持」中止。gzip 只省带宽，上限按解码后的字符数算，
 * 主进程还要整串 JSON.parse。故按小页取、取够即停，单页体量远低于上限。
 *
 * 语义：
 *  - URL：`${baseUrl}?per_page=${perPage}&page=${n}`（n = 1..maxPages）；每页单独过 fetchJson 的超时 / 上限 / 403。
 *  - 第 1 页失败原样抛出（保留 code / status，调用方据此区分 RATE_LIMITED / NOT_FOUND）；第 1 页不是数组 → 抛格式异常。
 *  - 第 2 页起失败 / 不是数组 → 停止，返回已取到的部分（complete=false，error 为该页的错误），由调用方决定如何降级。
 *  - 停止条件：某页不足 perPage 条（已到末页）/ shouldContinue(本页原始条目) 返回 false / 已取满 maxPages 页。
 *    后两者是调用方设定的覆盖范围，不算残缺（complete 仍为 true）。
 *  - 跨页去重：翻页期间若有新 release 发布，后面的条目整体后移一位，上一页末条会在下一页重现 → 按 release id
 *    （缺失时退回 tag_name）只保留首次出现的那条。两者都没有的条目原样保留（交给调用方的规范化逻辑剔除）。
 */

/** 分页参数。 */
export interface GithubReleasePagesOptions {
  /** 每页条数（GitHub 上限 100）。 */
  perPage: number;
  /** 最多取几页。 */
  maxPages: number;
  /** 收到一页（满页）后是否继续取下一页；返回 false → 停。缺省恒继续。入参为本页原始条目（去重前）。 */
  shouldContinue?: (pageItems: unknown[]) => boolean;
}

export interface GithubReleasePagesResult {
  /** 各页条目按页序拼接（已跨页去重）。 */
  releases: any[];
  /** false = 第 2 页起某页失败 / 格式异常而提前结束，releases 只是已取到的部分。 */
  complete: boolean;
  /** 成功取到的页数。 */
  pages: number;
  /** complete=false 时导致提前结束的错误。 */
  error?: unknown;
}

/**
 * 各调用方的分页参数（单一真值：服务代码与「单页体量 ≤ 上限一半」的回归单测共用，改页大小先过那条测试）。
 *  - singboxList：版本选择列表，10 × 10 页 = 与 4.6.0 的 per_page=100 同等覆盖；已取到不含「≥ 随包版本」的整页即停。
 *  - singboxCheck：「检查更新」/ 补取资产摘要，3 × 10 = 与 4.6.0 的默认 30 条同等覆盖（不提前停，只在短页处停）。
 *  - xrayList：Xray 版本选择列表（每 release ≈ 64 个资产），5 × 20 = 100 条覆盖；整页都低于最低版本即停。
 */
export const RELEASE_PAGING = {
  singboxList: { perPage: 10, maxPages: 10 },
  singboxCheck: { perPage: 10, maxPages: 3 },
  xrayList: { perPage: 20, maxPages: 5 },
} as const;

/** 第 1 页不是数组时的报错（与 4.6.0 listReleases 的文案一致）。 */
export const RELEASE_LIST_FORMAT_ERROR = 'GitHub 返回的 release 列表格式异常';

/** 跨页去重键：release id 优先，缺失时退回 tag_name；都没有 → null（不参与去重）。 */
function releaseKey(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const r = item as { id?: unknown; tag_name?: unknown };
  if (typeof r.id === 'number' || (typeof r.id === 'string' && r.id)) return `id:${r.id}`;
  if (typeof r.tag_name === 'string' && r.tag_name) return `tag:${r.tag_name}`;
  return null;
}

/** 按页拉取 GitHub release 列表（见文件头语义）。 */
export async function fetchGithubReleasePages(
  fetchJson: (url: string) => Promise<unknown>,
  baseUrl: string,
  opts: GithubReleasePagesOptions
): Promise<GithubReleasePagesResult> {
  const perPage = Math.max(1, Math.floor(opts.perPage));
  const maxPages = Math.max(1, Math.floor(opts.maxPages));
  const sep = baseUrl.includes('?') ? '&' : '?';
  const seen = new Set<string>();
  const releases: any[] = [];
  let pages = 0;

  for (let page = 1; page <= maxPages; page++) {
    let items: unknown;
    try {
      items = await fetchJson(`${baseUrl}${sep}per_page=${perPage}&page=${page}`);
    } catch (e) {
      if (page === 1) throw e;
      return { releases, complete: false, pages, error: e };
    }
    if (!Array.isArray(items)) {
      const err = new Error(RELEASE_LIST_FORMAT_ERROR);
      if (page === 1) throw err;
      return { releases, complete: false, pages, error: err };
    }
    pages = page;
    for (const item of items) {
      const key = releaseKey(item);
      if (key !== null) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      releases.push(item);
    }
    if (items.length < perPage) break;
    if (opts.shouldContinue && !opts.shouldContinue(items)) break;
  }
  return { releases, complete: true, pages };
}
