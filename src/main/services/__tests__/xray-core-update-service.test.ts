/**
 * XrayCoreUpdateService 单测（零网络、零真实 Xray 进程）：注入假下载器 / 假 execFile / 假 ProxyManager，
 * 用真实文件系统（临时目录）+ 真实 zip 解析走完整条安装链。
 *
 * 钉住的不变量（见服务头注）：
 *  - 列表：10 分钟缓存 + force 绕过 + 并发合并；草稿/低于最低版本剔除；403 → RATE_LIMITED，其它 → NETWORK；
 *  - 摘要：API digest 与 .dgst 交叉核对（不一致 → HASH_MISMATCH）；都没有 → NO_HASH（不下载）；
 *  - 拒装：INVALID_TAG / BELOW_MINIMUM（不打网络）/ NOT_FOUND / DRAFT / NO_ASSET / VERSION_MISMATCH / CONFIG_TEST_FAILED（force 可越过）；
 *  - 单飞锁（BUSY）与代理生命周期在飞（PROXY_BUSY）；
 *  - 换核门控序列 [true,false]（回滚时 [true,false,true,false]，owner='xray'）、停→换→起顺序；重启失败回滚二进制 + 标记；
 *  - 「Xray sidecar 没起来」只在要重启的配置仍含 Xray 节点时算失败（节点已删而未重启 → 不回滚）；
 *  - 用户介入（重启期间停止 / 连接 / 退出，换核或回滚窗口内停止）→ 让位：不回滚、不再起代理；
 *  - 与 sing-box 核更新互斥（CORE_BUSY）；
 *  - custom 文件永不丢（xray.custom-bak，已有不同旧备份先改名留档）；restoreBundled 对 downloaded / custom 的处置；
 *  - Windows 下 xray.exe 被占用 → IN_USE；回滚 / 恢复同样对占用重试。
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-xray-upd-'));

jest.mock('electron', () => ({
  app: { getPath: () => TMP, isPackaged: false, getAppPath: () => TMP, getVersion: () => '9.9.9' },
  net: { request: jest.fn() },
  session: { fromPartition: () => ({ setProxy: async () => undefined }) },
}));
jest.mock('../ResourceManager', () => ({
  resourceManager: { getXrayOverrideDir: () => path.join(TMP, 'unused-xray_core') },
}));
// rename / unlink 默认透传真实实现；IN_USE / 回滚重试用例里临时改成抛 EBUSY / EPERM。
jest.mock('fs/promises', () => {
  const actual = jest.requireActual('fs/promises');
  return {
    ...actual,
    rename: jest.fn((a: string, b: string) => actual.rename(a, b)),
    unlink: jest.fn((p: string) => actual.unlink(p)),
  };
});

import * as fsp from 'fs/promises';
import { XrayCoreUpdateService, XRAY_LIST_TTL_MS } from '../XrayCoreUpdateService';
import { XRAY_MARKER_FILE, detectXraySource } from '../xray-install-marker';
import { crc32 } from '../../utils/zip-extract';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import coreManifest from '../../../shared/core-manifest.json';

const realRename = jest.requireActual('fs/promises').rename as typeof fsp.rename;
const realUnlink = jest.requireActual('fs/promises').unlink as typeof fsp.unlink;
const renameMock = fsp.rename as unknown as jest.Mock;
const unlinkMock = fsp.unlink as unknown as jest.Mock;

afterAll(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ── 夹具 ─────────────────────────────────────────────────────────────────────────────────────────

/** 假 xray 二进制内容：假 execFile 据此报告版本（`xray version`）。 */
const fakeBin = (version: string) => Buffer.from(`fake-xray-${version}\n`.padEnd(64, '#'));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** 最小 zip（deflate；平铺结构同 XTLS 资产：xray[.exe] + geoip.dat + LICENSE）。 */
function makeZip(files: Record<string, Buffer>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc32(data), 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc32(data), 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    const local = Buffer.concat([lh, nameBuf, comp]);
    locals.push(local);
    centrals.push(Buffer.concat([cd, nameBuf]));
    offset += local.length;
  }
  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

interface ReleaseOpts {
  prerelease?: boolean;
  draft?: boolean;
  /** asset.digest 原值；null = API 不给 digest；缺省 = 正确的 sha256:<zip sha>。 */
  digest?: string | null;
  /** release 是否列出 .dgst 资产（缺省 true）。 */
  listsDgst?: boolean;
  /** 资产名（缺省按平台）。 */
  assetName?: string;
}

interface Scenario {
  platform?: NodeJS.Platform;
  arch?: string;
  /** tag → 该 release 的 zip 里 xray 报告的版本（缺省 = tag 版本）。 */
  binVersion?: Record<string, string>;
  release?: Record<string, ReleaseOpts>;
  /** .dgst 文本（缺省 = 正确的 SHA2-256 行）；Error = 取失败。 */
  dgst?: Record<string, string | Error>;
  /** `run -test` 结果（缺省通过）。 */
  configTest?: (bin: string) => { ok: true } | { stderr: string };
  /** 是否写入现役 xray_config.json（缺省 false）。 */
  liveConfig?: boolean;
  proxy?: FakePmOpts | null;
  /** macOS codesign 失败（应只记日志、不阻断安装）。 */
  signFails?: boolean;
  /** configProvider 返回的 servers（缺省 []，即不含 Xray 节点）。 */
  servers?: unknown[];
}

/** 含一个 Xray 节点（VLESS + XHTTP → requiresXrayCore）的配置节点表。 */
const XRAY_SERVERS = [
  {
    id: 'x1',
    name: 'xhttp',
    protocol: 'vless',
    address: 'example.com',
    port: 443,
    network: 'xhttp',
  },
];

interface FakePmOpts {
  running?: boolean;
  busy?: boolean;
  /** start 时据槽位内容决定成败（返回错误文案 = 失败）。 */
  startFails?: (slotContent: string | null) => string | null;
  /** start 后 Xray sidecar 是否在跑（缺省 true）。 */
  xrayRunsAfterStart?: (slotContent: string | null) => boolean;
  /**
   * start 进行中（槽位内容已定、成败未定）时的钩子：模拟用户在「重启中」点停止 / 连接 / 退出。返回 'throw' →
   * 本次 start 以「进程被杀」抛错收场；否则照常完成（被用户 stop 接管时 ProxyManager 吞掉让位、正常返回）。
   */
  duringStart?: (pm: FakePm, slotContent: string | null) => 'throw' | void;
}

type FakePm = ReturnType<typeof makeFakePm>;

/**
 * 假 ProxyManager：记录门控 / 启停序列，并按真实 ProxyManager 的语义维护 getLifecycleRequestCounts（public start/stop
 * 入口各 +1，last = 最近一次）与按 owner 记账的换核门控。userStop / userStart 模拟用户（或退出）发起的请求。
 */
function makeFakePm(o: FakePmOpts, slotPath: () => string) {
  let running = o.running ?? false;
  let xrayRunning = running;
  const events: string[] = [];
  const owners = new Set<string>();
  const counts = { starts: 0, stops: 0, last: null as 'start' | 'stop' | null };
  const slotContent = () => {
    try {
      return fs.readFileSync(slotPath(), 'utf8');
    } catch {
      return null;
    }
  };
  const pm = {
    events,
    gate: [] as boolean[],
    gateOwners: [] as string[],
    getStatus: jest.fn(() => ({ running })),
    isLifecycleBusy: jest.fn(() => o.busy === true),
    setCoreSwapInProgress: jest.fn((b: boolean, owner: string = 'singbox') => {
      pm.gate.push(b);
      pm.gateOwners.push(owner);
      if (b) owners.add(owner);
      else owners.delete(owner);
      events.push(`gate:${b}`);
    }),
    isCoreSwapInProgress: jest.fn(() => owners.size > 0),
    getLifecycleRequestCounts: jest.fn(() => ({ ...counts })),
    stop: jest.fn(async () => {
      counts.stops++;
      counts.last = 'stop';
      events.push('stop');
      running = false;
      xrayRunning = false;
    }),
    start: jest.fn(async () => {
      counts.starts++;
      counts.last = 'start';
      if (owners.size > 0) throw new Error('内核更新进行中，请稍候再试');
      const content = slotContent();
      events.push(`start:${content ? content.split('\n')[0] : 'bundled'}`);
      const err = o.startFails?.(content) ?? null;
      if (err) throw new Error(err);
      if (o.duringStart?.(pm, content) === 'throw') throw new Error('sing-box exited during start');
      if (events[events.length - 1] === 'USER_STOP') return; // 被用户 stop 接管：静默让位，核未起
      running = true;
      xrayRunning = o.xrayRunsAfterStart ? o.xrayRunsAfterStart(content) : true;
    }),
    getXrayStatus: jest.fn(async () => ({ running: xrayRunning })),
    /** 用户停止 / 托盘停止 / 退出 teardownForQuit：计一次 stop 请求。 */
    userStop: () => {
      counts.stops++;
      counts.last = 'stop';
      events.push('USER_STOP');
      running = false;
      xrayRunning = false;
    },
    /** 用户点连接：门控持有时被拒（仍计一次 start 请求，同真实 ProxyManager）；否则接管并起来。 */
    userStart: () => {
      counts.starts++;
      counts.last = 'start';
      if (owners.size > 0) {
        events.push('USER_START_REJECTED');
        return;
      }
      events.push('USER_START');
      running = true;
      xrayRunning = true;
    },
  };
  return pm;
}

function makeEnv(sc: Scenario = {}) {
  const root = fs.mkdtempSync(path.join(TMP, 'env-'));
  const dir = path.join(root, 'xray_core');
  const cfgPath = path.join(root, 'xray_config.json');
  if (sc.liveConfig) fs.writeFileSync(cfgPath, '{"outbounds":[]}');
  const platform = sc.platform ?? 'linux';
  const arch = sc.arch ?? 'x64';
  const exe = platform === 'win32' ? '.exe' : '';
  const binName = `xray${exe}`;
  const defaultAsset =
    platform === 'win32'
      ? 'Xray-windows-64.zip'
      : platform === 'darwin'
        ? arch === 'arm64'
          ? 'Xray-macos-arm64-v8a.zip'
          : 'Xray-macos-64.zip'
        : 'Xray-linux-64.zip';
  const zips = new Map<string, Buffer>();
  const zipFor = (tag: string) => {
    if (!zips.has(tag)) {
      const v = sc.binVersion?.[tag] ?? tag.replace(/^v/, '');
      zips.set(
        tag,
        makeZip({
          [binName]: fakeBin(v),
          'geoip.dat': Buffer.from('geo'),
          LICENSE: Buffer.from('MPL'),
        })
      );
    }
    return zips.get(tag) as Buffer;
  };
  const releaseJson = (tag: string) => {
    const r = sc.release?.[tag] ?? {};
    const assetName = r.assetName ?? defaultAsset;
    const z = zipFor(tag);
    const assets: Record<string, unknown>[] = [
      {
        name: assetName,
        digest: r.digest === undefined ? `sha256:${sha(z)}` : r.digest,
        browser_download_url: `https://github.com/XTLS/Xray-core/releases/download/${tag}/${assetName}`,
      },
    ];
    if (r.listsDgst !== false) assets.push({ name: `${assetName}.dgst` });
    return {
      tag_name: tag,
      name: `Xray-core ${tag}`,
      prerelease: r.prerelease === true,
      draft: r.draft === true,
      published_at: '2026-10-10T00:00:00Z',
      html_url: `https://github.com/XTLS/Xray-core/releases/tag/${tag}`,
      assets,
    };
  };

  const downloader = {
    setUpdateNetwork: jest.fn(),
    fetchGithubJson: jest.fn(async (url: string): Promise<unknown> => {
      const m = /\/releases\/tags\/(v[\d.]+)$/.exec(url);
      if (m) return releaseJson(m[1]);
      throw new Error(`unexpected url ${url}`);
    }),
    fetchGithubText: jest.fn(async (url: string): Promise<string> => {
      const m = /\/download\/(v[\d.]+)\//.exec(url);
      const tag = m ? m[1] : '';
      const custom = sc.dgst?.[tag];
      if (custom instanceof Error) throw custom;
      if (typeof custom === 'string') return custom;
      return `MD5= 00\nSHA1= 11\nSHA2-256= ${sha(zipFor(tag))}\nSHA2-512= ${'f'.repeat(128)}\n`;
    }),
    downloadFile: jest.fn(
      async (
        url: string,
        _isRetry: boolean,
        expected?: string,
        opts?: { tempPrefix?: string; onProgress?: (d: number, t: number) => void }
      ): Promise<string> => {
        const m = /\/download\/(v[\d.]+)\//.exec(url);
        const z = zipFor(m ? m[1] : '');
        opts?.onProgress?.(Math.floor(z.length / 2), z.length);
        opts?.onProgress?.(z.length, z.length);
        if (expected && sha(z) !== expected) {
          throw new Error(`内核完整性校验失败：sha256 期望 ${expected}，实得 ${sha(z)}`);
        }
        const p = path.join(
          root,
          `${opts?.tempPrefix ?? 'dl'}-${Math.random().toString(36).slice(2)}.zip`
        );
        fs.writeFileSync(p, z);
        return p;
      }
    ),
  };

  const execCalls: Array<{ file: string; args: string[] }> = [];
  const execFileFn = jest.fn(
    (
      file: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void
    ) => {
      execCalls.push({ file, args });
      setImmediate(() => {
        if (args[0] === 'version') {
          let content = '';
          try {
            content = fs.readFileSync(file, 'utf8');
          } catch {
            return cb(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), '', '');
          }
          const v = /fake-xray-([\d.]+)/.exec(content)?.[1] ?? '?';
          return cb(
            null,
            `Xray ${v} (Xray, Penetrates Everything.) abc (go1.26 ${platform}/${arch})\n`,
            ''
          );
        }
        if (args[0] === 'run' && args[1] === '-test') {
          const r = sc.configTest?.(file) ?? { ok: true };
          if ('ok' in r) return cb(null, 'Configuration OK.', '');
          return cb(Object.assign(new Error('exit 23'), { code: 23 }), '', r.stderr);
        }
        if (file === 'codesign' && sc.signFails) {
          return cb(new Error('codesign: not permitted'), '', '');
        }
        cb(null, '', ''); // xattr / codesign
      });
    }
  );

  const events: unknown[] = [];
  let clock = 1_000_000;
  const svc = new XrayCoreUpdateService({ addLog: () => {} } as never, {
    downloader: downloader as never,
    overrideDir: () => dir,
    xrayConfigPath: () => cfgPath,
    platform,
    arch,
    execFileFn: execFileFn as never,
    now: () => clock,
    inUseRetryDelayMs: 1,
  });
  svc.setEventSender((channel, payload) => {
    expect(channel).toBe(IPC_CHANNELS.EVENT_XRAY_CORE_INSTALL_PROGRESS);
    events.push(payload);
  });
  svc.setConfigProvider(async () => ({ servers: sc.servers ?? [] }) as never);
  const slot = path.join(dir, binName);
  const pm = sc.proxy === null ? null : makeFakePm(sc.proxy ?? {}, () => slot);
  if (pm) svc.setProxyManager(pm as never);

  return {
    svc,
    pm,
    downloader,
    execCalls,
    events,
    dir,
    root,
    cfgPath,
    slot,
    exe,
    marker: path.join(dir, XRAY_MARKER_FILE),
    advance: (ms: number) => {
      clock += ms;
    },
    readSlot: () => (fs.existsSync(slot) ? fs.readFileSync(slot, 'utf8') : null),
    placeCustom: (content: string) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(slot, content, { mode: 0o755 });
    },
    zipFor,
  };
}

const listRaw = (tags: Array<[string, Partial<{ prerelease: boolean; draft: boolean }>]>) =>
  tags.map(([tag, o]) => ({
    tag_name: tag,
    name: tag,
    prerelease: o.prerelease === true,
    draft: o.draft === true,
    published_at: '2026-10-10T00:00:00Z',
    html_url: `https://github.com/XTLS/Xray-core/releases/tag/${tag}`,
    assets: [{ name: 'Xray-linux-64.zip' }, { name: 'Xray-linux-64.zip.dgst' }],
  }));

beforeEach(() => {
  renameMock.mockImplementation((a: string, b: string) => realRename(a, b));
  unlinkMock.mockImplementation((p: string) => realUnlink(p));
});

// ── listReleases ─────────────────────────────────────────────────────────────────────────────────

describe('listReleases', () => {
  it('per_page=100 拉取；剔除草稿与低于最低版本；新→旧；附随包/最低版本', async () => {
    const env = makeEnv();
    env.downloader.fetchGithubJson.mockResolvedValueOnce(
      listRaw([
        ['v26.3.27', {}],
        ['v26.10.10', { prerelease: true }],
        ['v26.11.1', { draft: true }],
        ['v25.12.8', {}],
      ])
    );
    const list = await env.svc.listReleases();
    expect(env.downloader.fetchGithubJson).toHaveBeenCalledWith(
      'https://api.github.com/repos/XTLS/Xray-core/releases?per_page=100'
    );
    expect(list.releases.map((r) => [r.tag, r.prerelease])).toEqual([
      ['v26.10.10', true],
      ['v26.3.27', false],
    ]);
    expect(list.bundledVersion).toBe(coreManifest.bundledXrayVersion);
    expect(list.minVersion).toBe(coreManifest.minXrayVersion);
    expect(list.fetchedAt).toBe(1_000_000);
  });

  it('10 分钟内命中缓存；force 绕过；过期后重拉', async () => {
    const env = makeEnv();
    env.downloader.fetchGithubJson.mockResolvedValue(listRaw([['v26.3.27', {}]]));
    await env.svc.listReleases();
    env.advance(XRAY_LIST_TTL_MS - 1);
    await env.svc.listReleases();
    expect(env.downloader.fetchGithubJson).toHaveBeenCalledTimes(1);
    await env.svc.listReleases({ force: true });
    expect(env.downloader.fetchGithubJson).toHaveBeenCalledTimes(2);
    env.advance(XRAY_LIST_TTL_MS);
    const list = await env.svc.listReleases();
    expect(env.downloader.fetchGithubJson).toHaveBeenCalledTimes(3);
    expect(list.fetchedAt).toBe(1_000_000 + 2 * XRAY_LIST_TTL_MS - 1);
  });

  it('并发调用合并为一次请求', async () => {
    const env = makeEnv();
    let release!: (v: unknown) => void;
    env.downloader.fetchGithubJson.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const a = env.svc.listReleases();
    const b = env.svc.listReleases({ force: true });
    release(listRaw([['v26.3.27', {}]]));
    const [la, lb] = await Promise.all([a, b]);
    expect(env.downloader.fetchGithubJson).toHaveBeenCalledTimes(1);
    expect(la.releases).toEqual(lb.releases);
  });

  it('403 → code RATE_LIMITED；其它失败 / 非数组 → NETWORK；失败不污染缓存', async () => {
    const env = makeEnv();
    env.downloader.fetchGithubJson.mockRejectedValueOnce(
      Object.assign(new Error('GitHub API 访问频率限制 (403)'), { code: 'RATE_LIMITED' })
    );
    await expect(env.svc.listReleases()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    env.downloader.fetchGithubJson.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(env.svc.listReleases()).rejects.toMatchObject({
      code: 'NETWORK',
      message: 'ECONNRESET',
    });
    env.downloader.fetchGithubJson.mockResolvedValueOnce({ message: 'Not Found' });
    await expect(env.svc.listReleases()).rejects.toMatchObject({ code: 'NETWORK' });
    env.downloader.fetchGithubJson.mockResolvedValueOnce(listRaw([['v26.3.27', {}]]));
    await expect(env.svc.listReleases()).resolves.toMatchObject({
      releases: [expect.objectContaining({ tag: 'v26.3.27' })],
    });
  });
});

// ── install：正常路径 ─────────────────────────────────────────────────────────────────────────────

describe('install：正常路径', () => {
  it('代理未运行：解出 xray → 0755 落位 + 标记；来源 downloaded；不停不起代理；清 staging 与临时包', async () => {
    const env = makeEnv({ release: { 'v26.10.10': { prerelease: true } } });
    const res = await env.svc.install({ tag: 'v26.10.10' });
    expect(res).toEqual({
      ok: true,
      version: '26.10.10',
      tag: 'v26.10.10',
      prerelease: true,
      restarted: false,
    });
    expect(env.readSlot()).toBe(fakeBin('26.10.10').toString());
    // Windows 无执行位（stat 恒为 0o666）；POSIX 才校验 0o755
    if (process.platform !== 'win32') expect(fs.statSync(env.slot).mode & 0o777).toBe(0o755);
    const marker = JSON.parse(fs.readFileSync(env.marker, 'utf8'));
    expect(marker).toEqual({
      tag: 'v26.10.10',
      version: '26.10.10',
      prerelease: true,
      binarySha256: sha(fakeBin('26.10.10')),
      archiveSha256: sha(env.zipFor('v26.10.10')),
      assetName: 'Xray-linux-64.zip',
      installedAt: new Date(1_000_000).toISOString(),
    });
    expect(await detectXraySource(env.dir, 'linux')).toEqual({
      source: 'downloaded',
      tag: 'v26.10.10',
      prerelease: true,
      installedAt: marker.installedAt,
    });
    // 只取 xray：geoip / LICENSE 不落地；staging / 临时 zip 已清
    expect(fs.readdirSync(env.dir).sort()).toEqual([XRAY_MARKER_FILE, 'xray'].sort());
    expect(fs.readdirSync(env.root).filter((n) => n.endsWith('.zip'))).toEqual([]);
    // 代理未运行：门控仍成对（防手动起核撞半替换核），不 stop / start
    expect(env.pm!.gate).toEqual([true, false]);
    expect(env.pm!.stop).not.toHaveBeenCalled();
    expect(env.pm!.start).not.toHaveBeenCalled();
    // 下载 URL 由 tag 拼出（不取 API 的 browser_download_url），且带摘要
    const [url, , expected, opts] = env.downloader.downloadFile.mock.calls[0];
    expect(url).toBe(
      'https://github.com/XTLS/Xray-core/releases/download/v26.10.10/Xray-linux-64.zip'
    );
    expect(expected).toBe(sha(env.zipFor('v26.10.10')));
    expect(opts?.tempPrefix).toBe('xray-core-update');
    // .dgst 直连 github.com
    expect(env.downloader.fetchGithubText.mock.calls[0][0]).toBe(
      'https://github.com/XTLS/Xray-core/releases/download/v26.10.10/Xray-linux-64.zip.dgst'
    );
    expect(env.svc.getInstallState()).toEqual({ installing: null });
  });

  it('接受不带 v 的版本号', async () => {
    const env = makeEnv();
    await expect(env.svc.install({ tag: '26.10.10' })).resolves.toMatchObject({
      ok: true,
      tag: 'v26.10.10',
    });
  });

  it('进度事件：各阶段依次推送、下载带 percent，最后推 null', async () => {
    const env = makeEnv();
    await env.svc.install({ tag: 'v26.10.10' });
    const phases = env.events.map((e) => (e === null ? null : (e as { phase: string }).phase));
    expect(phases.filter((p, i) => p !== phases[i - 1])).toEqual([
      'downloading',
      'verifying',
      'extracting',
      'testing',
      'switching',
      null,
    ]);
    expect(env.events).toContainEqual({
      tag: 'v26.10.10',
      phase: 'downloading',
      percent: 100,
      kind: 'install',
    });
    expect(env.events[env.events.length - 1]).toBeNull();
  });

  it('下载进度节流（~4 次/秒）：同一时刻的多次回调只推首个与 100%', async () => {
    const env = makeEnv();
    env.downloader.downloadFile.mockImplementationOnce(async (_url, _r, _sha, opts) => {
      for (let i = 1; i <= 10; i++) opts?.onProgress?.(i * 10, 100); // 时钟不动
      env.advance(300);
      const p = path.join(env.root, 'dl.zip');
      fs.writeFileSync(p, env.zipFor('v26.10.10'));
      return p;
    });
    await env.svc.install({ tag: 'v26.10.10' });
    const pcts = env.events
      .filter((e) => e && (e as { phase: string }).phase === 'downloading')
      .map((e) => (e as { percent?: number }).percent);
    // 首个 setProgress（无 percent）立即推；节流窗口内的 10%…90% 全被吞，100% 必推
    expect(pcts).toEqual([undefined, 100]);
  });

  it('代理运行中：门控开 → 停 → 换核 → 门控关 → 按当前配置起；restarted=true', async () => {
    const env = makeEnv({ proxy: { running: true } });
    const res = await env.svc.install({ tag: 'v26.10.10' });
    expect(res).toMatchObject({ ok: true, restarted: true });
    expect(env.pm!.events).toEqual(['gate:true', 'stop', 'gate:false', 'start:fake-xray-26.10.10']);
    expect(env.pm!.gateOwners).toEqual(['xray', 'xray']); // 按 owner 记账，不清 sing-box 的门控
    expect(env.pm!.start).toHaveBeenCalledWith({ servers: [] });
    const phases = env.events.map((e) => (e === null ? null : (e as { phase: string }).phase));
    expect(phases).toContain('restarting');
  });

  it('darwin：落位前 xattr -cr + codesign --force -s -（签名失败只记日志、不阻断）', async () => {
    const env = makeEnv({ platform: 'darwin', arch: 'arm64', signFails: true });
    const res = await env.svc.install({ tag: 'v26.10.10' });
    expect(res.ok).toBe(true);
    const sign = env.execCalls.filter((c) => c.file === 'xattr' || c.file === 'codesign');
    expect(sign.map((c) => [c.file, c.args.slice(0, -1)])).toEqual([
      ['xattr', ['-cr']],
      ['codesign', ['--force', '-s', '-']],
    ]);
    expect(path.basename(sign[0].args[sign[0].args.length - 1])).toBe('xray');
    expect(env.downloader.downloadFile.mock.calls[0][0]).toMatch(/Xray-macos-arm64-v8a\.zip$/);
  });
});

// ── install：摘要 ────────────────────────────────────────────────────────────────────────────────

describe('install：摘要（API digest × .dgst）', () => {
  it('两者一致 → 安装', async () => {
    const env = makeEnv();
    await expect(env.svc.install({ tag: 'v26.10.10' })).resolves.toMatchObject({ ok: true });
  });

  it('两者不一致 → HASH_MISMATCH，不下载、槽位不动', async () => {
    const env = makeEnv({ dgst: { 'v26.10.10': `SHA2-256= ${'0'.repeat(64)}\n` } });
    const res = await env.svc.install({ tag: 'v26.10.10' });
    expect(res).toMatchObject({ ok: false, code: 'HASH_MISMATCH' });
    expect(env.downloader.downloadFile).not.toHaveBeenCalled();
    expect(env.readSlot()).toBeNull();
  });

  it('只有 API digest（release 未列 .dgst）→ 不取 .dgst，照装', async () => {
    const env = makeEnv({ release: { 'v26.10.10': { listsDgst: false } } });
    await expect(env.svc.install({ tag: 'v26.10.10' })).resolves.toMatchObject({ ok: true });
    expect(env.downloader.fetchGithubText).not.toHaveBeenCalled();
  });

  it('只有 .dgst（API 无 digest）→ 用 .dgst 摘要', async () => {
    const env = makeEnv({ release: { 'v26.10.10': { digest: null } } });
    await expect(env.svc.install({ tag: 'v26.10.10' })).resolves.toMatchObject({ ok: true });
    expect(env.downloader.downloadFile.mock.calls[0][2]).toBe(sha(env.zipFor('v26.10.10')));
  });

  it('API digest 在、.dgst 取失败 → 照用 digest', async () => {
    const env = makeEnv({ dgst: { 'v26.10.10': new Error('HTTP 502') } });
    await expect(env.svc.install({ tag: 'v26.10.10' })).resolves.toMatchObject({ ok: true });
  });

  it('都没有（无 digest + .dgst 取失败）→ NO_HASH，不下载', async () => {
    const env = makeEnv({
      release: { 'v26.10.10': { digest: null } },
      dgst: { 'v26.10.10': new Error('HTTP 404') },
    });
    await expect(env.svc.install({ tag: 'v26.10.10' })).resolves.toMatchObject({
      ok: false,
      code: 'NO_HASH',
    });
    expect(env.downloader.downloadFile).not.toHaveBeenCalled();
  });

  it('无 digest 且 .dgst 无 SHA2-256 行 → NO_HASH', async () => {
    const env = makeEnv({
      release: { 'v26.10.10': { digest: 'md5:abc' } },
      dgst: { 'v26.10.10': 'MD5= 00\n' },
    });
    await expect(env.svc.install({ tag: 'v26.10.10' })).resolves.toMatchObject({
      ok: false,
      code: 'NO_HASH',
    });
  });

  it('下载器以 code HASH_MISMATCH 拒绝（直连摘要不符、镜像腿又失败）→ 按 code 判 HASH_MISMATCH', async () => {
    const env = makeEnv();
    env.downloader.downloadFile.mockRejectedValueOnce(
      Object.assign(new Error('sha256 mismatch'), { code: 'HASH_MISMATCH' })
    );
    const res = await env.svc.install({ tag: 'v26.10.10' });
    expect(res).toMatchObject({ ok: false, code: 'HASH_MISMATCH' });
    expect(env.readSlot()).toBeNull();
  });

  it('下载内容与摘要不符（镜像投毒）→ HASH_MISMATCH，槽位不动', async () => {
    const env = makeEnv({
      release: { 'v26.10.10': { digest: `sha256:${'1'.repeat(64)}`, listsDgst: false } },
    });
    const res = await env.svc.install({ tag: 'v26.10.10' });
    expect(res).toMatchObject({ ok: false, code: 'HASH_MISMATCH' });
    expect(env.readSlot()).toBeNull();
  });
});

// ── install：拒装 ────────────────────────────────────────────────────────────────────────────────

describe('install：拒装', () => {
  it.each([['latest'], ['v26.10'], ['../../x'], [''], [undefined]])(
    '非法 tag %p → INVALID_TAG，不打网络',
    async (tag) => {
      const env = makeEnv();
      await expect(env.svc.install({ tag })).resolves.toMatchObject({
        ok: false,
        code: 'INVALID_TAG',
      });
      expect(env.downloader.fetchGithubJson).not.toHaveBeenCalled();
    }
  );

  it('低于最低版本（按 tag）→ BELOW_MINIMUM，不打网络', async () => {
    const env = makeEnv();
    await expect(env.svc.install({ tag: 'v25.12.8' })).resolves.toMatchObject({
      ok: false,
      code: 'BELOW_MINIMUM',
    });
    expect(env.downloader.fetchGithubJson).not.toHaveBeenCalled();
  });

  it('GitHub 404 → NOT_FOUND；403 → RATE_LIMITED；其它 → NETWORK', async () => {
    const env = makeEnv();
    env.downloader.fetchGithubJson.mockRejectedValueOnce(
      Object.assign(new Error('GitHub API 错误: 404'), { status: 404 })
    );
    await expect(env.svc.install({ tag: 'v26.10.10' })).resolves.toMatchObject({
      code: 'NOT_FOUND',
    });
    env.downloader.fetchGithubJson.mockRejectedValueOnce(
      Object.assign(new Error('403'), { code: 'RATE_LIMITED', status: 403 })
    );
    await expect(env.svc.install({ tag: 'v26.10.10' })).resolves.toMatchObject({
      code: 'RATE_LIMITED',
    });
    env.downloader.fetchGithubJson.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    await expect(env.svc.install({ tag: 'v26.10.10' })).resolves.toMatchObject({
      code: 'NETWORK',
    });
  });

  it('API 回的 tag 与所选不符 → NOT_FOUND', async () => {
    const env = makeEnv();
    env.downloader.fetchGithubJson.mockResolvedValueOnce({ tag_name: 'v26.9.30', assets: [] });
    await expect(env.svc.install({ tag: 'v26.10.10' })).resolves.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('草稿 → DRAFT', async () => {
    const env = makeEnv({ release: { 'v26.10.10': { draft: true } } });
    await expect(env.svc.install({ tag: 'v26.10.10' })).resolves.toMatchObject({
      code: 'DRAFT',
    });
  });

  it('无本平台资产 → NO_ASSET', async () => {
    const env = makeEnv({ release: { 'v26.10.10': { assetName: 'Xray-freebsd-64.zip' } } });
    await expect(env.svc.install({ tag: 'v26.10.10' })).resolves.toMatchObject({
      ok: false,
      code: 'NO_ASSET',
    });
    expect(env.downloader.downloadFile).not.toHaveBeenCalled();
  });

  it('未打包的平台/架构 → NO_ASSET', async () => {
    const env = makeEnv({ arch: 'ia32' });
    await expect(env.svc.install({ tag: 'v26.10.10' })).resolves.toMatchObject({
      code: 'NO_ASSET',
    });
  });

  it('解出的 `xray version` 与 tag 不符 → VERSION_MISMATCH，槽位与标记不动', async () => {
    const env = makeEnv({ binVersion: { 'v26.10.10': '26.9.30' } });
    env.placeCustom('user-file');
    const res = await env.svc.install({ tag: 'v26.10.10' });
    expect(res).toMatchObject({ ok: false, code: 'VERSION_MISMATCH' });
    expect(res.ok === false && res.detail).toMatch(/26\.9\.30/);
    expect(env.readSlot()).toBe('user-file');
    expect(fs.existsSync(env.marker)).toBe(false);
    expect(fs.readdirSync(env.dir).filter((n) => n.startsWith('.staging-'))).toEqual([]);
  });

  it('现役配置 `run -test` 失败 → CONFIG_TEST_FAILED（带 stderr），不切换；force:true 越过', async () => {
    const env = makeEnv({
      liveConfig: true,
      configTest: () => ({ stderr: 'Failed to build outbound n-abc: unknown field' }),
      proxy: { running: true },
    });
    const res = await env.svc.install({ tag: 'v26.10.10' });
    expect(res).toEqual({
      ok: false,
      code: 'CONFIG_TEST_FAILED',
      detail: 'Failed to build outbound n-abc: unknown field',
    });
    expect(env.readSlot()).toBeNull();
    expect(env.pm!.stop).not.toHaveBeenCalled();
    expect(env.pm!.gate).toEqual([]);
    const testCall = env.execCalls.find((c) => c.args[0] === 'run');
    expect(testCall?.args).toEqual(['run', '-test', '-c', env.cfgPath]);

    env.execCalls.length = 0;
    const forced = await env.svc.install({ tag: 'v26.10.10', force: true });
    expect(forced).toMatchObject({ ok: true, restarted: true });
    expect(env.execCalls.some((c) => c.args[0] === 'run')).toBe(false);
  });

  it('无现役 xray_config.json → 不跑 run -test', async () => {
    const env = makeEnv({ configTest: () => ({ stderr: 'should not run' }) });
    await expect(env.svc.install({ tag: 'v26.10.10' })).resolves.toMatchObject({ ok: true });
    expect(env.execCalls.some((c) => c.args[0] === 'run')).toBe(false);
  });
});

// ── 并发与生命周期 ───────────────────────────────────────────────────────────────────────────────

describe('单飞锁 / 代理生命周期', () => {
  it('安装进行中：再次 install / restoreBundled → BUSY；getInstallState 可见进度；结束后释放', async () => {
    const env = makeEnv();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = env.downloader.fetchGithubJson.getMockImplementation()!;
    env.downloader.fetchGithubJson.mockImplementationOnce(async (url: string) => {
      await gate;
      return orig(url);
    });
    const first = env.svc.install({ tag: 'v26.10.10' });
    // 锁在第一个 await 之前就已置位
    await expect(env.svc.install({ tag: 'v26.10.10' })).resolves.toEqual({
      ok: false,
      code: 'BUSY',
    });
    await expect(env.svc.restoreBundled()).resolves.toEqual({ ok: false, code: 'BUSY' });
    expect(env.svc.getInstallState()).toEqual({
      installing: { tag: 'v26.10.10', phase: 'downloading', kind: 'install' },
    });
    release();
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(env.svc.getInstallState()).toEqual({ installing: null });
    await expect(env.svc.restoreBundled()).resolves.toMatchObject({ ok: true });
  });

  it('失败后锁同样释放', async () => {
    const env = makeEnv({ release: { 'v26.10.10': { draft: true } } });
    await env.svc.install({ tag: 'v26.10.10' });
    env.downloader.fetchGithubJson.mockClear();
    await expect(env.svc.install({ tag: 'v26.10.10' })).resolves.toMatchObject({ code: 'DRAFT' });
  });

  it('代理 start/stop 在飞 → PROXY_BUSY，不打网络', async () => {
    const env = makeEnv({ proxy: { running: true, busy: true } });
    await expect(env.svc.install({ tag: 'v26.10.10' })).resolves.toMatchObject({
      code: 'PROXY_BUSY',
    });
    expect(env.downloader.fetchGithubJson).not.toHaveBeenCalled();
    await expect(env.svc.restoreBundled()).resolves.toMatchObject({ code: 'PROXY_BUSY' });
  });
});

// ── 回滚 ─────────────────────────────────────────────────────────────────────────────────────────

describe('重启失败回滚', () => {
  it('新核起不来 → 回滚原二进制 + 原标记，再起代理；START_FAILED + rolledBack；门控 [t,f,t,f]', async () => {
    const env = makeEnv({
      proxy: {
        running: true,
        startFails: (c) => (c?.includes('26.10.10') ? 'xray sidecar failed: exit 1' : null),
      },
    });
    // 先装一个 26.9.30（运行中）作为原现役
    await expect(env.svc.install({ tag: 'v26.9.30' })).resolves.toMatchObject({ ok: true });
    const prevMarker = fs.readFileSync(env.marker, 'utf8');
    env.pm!.gate.length = 0;
    env.pm!.events.length = 0;

    const res = await env.svc.install({ tag: 'v26.10.10' });
    expect(res).toEqual({
      ok: false,
      code: 'START_FAILED',
      detail: 'xray sidecar failed: exit 1',
      rolledBack: true,
    });
    expect(env.readSlot()).toBe(fakeBin('26.9.30').toString());
    expect(fs.readFileSync(env.marker, 'utf8')).toBe(prevMarker);
    expect(env.pm!.gate).toEqual([true, false, true, false]);
    expect(env.pm!.events).toEqual([
      'gate:true',
      'stop',
      'gate:false',
      'start:fake-xray-26.10.10',
      'gate:true',
      'stop',
      'gate:false',
      'start:fake-xray-26.9.30',
    ]);
    expect((await detectXraySource(env.dir, 'linux')).tag).toBe('v26.9.30');
  });

  it('代理起来了但 Xray sidecar 没起（原先在跑、配置仍含 Xray 节点）→ 同样回滚', async () => {
    const env = makeEnv({
      servers: XRAY_SERVERS,
      proxy: { running: true, xrayRunsAfterStart: (c) => !c?.includes('26.10.10') },
    });
    const res = await env.svc.install({ tag: 'v26.10.10' });
    expect(res).toMatchObject({ ok: false, code: 'START_FAILED', rolledBack: true });
    expect(env.readSlot()).toBeNull(); // 原本是随包核：新槽位文件被移除
    expect(fs.existsSync(env.marker)).toBe(false);
    expect(env.pm!.start).toHaveBeenCalledTimes(2);
  });

  it('Xray 节点已从配置移除而未重启（旧 sidecar 仍在跑）：重启后无 sidecar → 不算失败、不回滚', async () => {
    const env = makeEnv({
      servers: [{ id: 's1', name: 'plain', protocol: 'vless', address: 'example.com', port: 443 }],
      proxy: { running: true, xrayRunsAfterStart: () => false },
    });
    const res = await env.svc.install({ tag: 'v26.10.10' });
    expect(res).toMatchObject({ ok: true, version: '26.10.10', restarted: true });
    expect(env.readSlot()).toBe(fakeBin('26.10.10').toString());
    expect(env.pm!.start).toHaveBeenCalledTimes(1);
    expect(env.pm!.gate).toEqual([true, false]);
  });

  it('force（用户已确认「仍然切换」）：代理起来但 Xray sidecar 没起 → 不回滚，保留新核', async () => {
    const env = makeEnv({
      servers: XRAY_SERVERS,
      liveConfig: true,
      configTest: () => ({ stderr: 'allowInsecure has been removed' }),
      proxy: { running: true, xrayRunsAfterStart: (c) => !c?.includes('26.10.10') },
    });
    await expect(env.svc.install({ tag: 'v26.10.10' })).resolves.toMatchObject({
      ok: false,
      code: 'CONFIG_TEST_FAILED',
    });
    const forced = await env.svc.install({ tag: 'v26.10.10', force: true });
    expect(forced).toMatchObject({
      ok: true,
      version: '26.10.10',
      tag: 'v26.10.10',
      restarted: true,
    });
    expect(env.readSlot()).toBe(fakeBin('26.10.10').toString());
    expect((await detectXraySource(env.dir, 'linux')).source).toBe('downloaded');
    expect(env.pm!.start).toHaveBeenCalledTimes(1);
    expect(env.pm!.gate).toEqual([true, false]);
  });

  it('force 也不放过「代理本身起不来」：start 抛错 → 照旧回滚', async () => {
    const env = makeEnv({
      proxy: {
        running: true,
        startFails: (c) => (c?.includes('26.10.10') ? 'selected xray node failed' : null),
      },
    });
    const res = await env.svc.install({ tag: 'v26.10.10', force: true });
    expect(res).toMatchObject({ ok: false, code: 'START_FAILED', rolledBack: true });
    expect(env.readSlot()).toBeNull();
    expect(fs.existsSync(env.marker)).toBe(false);
    expect(env.pm!.start).toHaveBeenCalledTimes(2);
  });

  it('原先无槽位（随包）：回滚 = 删除新槽位与标记', async () => {
    const env = makeEnv({
      proxy: { running: true, startFails: (c) => (c ? 'boom' : null) },
    });
    const res = await env.svc.install({ tag: 'v26.10.10' });
    expect(res).toMatchObject({ code: 'START_FAILED', rolledBack: true });
    expect(env.readSlot()).toBeNull();
    expect(fs.existsSync(env.marker)).toBe(false);
    expect(env.pm!.events[env.pm!.events.length - 1]).toBe('start:bundled');
  });
});

// ── 用户介入 ─────────────────────────────────────────────────────────────────────────────────────

describe('用户介入（停止 / 连接 / 退出）', () => {
  it('重启中用户点停止（起核被杀抛错）→ 不回滚、不再起；新核留用，ok + restarted:false', async () => {
    const env = makeEnv({
      servers: XRAY_SERVERS,
      proxy: {
        running: true,
        duringStart: (pm, c) => {
          if (!c?.includes('26.10.10')) return;
          pm.userStop();
          return 'throw';
        },
      },
    });
    const res = await env.svc.install({ tag: 'v26.10.10' });
    expect(res).toEqual({
      ok: true,
      version: '26.10.10',
      tag: 'v26.10.10',
      prerelease: false,
      restarted: false,
    });
    expect(env.pm!.events).toEqual([
      'gate:true',
      'stop',
      'gate:false',
      'start:fake-xray-26.10.10',
      'USER_STOP',
    ]);
    expect(env.readSlot()).toBe(fakeBin('26.10.10').toString());
    expect((await detectXraySource(env.dir, 'linux')).source).toBe('downloaded');
    expect(env.pm!.getStatus().running).toBe(false);
  });

  it('重启中用户点停止（起核静默让位、sidecar 不在）→ 同样让位，不把「sidecar 没起」当失败', async () => {
    const env = makeEnv({
      servers: XRAY_SERVERS,
      proxy: {
        running: true,
        duringStart: (pm, c) => {
          if (c?.includes('26.10.10')) pm.userStop();
        },
      },
    });
    const res = await env.svc.install({ tag: 'v26.10.10' });
    expect(res).toMatchObject({ ok: true, restarted: false });
    expect(env.pm!.stop).toHaveBeenCalledTimes(1); // 只有换核前自己那一次
    expect(env.pm!.start).toHaveBeenCalledTimes(1);
    expect(env.readSlot()).toBe(fakeBin('26.10.10').toString());
  });

  it('重启中用户点连接（接管）→ 不回滚、不 stop 掉用户的连接', async () => {
    const env = makeEnv({
      servers: XRAY_SERVERS,
      proxy: {
        running: true,
        duringStart: (pm, c) => {
          if (!c?.includes('26.10.10')) return;
          pm.userStart();
          return 'throw'; // 本次起核被用户的 start 取代
        },
      },
    });
    const res = await env.svc.install({ tag: 'v26.10.10' });
    expect(res).toMatchObject({ ok: true, restarted: false });
    expect(env.pm!.events.slice(-2)).toEqual(['start:fake-xray-26.10.10', 'USER_START']);
    expect(env.pm!.stop).toHaveBeenCalledTimes(1);
    expect(env.pm!.getStatus().running).toBe(true);
  });

  it('换核窗口内用户停止 / 退出 → 换核完成但不再起代理', async () => {
    const env = makeEnv({ proxy: { running: true } });
    renameMock.mockImplementation((a: string, b: string) => {
      if (b === env.slot && a.includes('.staging-')) env.pm!.userStop();
      return realRename(a, b);
    });
    const res = await env.svc.install({ tag: 'v26.10.10' });
    expect(res).toMatchObject({ ok: true, restarted: false });
    expect(env.pm!.events).toEqual(['gate:true', 'stop', 'USER_STOP', 'gate:false']);
    expect(env.pm!.start).not.toHaveBeenCalled();
    expect(env.readSlot()).toBe(fakeBin('26.10.10').toString());
  });

  it('换核窗口内用户先停止再点连接（被门控拒绝）→ 最后意图是运行，照常重启', async () => {
    const env = makeEnv({ proxy: { running: true } });
    renameMock.mockImplementation((a: string, b: string) => {
      if (b === env.slot && a.includes('.staging-')) {
        env.pm!.userStop();
        env.pm!.userStart();
      }
      return realRename(a, b);
    });
    const res = await env.svc.install({ tag: 'v26.10.10' });
    expect(res).toMatchObject({ ok: true, restarted: true });
    expect(env.pm!.events).toEqual([
      'gate:true',
      'stop',
      'USER_STOP',
      'USER_START_REJECTED',
      'gate:false',
      'start:fake-xray-26.10.10',
    ]);
  });

  it('回滚窗口内退出（teardownForQuit 的 stop）→ 回滚二进制但不再起代理', async () => {
    const env = makeEnv({
      proxy: {
        running: true,
        startFails: (c) => (c?.includes('26.10.10') ? 'boom' : null),
      },
    });
    await env.svc.install({ tag: 'v26.9.30' });
    env.pm!.events.length = 0;
    const bak = path.join(env.dir, 'xray.bak');
    renameMock.mockImplementation((a: string, b: string) => {
      if (a === bak && b === env.slot) env.pm!.userStop();
      return realRename(a, b);
    });
    const res = await env.svc.install({ tag: 'v26.10.10' });
    expect(res).toMatchObject({ ok: false, code: 'START_FAILED', rolledBack: true });
    expect(env.readSlot()).toBe(fakeBin('26.9.30').toString());
    expect(env.pm!.events).toEqual([
      'gate:true',
      'stop',
      'gate:false',
      'start:fake-xray-26.10.10',
      'gate:true',
      'stop',
      'USER_STOP',
      'gate:false',
    ]);
  });
});

// ── 与 sing-box 核更新互斥 ──────────────────────────────────────────────────────────────────────

describe('与 sing-box 核更新互斥', () => {
  it('sing-box 核更新在进行 → install / restoreBundled 返回 CORE_BUSY，不打网络、不动代理', async () => {
    const env = makeEnv({ proxy: { running: true } });
    env.placeCustom('user-xray');
    env.svc.setSingboxCoreBusyCheck(() => true);
    await expect(env.svc.install({ tag: 'v26.10.10' })).resolves.toMatchObject({
      ok: false,
      code: 'CORE_BUSY',
    });
    await expect(env.svc.restoreBundled()).resolves.toMatchObject({ ok: false, code: 'CORE_BUSY' });
    expect(env.downloader.fetchGithubJson).not.toHaveBeenCalled();
    expect(env.pm!.events).toEqual([]);
    expect(env.readSlot()).toBe('user-xray');
    expect(env.svc.isBusy()).toBe(false);
  });

  it('换核门控已被另一方（sing-box）持有 → CORE_BUSY', async () => {
    const env = makeEnv({ proxy: { running: true } });
    env.pm!.setCoreSwapInProgress(true); // sing-box 正在替换二进制
    await expect(env.svc.install({ tag: 'v26.10.10' })).resolves.toMatchObject({
      code: 'CORE_BUSY',
    });
    env.pm!.setCoreSwapInProgress(false);
    await expect(env.svc.install({ tag: 'v26.10.10' })).resolves.toMatchObject({ ok: true });
  });

  it('下载期间 sing-box 抢先持有门控 → 换核前复核拒绝（CORE_BUSY），槽位与代理不动', async () => {
    const env = makeEnv({ proxy: { running: true } });
    const orig = env.downloader.downloadFile.getMockImplementation()!;
    env.downloader.downloadFile.mockImplementationOnce(async (...args: Parameters<typeof orig>) => {
      env.pm!.setCoreSwapInProgress(true);
      return orig(...args);
    });
    await expect(env.svc.install({ tag: 'v26.10.10' })).resolves.toMatchObject({
      code: 'CORE_BUSY',
    });
    expect(env.pm!.stop).not.toHaveBeenCalled();
    expect(env.readSlot()).toBeNull();
  });

  it('isBusy()：安装全程（含下载）为 true，结束后 false', async () => {
    const env = makeEnv();
    const seen: boolean[] = [];
    const orig = env.downloader.downloadFile.getMockImplementation()!;
    env.downloader.downloadFile.mockImplementationOnce(async (...args: Parameters<typeof orig>) => {
      seen.push(env.svc.isBusy());
      return orig(...args);
    });
    expect(env.svc.isBusy()).toBe(false);
    await env.svc.install({ tag: 'v26.10.10' });
    expect(seen).toEqual([true]);
    expect(env.svc.isBusy()).toBe(false);
  });
});

// ── custom 文件保护 ───────────────────────────────────────────────────────────────────────────────

describe('自定义文件（custom）永不丢', () => {
  it('安装前槽位是用户文件 → 另存 xray.custom-bak（并作为 xray.bak）', async () => {
    const env = makeEnv();
    env.placeCustom('my-own-xray');
    expect((await detectXraySource(env.dir, 'linux')).source).toBe('custom');
    await expect(env.svc.install({ tag: 'v26.10.10' })).resolves.toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(env.dir, 'xray.custom-bak'), 'utf8')).toBe('my-own-xray');
    expect(fs.readFileSync(path.join(env.dir, 'xray.bak'), 'utf8')).toBe('my-own-xray');
    expect((await detectXraySource(env.dir, 'linux')).source).toBe('downloaded');
  });

  it('已有内容不同的 xray.custom-bak → 旧备份改名留档，不被覆盖', async () => {
    const env = makeEnv();
    env.placeCustom('second-user-file');
    fs.writeFileSync(path.join(env.dir, 'xray.custom-bak'), 'first-user-file');
    await env.svc.install({ tag: 'v26.10.10' });
    const names = fs.readdirSync(env.dir);
    const archived = names.filter((n) => /^xray\.custom-bak-.+/.test(n));
    expect(archived).toHaveLength(1);
    expect(fs.readFileSync(path.join(env.dir, archived[0]), 'utf8')).toBe('first-user-file');
    expect(fs.readFileSync(path.join(env.dir, 'xray.custom-bak'), 'utf8')).toBe('second-user-file');
  });

  it('上一版是应用内安装的 → 只进 xray.bak，不产生 custom-bak', async () => {
    const env = makeEnv();
    await env.svc.install({ tag: 'v26.9.30' });
    await env.svc.install({ tag: 'v26.10.10' });
    expect(fs.existsSync(path.join(env.dir, 'xray.custom-bak'))).toBe(false);
    expect(fs.readFileSync(path.join(env.dir, 'xray.bak'), 'utf8')).toBe(
      fakeBin('26.9.30').toString()
    );
  });

  it('标记在、但槽位文件被用户换掉（哈希不符）→ 按 custom 备份', async () => {
    const env = makeEnv();
    await env.svc.install({ tag: 'v26.9.30' });
    fs.writeFileSync(env.slot, 'user-replaced-it', { mode: 0o755 });
    expect((await detectXraySource(env.dir, 'linux')).source).toBe('custom');
    await env.svc.install({ tag: 'v26.10.10' });
    expect(fs.readFileSync(path.join(env.dir, 'xray.custom-bak'), 'utf8')).toBe('user-replaced-it');
  });
});

// ── restoreBundled ───────────────────────────────────────────────────────────────────────────────

describe('restoreBundled', () => {
  it('downloaded → 删除槽位二进制与标记（不留停放文件）；来源回到 bundled', async () => {
    const env = makeEnv();
    await env.svc.install({ tag: 'v26.10.10' });
    env.pm!.gate.length = 0;
    const res = await env.svc.restoreBundled();
    expect(res).toEqual({ ok: true, restarted: false });
    expect(env.readSlot()).toBeNull();
    expect(fs.existsSync(env.marker)).toBe(false);
    expect(fs.readdirSync(env.dir).filter((n) => n.startsWith('.restore-'))).toEqual([]);
    expect(fs.existsSync(path.join(env.dir, 'xray.custom-bak'))).toBe(false);
    expect((await detectXraySource(env.dir, 'linux')).source).toBe('bundled');
    expect(env.pm!.gate).toEqual([true, false]);
  });

  it('custom → 改名为 xray.custom-bak（不删用户文件）', async () => {
    const env = makeEnv();
    env.placeCustom('my-own-xray');
    await expect(env.svc.restoreBundled()).resolves.toEqual({ ok: true, restarted: false });
    expect(env.readSlot()).toBeNull();
    expect(fs.readFileSync(path.join(env.dir, 'xray.custom-bak'), 'utf8')).toBe('my-own-xray');
  });

  it('代理运行中 → 停 → 移除 → 起（restarted）；进度 kind=restore', async () => {
    const env = makeEnv({ proxy: { running: true } });
    await env.svc.install({ tag: 'v26.10.10' });
    env.pm!.events.length = 0;
    env.events.length = 0;
    await expect(env.svc.restoreBundled()).resolves.toEqual({ ok: true, restarted: true });
    expect(env.pm!.events).toEqual(['gate:true', 'stop', 'gate:false', 'start:bundled']);
    expect(env.events).toContainEqual({
      tag: `v${coreManifest.bundledXrayVersion}`,
      phase: 'switching',
      kind: 'restore',
    });
    expect(env.events[env.events.length - 1]).toBeNull();
  });

  it('随包核起不来 → 回滚到原 downloaded 二进制与标记', async () => {
    const env = makeEnv({
      proxy: { running: true, startFails: (c) => (c ? null : 'bundled xray broken') },
    });
    await env.svc.install({ tag: 'v26.10.10' });
    const prevMarker = fs.readFileSync(env.marker, 'utf8');
    const res = await env.svc.restoreBundled();
    expect(res).toEqual({
      ok: false,
      code: 'START_FAILED',
      detail: 'bundled xray broken',
      rolledBack: true,
    });
    expect(env.readSlot()).toBe(fakeBin('26.10.10').toString());
    expect(fs.readFileSync(env.marker, 'utf8')).toBe(prevMarker);
  });

  it('槽位本就为空 → ok、不动代理；顺手清陈旧标记', async () => {
    const env = makeEnv({ proxy: { running: true } });
    fs.mkdirSync(env.dir, { recursive: true });
    fs.writeFileSync(env.marker, '{}');
    await expect(env.svc.restoreBundled()).resolves.toEqual({ ok: true, restarted: false });
    expect(env.pm!.stop).not.toHaveBeenCalled();
    expect(env.pm!.gate).toEqual([]);
    expect(fs.existsSync(env.marker)).toBe(false);
  });
});

// ── Windows ──────────────────────────────────────────────────────────────────────────────────────

describe('Windows', () => {
  it('xray.exe 被占用（rename EBUSY）→ 重试后 IN_USE；原文件与代理状态复原', async () => {
    const env = makeEnv({ platform: 'win32', proxy: { running: true } });
    env.placeCustom('user-xray-exe');
    renameMock.mockImplementation((a: string, b: string) =>
      a === env.slot
        ? Promise.reject(Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }))
        : realRename(a, b)
    );
    const res = await env.svc.install({ tag: 'v26.10.10' });
    expect(res).toMatchObject({ ok: false, code: 'IN_USE' });
    expect(env.readSlot()).toBe('user-xray-exe');
    // custom 副本已留（无害）；代理按原配置拉回
    expect(env.pm!.events).toEqual(['gate:true', 'stop', 'gate:false', 'start:user-xray-exe']);
    expect(renameMock.mock.calls.filter(([a]) => a === env.slot).length).toBe(5);
  });

  it('回滚时 xray.bak → xray.exe 遇一次 EPERM（刚被杀的进程未释放）→ 重试成功，rolledBack:true、以原核重启', async () => {
    const env = makeEnv({
      platform: 'win32',
      proxy: { running: true, startFails: (c) => (c?.includes('26.10.10') ? 'boom' : null) },
    });
    await expect(env.svc.install({ tag: 'v26.9.30' })).resolves.toMatchObject({ ok: true });
    env.pm!.events.length = 0;
    const bak = path.join(env.dir, 'xray.bak.exe');
    let failed = 0;
    renameMock.mockImplementation((a: string, b: string) => {
      if (a === bak && b === env.slot && failed === 0) {
        failed++;
        return Promise.reject(
          Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
        );
      }
      return realRename(a, b);
    });
    const res = await env.svc.install({ tag: 'v26.10.10' });
    expect(res).toEqual({ ok: false, code: 'START_FAILED', detail: 'boom', rolledBack: true });
    expect(failed).toBe(1);
    expect(env.readSlot()).toBe(fakeBin('26.9.30').toString());
    expect(env.pm!.events[env.pm!.events.length - 1]).toBe('start:fake-xray-26.9.30');
  });

  it('原先无槽位：回滚删除新 xray.exe 遇一次 EBUSY → 重试后删除，以随包核重启', async () => {
    const env = makeEnv({
      platform: 'win32',
      proxy: { running: true, startFails: (c) => (c ? 'boom' : null) },
    });
    let failed = 0;
    unlinkMock.mockImplementation((p: string) => {
      if (p === env.slot && failed === 0) {
        failed++;
        return Promise.reject(Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }));
      }
      return realUnlink(p);
    });
    const res = await env.svc.install({ tag: 'v26.10.10' });
    expect(res).toMatchObject({ ok: false, code: 'START_FAILED', rolledBack: true });
    expect(failed).toBe(1);
    expect(env.readSlot()).toBeNull();
    expect(env.pm!.events[env.pm!.events.length - 1]).toBe('start:bundled');
  });

  it('恢复随包后起不来：回滚把停放的 xray.exe 改回遇一次 EACCES → 重试成功', async () => {
    const env = makeEnv({
      platform: 'win32',
      proxy: { running: true, startFails: (c) => (c ? null : 'bundled xray broken') },
    });
    await env.svc.install({ tag: 'v26.10.10' });
    let failed = 0;
    renameMock.mockImplementation((a: string, b: string) => {
      if (path.basename(a).startsWith('.restore-') && b === env.slot && failed === 0) {
        failed++;
        return Promise.reject(
          Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
        );
      }
      return realRename(a, b);
    });
    const res = await env.svc.restoreBundled();
    expect(res).toMatchObject({ ok: false, code: 'START_FAILED', rolledBack: true });
    expect(failed).toBe(1);
    expect(env.readSlot()).toBe(fakeBin('26.10.10').toString());
  });

  it('正常安装：xray.exe + Xray-windows-64.zip', async () => {
    const env = makeEnv({ platform: 'win32' });
    await expect(env.svc.install({ tag: 'v26.10.10' })).resolves.toMatchObject({ ok: true });
    expect(path.basename(env.slot)).toBe('xray.exe');
    expect(env.readSlot()).toBe(fakeBin('26.10.10').toString());
    expect(env.downloader.downloadFile.mock.calls[0][0]).toMatch(/Xray-windows-64\.zip$/);
  });
});

describe('残留清理', () => {
  it('上次崩溃留下的 .staging-* / .restore-* 在下次安装时被清掉', async () => {
    const env = makeEnv();
    fs.mkdirSync(path.join(env.dir, '.staging-deadbeef'), { recursive: true });
    fs.writeFileSync(path.join(env.dir, '.staging-deadbeef', 'xray'), 'half');
    fs.writeFileSync(path.join(env.dir, '.restore-cafe01'), 'old');
    fs.writeFileSync(path.join(env.dir, 'keep-me'), 'user');
    await env.svc.install({ tag: 'v26.10.10' });
    const names = fs.readdirSync(env.dir);
    expect(names.some((n) => n.startsWith('.staging-') || n.startsWith('.restore-'))).toBe(false);
    expect(names).toContain('keep-me');
  });
});
