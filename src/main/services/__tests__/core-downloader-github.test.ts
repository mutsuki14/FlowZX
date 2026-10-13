/**
 * CoreDownloader 为 Xray 版本选择新增 / 泛化的入口（node env，零网络；mock electron net.request，同
 * core-downloader-integrity.test.ts 范式）：
 *  - fetchGithubJson：从 fetchReleases 抽出——sing-box 报错文案逐字不变，另挂机器可读 code/status；
 *  - fetchGithubText：只读 github.com（.dgst 摘要绝不经镜像），有字节上限；
 *  - downloadFile opts：临时文件前缀 + 进度回调，镜像重试腿沿用 opts；不传 opts 时 sing-box 行为不变。
 *  - release 列表分页（4.6.1）：走**真实** fetchGithubJson（含 MAX_GITHUB_JSON_BYTES 上限）+ 按 GitHub 真实形状造的
 *    页面——4.6.0 的 per_page=100 在这里被以 TOO_LARGE 中止（版本列表必失败的根因）；fetchReleases 改为 3 页 × 10 个。
 */
import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockRequest = jest.fn();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-core-gh-'));

jest.mock('electron', () => ({
  app: { getPath: () => TMP },
  net: { request: (...a: unknown[]) => mockRequest(...a) },
  session: { fromPartition: () => ({ setProxy: async () => undefined }) },
}));

import { CoreDownloader, GITHUB_JSON_TOO_LARGE } from '../core-downloader';
import { MAX_GITHUB_JSON_BYTES } from '../../utils/http-limits';
import {
  SINGBOX_REPO,
  githubPageText,
  makeGithubRelease,
  pageFromUrl,
} from './github-release-fixtures';

class FakeReq extends EventEmitter {
  headers: Record<string, string> = {};
  setHeader(k: string, v: string): void {
    this.headers[k] = v;
  }
  end(): void {}
  abort(): void {}
}

class FakeRes extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
}

/** 每次 net.request 回同一响应（可分块）。 */
function serve(status: number, chunks: Buffer[], headers: Record<string, string> = {}): FakeReq[] {
  const reqs: FakeReq[] = [];
  mockRequest.mockImplementation(() => {
    const req = new FakeReq();
    reqs.push(req);
    setImmediate(() => {
      const res = new FakeRes();
      res.statusCode = status;
      res.headers = headers;
      req.emit('response', res);
      setImmediate(() => {
        for (const c of chunks) res.emit('data', c);
        res.emit('end');
      });
    });
    return req;
  });
  return reqs;
}

/**
 * 按 URL 回不同响应（body 按 64 KB 分块推送，模拟 net 的流式 data）。返回每个请求的 URL 与是否被 abort。
 * handler 抛错 → 该请求以 request 'error' 结束（模拟断连）。
 */
function serveByUrl(handler: (url: string) => { status: number; body: string }) {
  const seen: Array<{ url: string; aborted: boolean }> = [];
  mockRequest.mockImplementation((opts: { url: string }) => {
    const req = new FakeReq();
    const rec = { url: opts.url, aborted: false };
    seen.push(rec);
    req.abort = () => {
      rec.aborted = true;
    };
    setImmediate(() => {
      let r: { status: number; body: string };
      try {
        r = handler(opts.url);
      } catch (e) {
        req.emit('error', e);
        return;
      }
      const res = new FakeRes();
      res.statusCode = r.status;
      req.emit('response', res);
      setImmediate(() => {
        const buf = Buffer.from(r.body);
        for (let i = 0; i < buf.length && !rec.aborted; i += 64 * 1024) {
          res.emit('data', buf.subarray(i, i + 64 * 1024));
        }
        res.emit('end');
      });
    });
    return req;
  });
  return seen;
}

const logManager = { addLog: () => {} } as never;
const newDownloader = () => new CoreDownloader(logManager, async () => null);

afterAll(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

beforeEach(() => {
  mockRequest.mockReset();
});

describe('fetchGithubJson / fetchReleases', () => {
  it('200 → 解析 JSON；请求带 GitHub API Accept 头', async () => {
    const reqs = serve(200, [Buffer.from('{"tag_name":"v26.10.10"}')]);
    await expect(
      newDownloader().fetchGithubJson(
        'https://api.github.com/repos/XTLS/Xray-core/releases/tags/v26.10.10'
      )
    ).resolves.toEqual({ tag_name: 'v26.10.10' });
    expect(mockRequest.mock.calls[0][0].url).toBe(
      'https://api.github.com/repos/XTLS/Xray-core/releases/tags/v26.10.10'
    );
    expect(reqs[0].headers.Accept).toBe('application/vnd.github.v3+json');
  });

  it('fetchReleases 仍打 SagerNet/sing-box（分页：首页即短页 → 只请求一次）', async () => {
    serve(200, [Buffer.from('[]')]);
    await expect(newDownloader().fetchReleases()).resolves.toEqual([]);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockRequest.mock.calls[0][0].url).toBe(
      'https://api.github.com/repos/SagerNet/sing-box/releases?per_page=10&page=1'
    );
  });

  it('403 → 原文案 + code=RATE_LIMITED', async () => {
    serve(403, [Buffer.from('{}')]);
    const err = await newDownloader()
      .fetchGithubJson('https://api.github.com/x')
      .catch((e) => e);
    expect(err.message).toBe('GitHub API 访问频率限制 (403)，请稍后再试或使用代理');
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.status).toBe(403);
  });

  it('404 → 原文案 + status=404（Xray 据此判 NOT_FOUND）', async () => {
    serve(404, [Buffer.from('{}')]);
    const err = await newDownloader()
      .fetchGithubJson('https://api.github.com/x')
      .catch((e) => e);
    expect(err.message).toBe('GitHub API 错误: 404');
    expect(err.status).toBe(404);
    expect(err.code).toBeUndefined();
  });

  it('非 JSON → 解析失败文案', async () => {
    serve(200, [Buffer.from('<html>')]);
    await expect(newDownloader().fetchGithubJson('https://api.github.com/x')).rejects.toThrow(
      '解析 GitHub 响应失败'
    );
  });
});

describe('release 列表分页（真实 fetchGithubJson + 真实体量页面）', () => {
  const API = `https://api.github.com/repos/${SINGBOX_REPO}/releases`;
  /** 60 个按 GitHub 真实形状造的 sing-box release（每个 168 个资产，新→旧）。 */
  const ALL = Array.from({ length: 60 }, (_, i) =>
    makeGithubRelease(SINGBOX_REPO, `v1.15.0-alpha.${60 - i}`)
  );
  /** 按 per_page / page 切页并输出 API 的缩进 JSON（同一 URL 只生成一次）。 */
  const pageCache = new Map<string, string>();
  const pageText = (url: string) => {
    if (!pageCache.has(url)) pageCache.set(url, githubPageText(pageFromUrl(ALL, url)));
    return pageCache.get(url) as string;
  };

  it('4.6.0 的单次大页（per_page=100）被 MAX_GITHUB_JSON_BYTES 中止：原文案 + code=TOO_LARGE，请求被 abort', async () => {
    const big = githubPageText(
      Array.from({ length: 100 }, (_, i) => makeGithubRelease(SINGBOX_REPO, `v1.14.${i}`))
    );
    expect(big.length).toBeGreaterThan(MAX_GITHUB_JSON_BYTES);
    const seen = serveByUrl(() => ({ status: 200, body: big }));
    const err = await newDownloader()
      .fetchGithubJson(`${API}?per_page=100`)
      .catch((e) => e);
    expect(err.message).toBe('GitHub 响应过大（疑似被劫持/WAF 拦截）');
    expect(err.code).toBe(GITHUB_JSON_TOO_LARGE);
    expect(seen[0].aborted).toBe(true);
  });

  it('fetchReleases：3 页 × 10 个（同 4.6.0 的 30 个覆盖），每页远低于上限；不取第 4 页', async () => {
    const seen = serveByUrl((url) => ({ status: 200, body: pageText(url) }));
    const releases = await newDownloader().fetchReleases();
    expect(seen.map((r) => r.url)).toEqual([
      `${API}?per_page=10&page=1`,
      `${API}?per_page=10&page=2`,
      `${API}?per_page=10&page=3`,
    ]);
    expect(releases.map((r) => r.tag_name)).toEqual(ALL.slice(0, 30).map((r) => r.tag_name));
    expect(releases[0].assets).toHaveLength(168);
    for (const r of seen) expect(pageText(r.url).length).toBeLessThan(MAX_GITHUB_JSON_BYTES / 2);
  });

  it('fetchReleases：第 1 页失败 → 照旧 reject（403 文案 + RATE_LIMITED），不取后续页', async () => {
    const seen = serveByUrl(() => ({ status: 403, body: '{}' }));
    const err = await newDownloader()
      .fetchReleases()
      .catch((e) => e);
    expect(err.message).toBe('GitHub API 访问频率限制 (403)，请稍后再试或使用代理');
    expect(err.code).toBe('RATE_LIMITED');
    expect(seen).toHaveLength(1);
  });

  it('fetchReleases：第 2 页起失败 → 返回已取到的部分并记 warn', async () => {
    const addLog = jest.fn();
    const dl = new CoreDownloader({ addLog } as never, async () => null);
    serveByUrl((url) => {
      if (url.endsWith('page=3')) throw new Error('ERR_CONNECTION_CLOSED');
      return { status: 200, body: pageText(url) };
    });
    const releases = await dl.fetchReleases();
    expect(releases.map((r) => r.tag_name)).toEqual(ALL.slice(0, 20).map((r) => r.tag_name));
    expect(addLog).toHaveBeenCalledWith(
      'warn',
      expect.stringMatching(/只取到前 2 页.*ERR_CONNECTION_CLOSED/),
      'CoreDownloader'
    );
  });

  it('fetchGithubReleasePages 每页都经 fetchGithubJson（同一会话 / 超时 / 上限护栏）', async () => {
    const dl = newDownloader();
    const spy = jest
      .spyOn(dl, 'fetchGithubJson')
      .mockImplementation(async (url: string) => pageFromUrl(ALL, url));
    const r = await dl.fetchGithubReleasePages(API, { perPage: 25, maxPages: 5 });
    expect(spy.mock.calls.map((c) => c[0])).toEqual([
      `${API}?per_page=25&page=1`,
      `${API}?per_page=25&page=2`,
      `${API}?per_page=25&page=3`,
    ]);
    expect(r).toMatchObject({ complete: true, pages: 3 });
    expect(r.releases).toHaveLength(60);
  });
});

describe('fetchGithubText（.dgst 摘要：只读 github.com、不经镜像）', () => {
  it('非 github.com 地址 → 直接拒绝，不发请求（防把摘要来源交给镜像）', async () => {
    await expect(
      newDownloader().fetchGithubText('https://gh-proxy.org/https://github.com/a.dgst', 1024)
    ).rejects.toThrow(/非 github\.com/);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('200 → 文本（分块拼接）', async () => {
    serve(200, [Buffer.from('SHA2-256= '), Buffer.from('ab'.repeat(32))]);
    await expect(
      newDownloader().fetchGithubText(
        'https://github.com/XTLS/Xray-core/releases/download/v1/x.zip.dgst',
        1024
      )
    ).resolves.toBe(`SHA2-256= ${'ab'.repeat(32)}`);
  });

  it('超过 maxBytes → reject', async () => {
    serve(200, [Buffer.alloc(600), Buffer.alloc(600)]);
    await expect(
      newDownloader().fetchGithubText('https://github.com/a/b/x.dgst', 1000)
    ).rejects.toThrow(/过大/);
  });

  it('404 → reject 且带 status，不回落镜像（只请求一次）', async () => {
    serve(404, [Buffer.from('Not Found')]);
    const err = await newDownloader()
      .fetchGithubText('https://github.com/a/b/x.dgst', 1000)
      .catch((e) => e);
    expect(err.status).toBe(404);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });
});

describe('downloadFile opts（tempPrefix / onProgress）', () => {
  const BODY = Buffer.from('fake xray zip bytes '.repeat(10));
  const SHA = createHash('sha256').update(BODY).digest('hex');

  it('tempPrefix 进入临时文件名；onProgress 按块回调 (已收, Content-Length)', async () => {
    serve(200, [BODY.subarray(0, 50), BODY.subarray(50)], {
      'content-length': String(BODY.length),
    });
    const progress: Array<[number, number]> = [];
    const p = await newDownloader().downloadFile(
      'https://example.com/Xray-linux-64.zip',
      false,
      SHA,
      {
        tempPrefix: 'xray-core-update',
        onProgress: (done, total) => progress.push([done, total]),
      }
    );
    expect(path.basename(p)).toMatch(/^xray-core-update-\d+-[0-9a-f]{8}\.zip$/);
    expect(fs.readFileSync(p)).toEqual(BODY);
    expect(progress).toEqual([
      [50, BODY.length],
      [BODY.length, BODY.length],
    ]);
  });

  it('无 Content-Length → total 为 0（未知）', async () => {
    serve(200, [BODY]);
    const totals: number[] = [];
    await newDownloader().downloadFile('https://example.com/x.zip', false, SHA, {
      onProgress: (_d, total) => totals.push(total),
    });
    expect(totals).toEqual([0]);
  });

  it('onProgress 抛错不影响下载', async () => {
    serve(200, [BODY], { 'content-length': String(BODY.length) });
    const p = await newDownloader().downloadFile('https://example.com/x.zip', false, SHA, {
      onProgress: () => {
        throw new Error('ui gone');
      },
    });
    expect(fs.readFileSync(p)).toEqual(BODY);
  });

  it('不传 opts → 沿用 sing-box 默认前缀（行为不变）', async () => {
    serve(200, [BODY], { 'content-length': String(BODY.length) });
    const p = await newDownloader().downloadFile('https://example.com/core.tar.gz', false, SHA);
    // Windows 上 sing-box 资产恒为 .zip，downloadFile 强制 .zip 扩展名（既有行为）
    const ext = process.platform === 'win32' ? 'zip' : 'tar\\.gz';
    expect(path.basename(p)).toMatch(
      new RegExp(`^sing-box-core-update-\\d+-[0-9a-f]{8}\\.${ext}$`)
    );
  });

  it('GitHub 直连失败 → 镜像重试腿沿用 opts（前缀 / 进度回调 / 摘要）', async () => {
    let call = 0;
    mockRequest.mockImplementation(() => {
      call++;
      const req = new FakeReq();
      if (call === 1) {
        setImmediate(() => req.emit('error', new Error('boom')));
        return req;
      }
      setImmediate(() => {
        const res = new FakeRes();
        res.headers = { 'content-length': String(BODY.length) };
        req.emit('response', res);
        setImmediate(() => {
          res.emit('data', BODY);
          res.emit('end');
        });
      });
      return req;
    });
    const seen: number[] = [];
    const p = await newDownloader().downloadFile(
      'https://github.com/XTLS/Xray-core/releases/download/v26.10.10/Xray-linux-64.zip',
      false,
      SHA,
      { tempPrefix: 'xray-core-update', onProgress: (d) => seen.push(d) }
    );
    expect(call).toBe(2);
    expect(mockRequest.mock.calls[1][0].url).not.toBe(mockRequest.mock.calls[0][0].url);
    expect(path.basename(p)).toMatch(/^xray-core-update-/);
    expect(seen).toEqual([BODY.length]);
  });
});
