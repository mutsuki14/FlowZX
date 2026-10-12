/**
 * CoreUpdateService 版本选择单测：installTag（按 tag 在线安装 sing-box，含预发布）+ listReleases + 预检超时。
 *
 * harness 同 core-swap-gate：真实 CoreUpdateService，spy 私有方法与 coreDownloader（零网络、零真实 sing-box 进程）；
 * 假 ProxyManager 按真实语义维护换核门控（按 owner 记账）与 getLifecycleRequestCounts（public start/stop 各 +1）。
 * core-update-state.json / core-known-bad.json 落在每个用例独立的临时 userData（真实读写，断言固定 / 问题版本 / staged）。
 * 平台无关：资产名按注入的 platform/arch 计算（缺省 linux-x64），落位 / 恢复备份经 spy，不碰文件权限。
 *
 * 钉住的不变量（见 CoreUpdateService「版本选择」节头注）：
 *  - 入口同步 check+set：BUSY（安装 / 更新 / 自动轮次 / 回滚等在飞）、XRAY_BUSY、换核门控被占 → BUSY，均不打网络、不动锁；
 *  - 守卫：INVALID_TAG / PROXY_BUSY / BELOW_MINIMUM / HELPER_REQUIRED（macOS）/ FORK_CONFIRM_REQUIRED（force 越过）；
 *  - release 按 tag 现取：NOT_FOUND / RATE_LIMITED / NETWORK / DRAFT / tag 不符；资产只认精确名（NO_ASSET）、摘要只认 API
 *    digest（NO_HASH）、下载地址必须恰为官方 release 地址；下载 HASH_MISMATCH（下载器 + 落盘独立复核）/ DOWNLOAD_FAILED /
 *    EXTRACT_FAILED；
 *  - 预检：EXEC_FAILED（新核跑不起来，不标记）/ VERSION_MISMATCH / NOT_OFFICIAL / PREFLIGHT_FAILED（标记问题版本、
 *    force 不越过）/ GVISOR_MISSING；
 *  - 换核：门控 [true,false]（owner sing-box）、clearStaged、固定写入 / 清除；代理在跑 → 停 → 换 → 起；
 *  - 起不来 → 撤验证闩、门控内恢复备份、标记问题版本、固定回到换核前、以原核再起（START_FAILED，门控 [t,f,t,f]）；
 *    起不来但原因与内核无关（TUN 地址冲突 / 取消授权 / 提权引导取消 / 端口被占）→ 新核留用、不回滚不标记（START_BLOCKED）；
 *  - 一次只允许一个内核操作：安装进行中回滚 / 手动替换 / 立即应用 → BUSY，自动回滚 / 自动轮次 / 自动落位让开；
 *  - 用户介入（换核窗口 / 重启 / 回滚窗口内停止或连接）→ 让位，不回滚、不再起；
 *  - 善后：临时包与解压目录清理、锁释放、进度推 null；
 *  - listReleases：per_page=100、10 分钟缓存 + force + 并发合并、knownBad / currentVersion 现算、403 → RATE_LIMITED；
 *  - preflightValidate：`version` / `check` 带超时；check 失败摘要取 FATAL 行、detail 带全文。
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as util from 'util';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-install-tag-'));
/** 当前用例的 userData（CoreUpdateService 构造时经 app.getPath('userData') 读一次）。 */
const mockPaths = { userData: TMP };

jest.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'temp' ? TMP : mockPaths.userData),
    getVersion: () => '9.9.9',
    isPackaged: false,
    getAppPath: () => TMP,
  },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
  dialog: { showOpenDialog: jest.fn() },
}));

jest.mock('../ResourceManager', () => ({
  resourceManager: {
    getSingBoxPath: () => '/tmp/flowz-fake/sing-box',
    getSingBoxUpdateTargetPath: () => '/tmp/flowz-fake/sing-box',
    getBundledSingBoxPath: () => '/tmp/flowz-fake/sing-box-bundled',
    ensureCronetBeside: jest.fn(),
  },
}));

import { CoreUpdateService, SINGBOX_LIST_TTL_MS } from '../CoreUpdateService';
import { CoreStartTunPersistentError } from '../core-readiness';
import { resourceManager } from '../ResourceManager';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import { singboxAssetName } from '../../../shared/singbox-release';
import type { SingboxInstallProgress } from '../../../shared/singbox-release';
import coreManifest from '../../../shared/core-manifest.json';

afterAll(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ── 夹具 ─────────────────────────────────────────────────────────────────────────────────────────

const BUNDLED = coreManifest.bundledCoreVersion;
// 目标版本从随包版本推出（随包升级不致夹具失效）：下一 minor 的正式版 / 再下一 minor 的 alpha / 本 minor 的旧 alpha（低于随包）。
const [B_MAJ, B_MIN] = BUNDLED.split('.').map((p) => parseInt(p, 10));
const STABLE = `${B_MAJ}.${B_MIN + 1}.3`;
const PRE = `${B_MAJ}.${B_MIN + 2}.0-alpha.12`;
const BELOW = `${B_MAJ}.${B_MIN}.0-alpha.1`;
const STABLE_TAG = `v${STABLE}`;
const PRE_TAG = `v${PRE}`;

const GVISOR_TAGS = ['with_gvisor', 'with_quic', 'with_naive_outbound', 'with_purego'];
const NO_GVISOR_TAGS = ['with_quic', 'with_naive_outbound', 'with_purego'];

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const archiveFor = (tag: string) => Buffer.from(`fake-archive-${tag}\n`.padEnd(512, '#'));

interface ReleaseOpts {
  prerelease?: boolean;
  draft?: boolean;
  /** API 回的 tag_name（缺省 = 请求的 tag）。 */
  tagName?: string;
  /** 精确资产的 digest 原值；null = API 不给；缺省 = 正确的 sha256:<archive sha>。 */
  digest?: string | null;
  /** 精确资产的 browser_download_url（缺省 = 官方地址）。 */
  browserUrl?: string;
  /** false = 只列 -glibc / -musl 变体，不列精确资产。 */
  exactAsset?: boolean;
}

interface FakePmOpts {
  running?: boolean;
  lifecycleBusy?: boolean;
  /** 当前内核 `sing-box version` 首行（缺省 = 随包官方版本）。 */
  versionLine?: string;
  /** start 是否失败（入参 = 当前活动内核：'old' 或新版本号）。 */
  startFails?: (active: string) => string | null;
  /** start 抛出的具体错误对象（类型 / code 有意义时用；优先于 startFails）。 */
  startThrows?: (active: string) => Error | null;
  /** start 进行中（内核已定、成败未定）钩子：模拟用户在重启中停止 / 连接；'throw' = 本次 start 以进程被杀抛错。 */
  duringStart?: (pm: FakePm) => 'throw' | void;
}

interface Scenario {
  platform?: NodeJS.Platform;
  arch?: string;
  proxy?: FakePmOpts | null;
  release?: Record<string, ReleaseOpts>;
  /** configProvider 返回的 TUN 栈（缺省 'system'）；Error = 读配置失败。 */
  stack?: string | Error;
  /** preflightValidate 结果覆写（缺省：ok、版本 = tag、官方版本行、含 with_gvisor）。 */
  preflight?: (version: string) => Record<string, unknown>;
  /** 下载器返回的字节（缺省 = 与摘要一致的 archive）。 */
  downloadBytes?: (tag: string) => Buffer;
  downloadError?: Error;
  extractError?: Error;
  /** installCoreFromDir 内（已备份后）抛错。 */
  installError?: Error;
  /** installCoreFromDir 内钩子（换核窗口：门控持有中）。 */
  onInstall?: (env: Env) => void;
  /** installCoreFromDir 是否像真实实现一样 arm 首启验证闩。 */
  armOnInstall?: boolean;
  /** restoreBackup 结果（缺省 true）与钩子（回滚窗口内）。 */
  restoreOk?: boolean;
  onRestore?: (env: Env) => void;
}

type FakePm = ReturnType<typeof makeFakePm>;
type Env = ReturnType<typeof makeEnv>;

/** 假 ProxyManager：门控按 owner 记账；public start/stop 各计一次请求（userStop / userStart 模拟用户 / 退出）。 */
function makeFakePm(o: FakePmOpts, core: { active: string }) {
  let running = o.running ?? false;
  const owners = new Set<string>();
  const counts = { starts: 0, stops: 0, last: null as 'start' | 'stop' | null };
  const pm = {
    events: [] as string[],
    gate: [] as boolean[],
    gateOwners: [] as string[],
    getStatus: jest.fn(() => ({ running })),
    isLifecycleBusy: jest.fn(() => o.lifecycleBusy === true),
    setCoreSwapInProgress: jest.fn((b: boolean, owner: string = 'singbox') => {
      pm.gate.push(b);
      pm.gateOwners.push(owner);
      if (b) owners.add(owner);
      else owners.delete(owner);
      pm.events.push(`gate:${b}`);
    }),
    isCoreSwapInProgress: jest.fn(() => owners.size > 0),
    getLifecycleRequestCounts: jest.fn(() => ({ ...counts })),
    getCoreVersion: jest.fn(async () => (core.active === 'old' ? BUNDLED : core.active)),
    getCoreVersionLine: jest.fn(
      async () =>
        o.versionLine ?? `sing-box version ${core.active === 'old' ? BUNDLED : core.active}`
    ),
    refreshCoreVersionAfterExternalReseed: jest.fn(async () => undefined),
    buildPreflightConfigJson: jest.fn(() => null),
    hasNaiveNodes: () => false,
    setAutoRestartSuppressed: jest.fn(),
    stop: jest.fn(async () => {
      counts.stops++;
      counts.last = 'stop';
      pm.events.push('stop');
      running = false;
    }),
    start: jest.fn(async () => {
      counts.starts++;
      counts.last = 'start';
      if (owners.size > 0) throw new Error('内核更新进行中，请稍候再试');
      pm.events.push(`start:${core.active}`);
      if (o.duringStart?.(pm) === 'throw') throw new Error('sing-box exited during start');
      const thrown = o.startThrows?.(core.active) ?? null;
      if (thrown) throw thrown;
      const err = o.startFails?.(core.active) ?? null;
      if (err) throw new Error(err);
      if (pm.events.includes('USER_STOP')) return; // 被用户 stop 接管：静默让位，核未起
      running = true;
    }),
    /** 用户停止 / 托盘停止 / 退出 teardownForQuit：计一次 stop 请求。 */
    userStop: () => {
      counts.stops++;
      counts.last = 'stop';
      pm.events.push('USER_STOP');
      running = false;
    },
    /** 用户点连接：门控持有时被拒（仍计一次 start 请求，同真实 ProxyManager）；否则接管并起来。 */
    userStart: () => {
      counts.starts++;
      counts.last = 'start';
      if (owners.size > 0) {
        pm.events.push('USER_START_REJECTED');
        return;
      }
      pm.events.push('USER_START');
      running = true;
    },
  };
  return pm;
}

const services: CoreUpdateService[] = [];

function makeEnv(sc: Scenario = {}) {
  const root = fs.mkdtempSync(path.join(TMP, 'env-'));
  mockPaths.userData = path.join(root, 'userData');
  fs.mkdirSync(mockPaths.userData);
  const platform = sc.platform ?? 'linux';
  const arch = sc.arch ?? 'x64';
  const logs: string[] = [];
  const svc = new CoreUpdateService({
    addLog: (_lvl: string, msg: string) => logs.push(msg),
  } as never);
  services.push(svc);
  const s = svc as any;
  s.platform = platform;
  s.arch = arch;
  s.swapSettleMs = 0;
  let clock = 1_000_000;
  s.now = () => clock;

  const events: Array<{ channel: string; payload: unknown }> = [];
  svc.setEventSender((channel, payload) => events.push({ channel, payload }));
  svc.setConfigProvider(async () => {
    if (sc.stack instanceof Error) throw sc.stack;
    return { servers: [], tunConfig: { stack: sc.stack ?? 'system' } } as never;
  });
  const core = { active: 'old' };
  const pm = sc.proxy === null ? null : makeFakePm(sc.proxy ?? {}, core);
  if (pm) svc.setProxyManager(pm as never);

  const releaseJson = (tag: string) => {
    const r = sc.release?.[tag] ?? {};
    const v = tag.replace(/^v/, '');
    const exact = singboxAssetName(v, platform, arch) ?? `sing-box-${v}-unknown`;
    const variant = (suffix: string) => ({
      name: exact.replace(/(\.tar\.gz|\.zip)$/, `${suffix}$1`),
      digest: `sha256:${'e'.repeat(64)}`,
      browser_download_url: `https://github.com/SagerNet/sing-box/releases/download/${tag}/${exact.replace(/(\.tar\.gz|\.zip)$/, `${suffix}$1`)}`,
    });
    // API 按名字排序：-glibc / -musl 排在精确名之前（'-' < '.'）——挑选必须按精确名，不能取首个命中。
    const assets: Record<string, unknown>[] = [variant('-glibc'), variant('-musl')];
    if (r.exactAsset !== false) {
      assets.push({
        name: exact,
        digest: r.digest === undefined ? `sha256:${sha(archiveFor(tag))}` : r.digest,
        browser_download_url:
          r.browserUrl ?? `https://github.com/SagerNet/sing-box/releases/download/${tag}/${exact}`,
      });
    }
    return {
      tag_name: r.tagName ?? tag,
      name: v,
      prerelease: r.prerelease ?? /-(alpha|beta|rc)\./.test(v),
      draft: r.draft === true,
      published_at: '2026-10-09T00:00:00Z',
      html_url: `https://github.com/SagerNet/sing-box/releases/tag/${tag}`,
      assets,
    };
  };

  const fetchGithubJson = jest
    .spyOn(s.coreDownloader, 'fetchGithubJson')
    .mockImplementation(async (url: unknown) => {
      const m = /\/releases\/tags\/(v[^/]+)$/.exec(String(url));
      if (m) return releaseJson(m[1]);
      throw new Error(`unexpected url ${String(url)}`);
    });

  const tempFiles: string[] = [];
  const extractDirs: string[] = [];
  const progressPlan: Array<{ fraction: number; advanceMs: number }> = [];
  const downloadFile = jest
    .spyOn(s.coreDownloader, 'downloadFile')
    .mockImplementation(async (url: unknown, _isRetry: unknown, _sha: unknown, opts: any) => {
      const tag = /\/download\/(v[^/]+)\//.exec(String(url))?.[1] ?? '';
      const buf = sc.downloadBytes?.(tag) ?? archiveFor(tag);
      const plan = progressPlan.length
        ? progressPlan
        : [
            { fraction: 0.5, advanceMs: 0 },
            { fraction: 1, advanceMs: 0 },
          ];
      for (const step of plan) {
        clock += step.advanceMs;
        opts?.onProgress?.(Math.floor(buf.length * step.fraction), buf.length);
      }
      if (sc.downloadError) throw sc.downloadError;
      const p = path.join(
        root,
        `${opts?.tempPrefix ?? 'dl'}-${Math.random().toString(36).slice(2)}.tar.gz`
      );
      fs.writeFileSync(p, buf);
      tempFiles.push(p);
      return p;
    });

  const coreName = platform === 'win32' ? 'sing-box.exe' : 'sing-box';
  const extractCore = jest
    .spyOn(s.coreDownloader, 'extractCore')
    .mockImplementation(async (file: unknown) => {
      if (sc.extractError) throw sc.extractError;
      const dir = path.join(root, `sing-box-extracted-${Math.random().toString(36).slice(2)}`);
      const top = path.join(dir, path.basename(String(file)).replace(/\.tar\.gz$/, ''));
      fs.mkdirSync(top, { recursive: true });
      fs.writeFileSync(path.join(top, coreName), 'new-core');
      fs.writeFileSync(path.join(top, 'LICENSE'), 'GPL');
      extractDirs.push(dir);
      return { corePath: path.join(top, coreName), extractDir: dir };
    });

  const preflight = jest
    .spyOn(s, 'preflightValidate')
    .mockImplementation(async (corePath: unknown) => {
      expect(fs.existsSync(String(corePath))).toBe(true);
      // 由 extractCore 解出的目录无从得知 tag → 以最近一次 fetch 的 tag 为准
      const lastUrl = String(fetchGithubJson.mock.calls[fetchGithubJson.mock.calls.length - 1][0]);
      const v = /\/tags\/v(.+)$/.exec(lastUrl)?.[1] ?? '';
      return {
        ok: true,
        version: v,
        versionLine: `sing-box version ${v}`,
        buildTags: GVISOR_TAGS,
        ...(sc.preflight?.(v) ?? {}),
      };
    });

  const installCalls: Array<{ sourceDir: string; version: string; gateHeld: boolean }> = [];
  const install = jest
    .spyOn(s, 'installCoreFromDir')
    .mockImplementation(async (sourceDir: unknown, version: unknown, onBackupDone: any) => {
      installCalls.push({
        sourceDir: String(sourceDir),
        version: String(version),
        gateHeld: pm?.isCoreSwapInProgress() ?? false,
      });
      onBackupDone?.();
      sc.onInstall?.(env);
      if (sc.installError) throw sc.installError;
      core.active = String(version);
      pm?.events.push(`install:${String(version)}`);
      if (sc.armOnInstall) s.armPendingValidation(version);
    });
  const restoreGate: boolean[] = [];
  const restore = jest.spyOn(s, 'restoreBackup').mockImplementation(async () => {
    restoreGate.push(pm?.isCoreSwapInProgress() ?? false);
    pm?.events.push('restore');
    sc.onRestore?.(env);
    if (sc.restoreOk === false) return false;
    core.active = 'old';
    return true;
  });

  const env = {
    svc,
    s,
    pm,
    core,
    root,
    logs,
    events,
    fetchGithubJson,
    downloadFile,
    extractCore,
    preflight,
    install,
    installCalls,
    restore,
    restoreGate,
    tempFiles,
    extractDirs,
    progressPlan,
    advance: (ms: number) => {
      clock += ms;
    },
    progress: () =>
      events
        .filter((e) => e.channel === IPC_CHANNELS.EVENT_CORE_INSTALL_PROGRESS)
        .map((e) => e.payload as SingboxInstallProgress | null),
    autoStatusEvents: () =>
      events.filter((e) => e.channel === IPC_CHANNELS.EVENT_CORE_AUTO_UPDATE_STATUS),
    state: () => s.loadAutoState(),
    knownBad: (v: string) => svc.isKnownBad(v),
  };
  return env;
}

afterEach(() => {
  // 真实 armPendingValidation 会挂 5 分钟兜底 timer；逐个撤掉，免得 jest 挂着不退。
  for (const svc of services.splice(0)) (svc as any).disarmPendingValidation();
  jest.restoreAllMocks();
});

function expectNoSideEffects(env: Env) {
  expect(env.downloadFile).not.toHaveBeenCalled();
  expect(env.install).not.toHaveBeenCalled();
  expect(env.pm?.stop).not.toHaveBeenCalled();
  expect(env.pm?.gate ?? []).toEqual([]);
}

function expectLockReleased(env: Env) {
  expect(env.s.isUpdating).toBe(false);
  expect(env.s.coreOps).toBe(0);
  expect(env.svc.isBusy()).toBe(false);
  expect(env.svc.getInstallState()).toEqual({ installing: null });
}

// ── 正常路径 ─────────────────────────────────────────────────────────────────────────────────────

describe('installTag：正常路径', () => {
  it('代理未运行：按 tag 现取 → 精确资产 → 摘要下载 → 解压 → 预检 → 门控内换核；不停不起，刷新版本缓存', async () => {
    const env = makeEnv();
    const res = await env.svc.installTag({ tag: STABLE_TAG });
    expect(res).toEqual({
      ok: true,
      version: STABLE,
      tag: STABLE_TAG,
      prerelease: false,
      restarted: false,
      pinned: false,
    });
    // 只请求所选 tag 的 release；下载 URL / 摘要 / 临时前缀由主进程决定
    expect(env.fetchGithubJson).toHaveBeenCalledTimes(1);
    expect(env.fetchGithubJson).toHaveBeenCalledWith(
      `https://api.github.com/repos/SagerNet/sing-box/releases/tags/${STABLE_TAG}`
    );
    const asset = `sing-box-${STABLE}-linux-amd64.tar.gz`;
    expect(env.downloadFile).toHaveBeenCalledWith(
      `https://github.com/SagerNet/sing-box/releases/download/${STABLE_TAG}/${asset}`,
      false,
      sha(archiveFor(STABLE_TAG)),
      expect.objectContaining({
        tempPrefix: 'sing-box-core-install',
        onProgress: expect.any(Function),
      })
    );
    // 换核：解压目录（archive 顶层目录，含 sing-box + LICENSE）整目录交 installCoreFromDir，门控持有中
    expect(env.installCalls).toEqual([
      {
        sourceDir: path.dirname(env.preflight.mock.calls[0][0] as string),
        version: STABLE,
        gateHeld: true,
      },
    ]);
    expect(env.pm!.gate).toEqual([true, false]);
    expect(env.pm!.gateOwners).toEqual(['singbox', 'singbox']);
    expect(env.pm!.stop).not.toHaveBeenCalled();
    expect(env.pm!.start).not.toHaveBeenCalled();
    expect(env.pm!.refreshCoreVersionAfterExternalReseed).toHaveBeenCalledTimes(1);
    // 善后：临时包 / 解压目录删除；锁释放
    expect(env.tempFiles.length).toBe(1);
    expect(env.tempFiles.every((p) => !fs.existsSync(p))).toBe(true);
    expect(env.extractDirs.every((p) => !fs.existsSync(p))).toBe(true);
    expectLockReleased(env);
  });

  it('预发布 tag（不带 v 也认）→ prerelease:true；版本号经 tag 规范化', async () => {
    const env = makeEnv();
    const res = await env.svc.installTag({ tag: PRE });
    expect(res).toMatchObject({ ok: true, version: PRE, tag: PRE_TAG, prerelease: true });
  });

  it('代理运行中：门控开 → 停 → 换核 → 门控关 → 按当前配置起；restarted=true', async () => {
    const env = makeEnv({ proxy: { running: true } });
    const res = await env.svc.installTag({ tag: STABLE_TAG });
    expect(res).toMatchObject({ ok: true, restarted: true });
    expect(env.pm!.events).toEqual([
      'gate:true',
      'stop',
      `install:${STABLE}`,
      'gate:false',
      `start:${STABLE}`,
    ]);
    expect(env.pm!.start).toHaveBeenCalledWith(
      expect.objectContaining({ tunConfig: { stack: 'system' } })
    );
    expect(env.pm!.refreshCoreVersionAfterExternalReseed).not.toHaveBeenCalled();
    expectLockReleased(env);
  });

  it('进度事件：各阶段依次推送（下载带 percent），最后推 null；getInstallState 归空', async () => {
    const env = makeEnv({ proxy: { running: true } });
    await env.svc.installTag({ tag: STABLE_TAG });
    const t = STABLE_TAG;
    expect(env.progress()).toEqual([
      { kind: 'install', tag: t, phase: 'downloading' },
      // 同一时刻的 50% 被节流，100% 恒推
      { kind: 'install', tag: t, phase: 'downloading', percent: 100 },
      { kind: 'install', tag: t, phase: 'verifying' },
      { kind: 'install', tag: t, phase: 'extracting' },
      { kind: 'install', tag: t, phase: 'testing' },
      { kind: 'install', tag: t, phase: 'switching' },
      { kind: 'install', tag: t, phase: 'restarting' },
      null,
    ]);
  });

  it('下载进度节流（~4 次/秒）：间隔 ≥250ms 的中间进度才推', async () => {
    const env = makeEnv();
    env.progressPlan.push(
      { fraction: 0.25, advanceMs: 100 }, // 距上次推送 100ms → 不推
      { fraction: 0.5, advanceMs: 200 }, // 300ms → 推
      { fraction: 0.75, advanceMs: 100 }, // 100ms → 不推
      { fraction: 1, advanceMs: 0 } // 100% 恒推
    );
    await env.svc.installTag({ tag: STABLE_TAG });
    const dl = env.progress().filter((p) => p?.phase === 'downloading');
    expect(dl.map((p) => p?.percent)).toEqual([undefined, 50, 100]);
  });

  it('作废暂存的自动更新核（staged 元数据 + 目录），并推自动更新状态', async () => {
    const env = makeEnv();
    const stagedDir = path.join(env.root, 'userData', 'core-staged');
    fs.mkdirSync(stagedDir, { recursive: true });
    fs.writeFileSync(path.join(stagedDir, 'sing-box'), 'staged');
    env.s.saveAutoState({ staged: { version: '9.9.9', dir: stagedDir, stagedAt: 'x' } });
    const res = await env.svc.installTag({ tag: STABLE_TAG });
    expect(res.ok).toBe(true);
    expect(env.state().staged).toBeUndefined();
    expect(fs.existsSync(stagedDir)).toBe(false);
    expect(env.autoStatusEvents().length).toBeGreaterThan(0);
    expect(env.autoStatusEvents()[0].payload).toMatchObject({ staged: null });
  });

  it('换核前不推自动更新状态（卡片收到会执行 `<.bak> version`，撞上随即覆盖 .bak 的备份 → ETXTBSY）；换核后才推 staged:null', async () => {
    let duringSwap = -1;
    const env = makeEnv({ onInstall: (e) => (duringSwap = e.autoStatusEvents().length) });
    const stagedDir = path.join(env.root, 'userData', 'core-staged');
    fs.mkdirSync(stagedDir, { recursive: true });
    env.s.saveAutoState({ staged: { version: '9.9.9', dir: stagedDir, stagedAt: 'x' } });
    await expect(env.svc.installTag({ tag: STABLE_TAG })).resolves.toMatchObject({ ok: true });
    expect(duringSwap).toBe(0);
    expect(env.state().staged).toBeUndefined();
    expect(env.autoStatusEvents()[0].payload).toMatchObject({ staged: null });
  });

  it('pin:true → 写入固定（version / tag / prerelease / pinnedAt）；pin 缺省 → 清掉旧固定', async () => {
    const env = makeEnv();
    const r1 = await env.svc.installTag({ tag: PRE_TAG, pin: true });
    expect(r1).toMatchObject({ ok: true, pinned: true });
    expect(env.state().pinned).toEqual({
      version: PRE,
      tag: PRE_TAG,
      prerelease: true,
      pinnedAt: new Date(1_000_000).toISOString(),
    });
    // 非 true 的 pin（含 'true' 字符串）一律不算固定
    const r2 = await env.svc.installTag({ tag: STABLE_TAG, pin: 'true' });
    expect(r2).toMatchObject({ ok: true, pinned: false });
    expect(env.state().pinned).toBeUndefined();
  });

  it('clearPin：清固定并推状态；无固定时 no-op', async () => {
    const env = makeEnv();
    await env.svc.installTag({ tag: STABLE_TAG, pin: true });
    const before = env.autoStatusEvents().length;
    await env.svc.clearPin();
    expect(env.state().pinned).toBeUndefined();
    expect(env.autoStatusEvents().length).toBe(before + 1);
    await env.svc.clearPin();
    expect(env.autoStatusEvents().length).toBe(before + 1);
  });

  it('macOS + helper 支持 install-core（proto ≥ 5）→ 正常安装 darwin 精确资产', async () => {
    const env = makeEnv({ platform: 'darwin', arch: 'arm64' });
    env.svc.setHelperManager({
      getStatus: async () => ({ ready: true, version: '9', upgradeable: false }),
      installCore: jest.fn(),
    } as never);
    const res = await env.svc.installTag({ tag: STABLE_TAG });
    expect(res.ok).toBe(true);
    expect(String(env.downloadFile.mock.calls[0][0])).toMatch(
      new RegExp(`/sing-box-${STABLE.replace(/\./g, '\\.')}-darwin-arm64\\.tar\\.gz$`)
    );
  });
});

// ── 入口互斥 / 守卫 ───────────────────────────────────────────────────────────────────────────────

describe('installTag：入口互斥（同步 check+set）', () => {
  it('安装进行中：再次 installTag → BUSY；updateCore / 自动轮次 / staged 落位均让开；结束后释放', async () => {
    const env = makeEnv();
    let release!: (v: unknown) => void;
    const realImpl = env.fetchGithubJson.getMockImplementation()!;
    env.fetchGithubJson.mockImplementationOnce(
      (url: unknown) => new Promise((r) => (release = () => r(realImpl(url as string))))
    );
    const first = env.svc.installTag({ tag: STABLE_TAG });
    // 第一个 await 之前已持锁
    expect(env.s.isUpdating).toBe(true);
    expect(env.svc.isBusy()).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(env.svc.getInstallState()).toEqual({
      installing: { kind: 'install', tag: STABLE_TAG, phase: 'downloading' },
    });

    await expect(env.svc.installTag({ tag: PRE_TAG })).resolves.toMatchObject({
      ok: false,
      code: 'BUSY',
    });
    // 带 code：渲染端「检查更新 → 更新」按 code 出本地化文案（不直接显示中文原文）
    await expect(env.svc.updateCore('https://x/sing-box.tar.gz')).rejects.toMatchObject({
      code: 'BUSY',
      message: expect.stringMatching(/更新正在进行中/),
    });
    await expect(env.svc.tryApplyStaged('proxy-stopped')).resolves.toBe('noop');
    await env.svc.runAutoUpdateCycle(); // isUpdating 持有 → 直接返回
    expect(env.fetchGithubJson).toHaveBeenCalledTimes(1);
    // 被拒的调用不得动别人的锁
    expect(env.s.isUpdating).toBe(true);
    expect(env.s.coreOps).toBe(1);

    release(undefined);
    await expect(first).resolves.toMatchObject({ ok: true, tag: STABLE_TAG });
    expectLockReleased(env);
    await expect(env.svc.installTag({ tag: PRE_TAG })).resolves.toMatchObject({ ok: true });
  });

  it('isUpdating 被自动轮次 / updateCore 持有 → BUSY，不打网络、不动锁', async () => {
    const env = makeEnv();
    env.s.isUpdating = true;
    await expect(env.svc.installTag({ tag: STABLE_TAG })).resolves.toMatchObject({
      ok: false,
      code: 'BUSY',
    });
    expect(env.fetchGithubJson).not.toHaveBeenCalled();
    expectNoSideEffects(env);
    expect(env.s.isUpdating).toBe(true);
    expect(env.s.coreOps).toBe(0);
  });

  it('回滚 / 手动替换 / 立即应用在飞（coreOps>0，不持 isUpdating）→ BUSY', async () => {
    const env = makeEnv();
    env.s.coreOps = 1;
    await expect(env.svc.installTag({ tag: STABLE_TAG })).resolves.toMatchObject({
      ok: false,
      code: 'BUSY',
    });
    expect(env.fetchGithubJson).not.toHaveBeenCalled();
    expect(env.s.coreOps).toBe(1);
    expect(env.s.isUpdating).toBe(false);
  });

  it('Xray 版本切换在进行 → XRAY_BUSY，不打网络、不动代理、锁不残留', async () => {
    const env = makeEnv({ proxy: { running: true } });
    env.svc.setXrayBusyCheck(() => true);
    await expect(env.svc.installTag({ tag: STABLE_TAG })).resolves.toMatchObject({
      ok: false,
      code: 'XRAY_BUSY',
      detail: expect.stringMatching(/Xray 内核正在切换/),
    });
    expect(env.fetchGithubJson).not.toHaveBeenCalled();
    expectNoSideEffects(env);
    expectLockReleased(env);
  });

  it('换核门控已被另一方（如 Xray）持有 → BUSY', async () => {
    const env = makeEnv();
    env.pm!.setCoreSwapInProgress(true, 'xray');
    env.pm!.gate.length = 0;
    await expect(env.svc.installTag({ tag: STABLE_TAG })).resolves.toMatchObject({
      ok: false,
      code: 'BUSY',
    });
    expect(env.fetchGithubJson).not.toHaveBeenCalled();
    expectLockReleased(env);
  });

  it('下载期间门控被他方抢占 → 换核前复核拒绝（BUSY），代理与现役核不动', async () => {
    const env = makeEnv({ proxy: { running: true } });
    const realImpl = env.downloadFile.getMockImplementation()!;
    env.downloadFile.mockImplementationOnce(async (...a: any[]) => {
      env.pm!.setCoreSwapInProgress(true, 'xray');
      return (realImpl as any)(...a);
    });
    await expect(env.svc.installTag({ tag: STABLE_TAG })).resolves.toMatchObject({
      ok: false,
      code: 'BUSY',
    });
    expect(env.install).not.toHaveBeenCalled();
    expect(env.pm!.stop).not.toHaveBeenCalled();
    expectLockReleased(env);
  });
});

describe('一次只允许一个内核操作：安装进行中的回滚 / 手动替换 / 立即应用 / 自动回滚 / 自动轮次', () => {
  /** 卡住本次 release 现取（下载阶段之前），返回放行函数。 */
  function holdReleaseFetch(env: Env): () => void {
    let release!: () => void;
    const realImpl = env.fetchGithubJson.getMockImplementation()!;
    env.fetchGithubJson.mockImplementationOnce(
      (url: unknown) => new Promise((r) => (release = () => r(realImpl(url as string))))
    );
    return () => release();
  }
  const stageFake = (env: Env) =>
    env.s.saveAutoState({
      staged: { version: '9.9.9', dir: path.join(env.root, 'no-staged'), stagedAt: 'x' },
    });
  const BUSY_RE = /内核更新正在进行中/;

  it('下载阶段：rollbackCore / applyStagedNow 以 BUSY 拒绝、replaceManualCore 返回 code BUSY；不停代理、不动门控 / .bak；安装照常完成并重启', async () => {
    const env = makeEnv({ proxy: { running: true } });
    stageFake(env);
    jest.spyOn(env.s, 'hasBackup').mockReturnValue(true);
    const bodies = ['rollbackCoreLocked', 'replaceManualCoreLocked', 'applyStagedNowLocked'].map(
      (m) => jest.spyOn(env.s, m)
    );
    const release = holdReleaseFetch(env);
    const installing = env.svc.installTag({ tag: STABLE_TAG });
    await new Promise((r) => setImmediate(r));

    await expect(env.svc.rollbackCore()).rejects.toMatchObject({
      code: 'BUSY',
      message: expect.stringMatching(BUSY_RE),
    });
    await expect(env.svc.replaceManualCore({ filePath: '/tmp/x', force: true })).resolves.toEqual({
      ok: false,
      code: 'BUSY',
      error: expect.stringMatching(BUSY_RE),
    });
    await expect(env.svc.applyStagedNow()).rejects.toMatchObject({ code: 'BUSY' });
    for (const b of bodies) expect(b).not.toHaveBeenCalled();
    expect(env.pm!.stop).not.toHaveBeenCalled();
    expect(env.pm!.gate).toEqual([]);
    // 被拒的调用不动别人的锁
    expect(env.s.coreOps).toBe(1);
    expect(env.s.isUpdating).toBe(true);

    release();
    await expect(installing).resolves.toMatchObject({ ok: true, restarted: true });
    expect(env.pm!.events).toEqual([
      'gate:true',
      'stop',
      `install:${STABLE}`,
      'gate:false',
      `start:${STABLE}`,
    ]);
    expectLockReleased(env);
  });

  it('换核阶段（门控持有中）：回滚 / 手动替换 / 立即应用一律 BUSY，门控不被提前放开', async () => {
    const attempts: Array<Promise<unknown>> = [];
    const gateDuring: boolean[] = [];
    const env = makeEnv({
      proxy: { running: true },
      onInstall: (e) => {
        stageFake(e);
        attempts.push(e.svc.rollbackCore().catch((x: unknown) => x));
        attempts.push(e.svc.replaceManualCore({ filePath: '/tmp/x', force: true }));
        attempts.push(e.svc.applyStagedNow().catch((x: unknown) => x));
        gateDuring.push(e.pm!.isCoreSwapInProgress());
      },
    });
    jest.spyOn(env.s, 'hasBackup').mockReturnValue(true);
    const res = await env.svc.installTag({ tag: STABLE_TAG });
    expect(res).toMatchObject({ ok: true, restarted: true });
    const [rb, rp, ap] = await Promise.all(attempts);
    expect(rb).toMatchObject({ code: 'BUSY' });
    expect(rp).toMatchObject({ ok: false, code: 'BUSY' });
    expect(ap).toMatchObject({ code: 'BUSY' });
    expect(gateDuring).toEqual([true]);
    expect(env.pm!.gate).toEqual([true, false]);
    expect(env.restore).not.toHaveBeenCalled();
    expectLockReleased(env);
  });

  it('安装进行中：首启验证钩子 autoRollbackIfPendingUpdate 不当场回滚（推迟到放锁）、待验证态原样保留；自动轮次 / 自动落位让开', async () => {
    const env = makeEnv();
    env.svc.setConfigProvider(
      async () => ({ servers: [], autoUpdateCore: true, tunConfig: { stack: 'system' } }) as never
    );
    env.s.armPendingValidation('1.2.3');
    const timer = env.s.pendingFallbackTimer;
    const rollback = jest.spyOn(env.svc, 'rollbackCore');
    const check = jest.spyOn(env.s, 'checkUpdate');
    const release = holdReleaseFetch(env);
    const installing = env.svc.installTag({ tag: STABLE_TAG });

    await expect(env.svc.autoRollbackIfPendingUpdate()).resolves.toBe(false);
    expect(rollback).not.toHaveBeenCalled();
    expect(env.s.rollbackDeferred).toBe(true);
    expect(env.s.pendingUpdateVersion).toBe('1.2.3');
    expect(env.s.pendingFallbackTimer).toBe(timer);
    await env.svc.runAutoUpdateCycle();
    expect(check).not.toHaveBeenCalled();
    stageFake(env);
    await expect(env.svc.tryApplyStaged('proxy-stopped')).resolves.toBe('noop');

    release();
    await expect(installing).resolves.toMatchObject({ ok: true });
  });

  it('回滚 / 手动替换在飞（coreOps>0、不持 isUpdating）：自动落位 / 自动轮次让开，再次回滚 / 替换 / 立即应用 → BUSY', async () => {
    const env = makeEnv();
    env.svc.setConfigProvider(
      async () => ({ servers: [], autoUpdateCore: true, tunConfig: { stack: 'system' } }) as never
    );
    const check = jest.spyOn(env.s, 'checkUpdate');
    stageFake(env);
    env.s.coreOps = 1;
    await expect(env.svc.tryApplyStaged('proxy-stopped')).resolves.toBe('noop');
    expect(env.state().staged).toMatchObject({ version: '9.9.9' });
    await env.svc.runAutoUpdateCycle();
    expect(check).not.toHaveBeenCalled();
    await expect(env.svc.rollbackCore()).rejects.toMatchObject({ code: 'BUSY' });
    await expect(env.svc.replaceManualCore({ filePath: '/tmp/x' })).resolves.toMatchObject({
      ok: false,
      code: 'BUSY',
    });
    await expect(env.svc.applyStagedNow()).rejects.toMatchObject({ code: 'BUSY' });
    expect(env.s.coreOps).toBe(1);
    expect(env.s.isUpdating).toBe(false);
  });
});

describe('installTag：守卫（不打网络）', () => {
  it.each([['latest'], ['v1.14'], ['v1.14.3-glibc'], ['../../x'], ['v1.14.3/../x'], [''], [42]])(
    '非法 tag %p → INVALID_TAG',
    async (tag) => {
      const env = makeEnv();
      await expect(env.svc.installTag({ tag })).resolves.toMatchObject({
        ok: false,
        code: 'INVALID_TAG',
      });
      expect(env.fetchGithubJson).not.toHaveBeenCalled();
      expectLockReleased(env);
    }
  );

  it('缺省参数 → INVALID_TAG', async () => {
    const env = makeEnv();
    await expect(env.svc.installTag()).resolves.toMatchObject({ ok: false, code: 'INVALID_TAG' });
  });

  it('代理 start/stop 在飞 → PROXY_BUSY', async () => {
    const env = makeEnv({ proxy: { running: true, lifecycleBusy: true } });
    await expect(env.svc.installTag({ tag: STABLE_TAG })).resolves.toMatchObject({
      ok: false,
      code: 'PROXY_BUSY',
    });
    expect(env.fetchGithubJson).not.toHaveBeenCalled();
    expectNoSideEffects(env);
    expectLockReleased(env);
  });

  it.each([[`v${BELOW}`], ['v1.13.21'], ['v1.0.0']])(
    '低于随包版本 %s → BELOW_MINIMUM（会被启动对齐刷回随包核）',
    async (tag) => {
      const env = makeEnv();
      const res = await env.svc.installTag({ tag });
      expect(res).toMatchObject({ ok: false, code: 'BELOW_MINIMUM' });
      expect((res as { detail: string }).detail).toContain(BUNDLED);
      expect(env.fetchGithubJson).not.toHaveBeenCalled();
    }
  );

  it('等于随包版本可装（最低可选 = 随包版本）', async () => {
    const env = makeEnv();
    await expect(env.svc.installTag({ tag: `v${BUNDLED}` })).resolves.toMatchObject({ ok: true });
  });

  it.each([
    ['无 helper', null],
    ['helper 未就绪', { ready: false, version: '9', upgradeable: false }],
    ['helper proto 4（< 5，无 install-core）', { ready: true, version: '4', upgradeable: true }],
  ])('macOS：%s → HELPER_REQUIRED（否则会写进 .app 内的随包核）', async (_n, status) => {
    const env = makeEnv({ platform: 'darwin', arch: 'arm64' });
    if (status) {
      env.svc.setHelperManager({ getStatus: async () => status, installCore: jest.fn() } as never);
    }
    await expect(env.svc.installTag({ tag: STABLE_TAG })).resolves.toMatchObject({
      ok: false,
      code: 'HELPER_REQUIRED',
    });
    expect(env.fetchGithubJson).not.toHaveBeenCalled();
    expectLockReleased(env);
  });

  it('macOS：helper 状态探测抛错 → HELPER_REQUIRED（失败安全）', async () => {
    const env = makeEnv({ platform: 'darwin', arch: 'x64' });
    env.svc.setHelperManager({
      getStatus: async () => {
        throw new Error('socket closed');
      },
      installCore: jest.fn(),
    } as never);
    await expect(env.svc.installTag({ tag: STABLE_TAG })).resolves.toMatchObject({
      code: 'HELPER_REQUIRED',
    });
  });

  it('Linux 无 helper 不需要 helper（落位 userData/core_update）', async () => {
    const env = makeEnv({ platform: 'linux' });
    await expect(env.svc.installTag({ tag: STABLE_TAG })).resolves.toMatchObject({ ok: true });
  });

  it('当前是第三方内核：未 force → FORK_CONFIRM_REQUIRED；force:true → 安装（fork 由 installCoreFromDir 留作 .bak）', async () => {
    const env = makeEnv({ proxy: { versionLine: `sing-box version ${BUNDLED}-reF1nd` } });
    await expect(env.svc.installTag({ tag: STABLE_TAG })).resolves.toMatchObject({
      ok: false,
      code: 'FORK_CONFIRM_REQUIRED',
    });
    expect(env.fetchGithubJson).not.toHaveBeenCalled();
    expect(env.pm!.getCoreVersionLine).toHaveBeenCalledWith(true); // 守卫读活二进制，不吃缓存
    // 'true' 字符串不算确认
    await expect(env.svc.installTag({ tag: STABLE_TAG, force: 'true' })).resolves.toMatchObject({
      code: 'FORK_CONFIRM_REQUIRED',
    });
    await expect(env.svc.installTag({ tag: STABLE_TAG, force: true })).resolves.toMatchObject({
      ok: true,
    });
    expect(env.install).toHaveBeenCalledTimes(1);
  });
});

describe('installTag：被替换内核的备份在新核判稳后的去留', () => {
  afterEach(() => jest.useRealTimers());

  async function installThenStable(versionLine?: string) {
    const env = makeEnv({ proxy: { running: true, versionLine }, armOnInstall: true });
    await expect(
      env.svc.installTag({ tag: STABLE_TAG, force: versionLine ? true : undefined })
    ).resolves.toMatchObject({ ok: true, restarted: true });
    const bak: string = env.s.getBackupPath();
    fs.mkdirSync(path.dirname(bak), { recursive: true });
    fs.writeFileSync(bak, 'replaced-core');
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    await env.svc.recordSuccessfulVersion(); // 'started' → 稳定观察
    jest.advanceTimersByTime(30_000 + 1);
    return env;
  }

  it('替换的是第三方内核 → 判稳后保留 .bak（确认框承诺可用「回滚」找回）', async () => {
    const env = await installThenStable(`sing-box version ${BUNDLED}-reF1nd`);
    expect(env.svc.hasBackup()).toBe(true);
    expect(env.s.pendingUpdateVersion).toBeNull(); // 待验证态照常解除
  });

  it('替换的是官方内核 → 判稳后照常删除 .bak', async () => {
    const env = await installThenStable();
    expect(env.svc.hasBackup()).toBe(false);
    expect(env.s.pendingUpdateVersion).toBeNull();
  });
});

// ── release / 资产 / 摘要 / 下载 ───────────────────────────────────────────────────────────────────

describe('installTag：release 与资产', () => {
  it('GitHub 404 → NOT_FOUND；403 → RATE_LIMITED；其它 → NETWORK', async () => {
    const env = makeEnv();
    env.fetchGithubJson.mockRejectedValueOnce(
      Object.assign(new Error('GitHub API 请求失败: 404'), { status: 404 })
    );
    await expect(env.svc.installTag({ tag: STABLE_TAG })).resolves.toMatchObject({
      code: 'NOT_FOUND',
    });
    env.fetchGithubJson.mockRejectedValueOnce(
      Object.assign(new Error('GitHub API 访问频率限制 (403)'), { code: 'RATE_LIMITED' })
    );
    await expect(env.svc.installTag({ tag: STABLE_TAG })).resolves.toMatchObject({
      code: 'RATE_LIMITED',
    });
    env.fetchGithubJson.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(env.svc.installTag({ tag: STABLE_TAG })).resolves.toMatchObject({
      code: 'NETWORK',
      detail: 'ECONNRESET',
    });
    expect(env.downloadFile).not.toHaveBeenCalled();
    expectLockReleased(env);
  });

  it('API 回的 tag 与所选不符 / 回包畸形 → NOT_FOUND', async () => {
    const env = makeEnv({ release: { [STABLE_TAG]: { tagName: 'v9.9.9' } } });
    await expect(env.svc.installTag({ tag: STABLE_TAG })).resolves.toMatchObject({
      code: 'NOT_FOUND',
    });
    env.fetchGithubJson.mockResolvedValueOnce({ message: 'Not Found' });
    await expect(env.svc.installTag({ tag: PRE_TAG })).resolves.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(env.downloadFile).not.toHaveBeenCalled();
  });

  it('草稿 → DRAFT', async () => {
    const env = makeEnv({ release: { [STABLE_TAG]: { draft: true } } });
    await expect(env.svc.installTag({ tag: STABLE_TAG })).resolves.toMatchObject({
      code: 'DRAFT',
    });
    expect(env.downloadFile).not.toHaveBeenCalled();
  });

  it('只有 -glibc / -musl 变体、无精确资产 → NO_ASSET（绝不挑变体）', async () => {
    const env = makeEnv({ release: { [STABLE_TAG]: { exactAsset: false } } });
    const res = await env.svc.installTag({ tag: STABLE_TAG });
    expect(res).toMatchObject({ code: 'NO_ASSET' });
    expect((res as { detail: string }).detail).toContain(`sing-box-${STABLE}-linux-amd64.tar.gz`);
    expect(env.downloadFile).not.toHaveBeenCalled();
  });

  it('未打包的平台/架构（linux-arm64）→ NO_ASSET', async () => {
    const env = makeEnv({ arch: 'arm64' });
    await expect(env.svc.installTag({ tag: STABLE_TAG })).resolves.toMatchObject({
      code: 'NO_ASSET',
    });
    expect(env.downloadFile).not.toHaveBeenCalled();
  });

  it.each([
    [
      '镜像地址',
      (t: string, a: string) =>
        `https://gh-proxy.org/https://github.com/SagerNet/sing-box/releases/download/${t}/${a}`,
    ],
    [
      '他人仓库',
      (t: string, a: string) => `https://github.com/evil/sing-box/releases/download/${t}/${a}`,
    ],
    [
      '别的 tag',
      (_t: string, a: string) =>
        `https://github.com/SagerNet/sing-box/releases/download/v0.0.1/${a}`,
    ],
    [
      'http',
      (t: string, a: string) => `http://github.com/SagerNet/sing-box/releases/download/${t}/${a}`,
    ],
  ])('下载地址不是官方 release 地址（%s）→ NO_ASSET，不下载', async (_n, mk) => {
    const asset = `sing-box-${STABLE}-linux-amd64.tar.gz`;
    const env = makeEnv({ release: { [STABLE_TAG]: { browserUrl: mk(STABLE_TAG, asset) } } });
    await expect(env.svc.installTag({ tag: STABLE_TAG })).resolves.toMatchObject({
      code: 'NO_ASSET',
    });
    expect(env.downloadFile).not.toHaveBeenCalled();
  });

  it.each([[null], ['sha512:' + 'a'.repeat(128)], ['sha256:xyz'], ['a'.repeat(64)]])(
    'API 摘要缺席 / 形状不符（%p）→ NO_HASH（上游无 .dgst 兜底，fail-closed），不下载',
    async (digest) => {
      const env = makeEnv({ release: { [STABLE_TAG]: { digest } } });
      await expect(env.svc.installTag({ tag: STABLE_TAG })).resolves.toMatchObject({
        code: 'NO_HASH',
      });
      expect(env.downloadFile).not.toHaveBeenCalled();
      expect(env.install).not.toHaveBeenCalled();
      expectLockReleased(env);
    }
  );

  it('下载器报完整性校验失败（镜像投毒）→ HASH_MISMATCH', async () => {
    const env = makeEnv({
      downloadError: new Error('内核完整性校验失败：sha256 期望 aa，实得 bb'),
    });
    await expect(env.svc.installTag({ tag: STABLE_TAG })).resolves.toMatchObject({
      code: 'HASH_MISMATCH',
    });
    expect(env.extractCore).not.toHaveBeenCalled();
    expect(env.install).not.toHaveBeenCalled();
  });

  it('下载器以 code HASH_MISMATCH 拒绝（直连摘要不符、镜像腿又失败）→ 按 code 判 HASH_MISMATCH，不落成 DOWNLOAD_FAILED', async () => {
    const env = makeEnv({
      downloadError: Object.assign(new Error('sha256 mismatch'), {
        code: 'HASH_MISMATCH',
        cause: new Error('Download failed: 404'),
      }),
    });
    await expect(env.svc.installTag({ tag: STABLE_TAG })).resolves.toMatchObject({
      code: 'HASH_MISMATCH',
    });
    expect(env.extractCore).not.toHaveBeenCalled();
  });

  it('落盘字节与摘要不符（下载器未拦住）→ 独立复核 HASH_MISMATCH，临时包删除', async () => {
    const env = makeEnv({ downloadBytes: () => Buffer.from('tampered') });
    await expect(env.svc.installTag({ tag: STABLE_TAG })).resolves.toMatchObject({
      code: 'HASH_MISMATCH',
    });
    expect(env.extractCore).not.toHaveBeenCalled();
    expect(env.tempFiles.every((p) => !fs.existsSync(p))).toBe(true);
  });

  it('其它下载错误 → DOWNLOAD_FAILED；解压失败 → EXTRACT_FAILED（临时包仍删除）', async () => {
    const env = makeEnv({ downloadError: new Error('下载停滞超时') });
    await expect(env.svc.installTag({ tag: STABLE_TAG })).resolves.toMatchObject({
      code: 'DOWNLOAD_FAILED',
    });
    const env2 = makeEnv({ extractError: new Error('解压失败: tar exited 2') });
    await expect(env2.svc.installTag({ tag: STABLE_TAG })).resolves.toMatchObject({
      code: 'EXTRACT_FAILED',
      detail: expect.stringMatching(/tar exited 2/),
    });
    expect(env2.tempFiles.every((p) => !fs.existsSync(p))).toBe(true);
    expect(env2.preflight).not.toHaveBeenCalled();
  });
});

// ── 预检 ─────────────────────────────────────────────────────────────────────────────────────────

describe('installTag：预检', () => {
  it('解出的内核版本与 tag 不符 → VERSION_MISMATCH（不标记问题版本、不换核）', async () => {
    const env = makeEnv({
      preflight: () => ({ version: '1.14.2', versionLine: 'sing-box version 1.14.2' }),
    });
    await expect(env.svc.installTag({ tag: STABLE_TAG })).resolves.toMatchObject({
      code: 'VERSION_MISMATCH',
    });
    expect(env.install).not.toHaveBeenCalled();
    expect(env.knownBad(STABLE)).toBe(false);
    expect(env.extractDirs.every((p) => !fs.existsSync(p))).toBe(true);
  });

  it('版本行不是官方构建形态 → NOT_OFFICIAL', async () => {
    const env = makeEnv({ preflight: () => ({ versionLine: 'sing-box version unknown' }) });
    await expect(env.svc.installTag({ tag: STABLE_TAG })).resolves.toMatchObject({
      code: 'NOT_OFFICIAL',
    });
    expect(env.install).not.toHaveBeenCalled();
  });

  it('`check` 当前配置失败 → PREFLIGHT_FAILED（detail = check 输出）+ 标记问题版本；force 不越过', async () => {
    const stderr =
      'WARN[0000] stack option in TUN is deprecated\nFATAL[0000] decode config: unknown field "x"';
    const env = makeEnv({
      proxy: { running: true },
      preflight: () => ({ ok: false, reason: '新核心无法解析当前配置：FATAL…', detail: stderr }),
    });
    const res = await env.svc.installTag({ tag: PRE_TAG });
    expect(res).toEqual({ ok: false, code: 'PREFLIGHT_FAILED', detail: stderr });
    expect(env.knownBad(PRE)).toBe(true);
    expect(env.install).not.toHaveBeenCalled();
    expect(env.pm!.stop).not.toHaveBeenCalled(); // 代理继续运行，永不 brick
    // force 只是 fork 确认，不越过预检
    await expect(env.svc.installTag({ tag: PRE_TAG, force: true })).resolves.toMatchObject({
      code: 'PREFLIGHT_FAILED',
    });
    expectLockReleased(env);
  });

  it('新核根本跑不起来（version 为空）→ EXEC_FAILED（与「check 拒绝配置」分开报），不标记问题版本', async () => {
    const env = makeEnv({
      preflight: () => ({
        ok: false,
        version: null,
        versionLine: '',
        reason: '新核心无法执行（架构不符或文件损坏）',
      }),
    });
    await expect(env.svc.installTag({ tag: STABLE_TAG })).resolves.toMatchObject({
      code: 'EXEC_FAILED',
      detail: expect.stringMatching(/无法执行/),
    });
    expect(env.knownBad(STABLE)).toBe(false);
    expect(env.install).not.toHaveBeenCalled();
  });

  describe('gVisor 守卫（新核无 with_gvisor 而 TUN 栈解析为 gvisor / mixed）', () => {
    it.each([
      ['gvisor', 'linux', true],
      ['mixed', 'linux', true],
      ['system', 'linux', false],
      ['system', 'win32', false],
      ['auto', 'win32', true], // Auto 在 Windows / macOS 即 gvisor
      ['auto', 'linux', false], // Auto 在 Linux 即 system
    ])('stack=%s @ %s → 拒装=%p', async (stack, platform, blocked) => {
      const env = makeEnv({
        platform: platform as NodeJS.Platform,
        stack,
        preflight: () => ({ buildTags: NO_GVISOR_TAGS }),
      });
      const res = await env.svc.installTag({ tag: PRE_TAG });
      if (blocked) {
        expect(res).toMatchObject({ ok: false, code: 'GVISOR_MISSING' });
        expect((res as { detail: string }).detail).toMatch(/System/);
        expect(env.install).not.toHaveBeenCalled();
        expect(env.knownBad(PRE)).toBe(false); // 与配置相关，不是版本本身坏
      } else {
        expect(res).toMatchObject({ ok: true });
      }
    });

    it('读配置失败 → 按 Auto 判（Windows 上即拒装，失败安全）', async () => {
      const env = makeEnv({
        platform: 'win32',
        stack: new Error('config locked'),
        preflight: () => ({ buildTags: NO_GVISOR_TAGS }),
      });
      await expect(env.svc.installTag({ tag: PRE_TAG })).resolves.toMatchObject({
        code: 'GVISOR_MISSING',
      });
    });

    it('含 with_gvisor / 版本输出无 Tags 行（无从判断）→ 不拦', async () => {
      const env = makeEnv({ stack: 'gvisor', preflight: () => ({ buildTags: GVISOR_TAGS }) });
      await expect(env.svc.installTag({ tag: PRE_TAG })).resolves.toMatchObject({ ok: true });
      const env2 = makeEnv({ stack: 'gvisor', preflight: () => ({ buildTags: null }) });
      await expect(env2.svc.installTag({ tag: PRE_TAG })).resolves.toMatchObject({ ok: true });
    });
  });
});

// ── 换核失败 / 重启失败回滚 ───────────────────────────────────────────────────────────────────────

describe('installTag：换核失败与重启失败回滚', () => {
  it('落位中途失败（已备份）→ 门控内恢复备份、以原核再起；FAILED', async () => {
    const env = makeEnv({ proxy: { running: true }, installError: new Error('disk full') });
    const res = await env.svc.installTag({ tag: STABLE_TAG, pin: true });
    expect(res).toMatchObject({
      ok: false,
      code: 'FAILED',
      detail: expect.stringMatching(/disk full/),
    });
    expect(env.pm!.events).toEqual(['gate:true', 'stop', 'restore', 'gate:false', 'start:old']);
    expect(env.restoreGate).toEqual([true]);
    expect(env.state().pinned).toBeUndefined(); // 未换成功不写固定
    expectLockReleased(env);
  });

  it('运行中但读不到当前配置 → FAILED，不停代理、不换核', async () => {
    const env = makeEnv({ proxy: { running: true } });
    env.svc.setConfigProvider(async () => null as never);
    await expect(env.svc.installTag({ tag: STABLE_TAG })).resolves.toMatchObject({
      code: 'FAILED',
    });
    expect(env.pm!.stop).not.toHaveBeenCalled();
    expect(env.install).not.toHaveBeenCalled();
  });

  it('新核起不来 → 撤验证闩、门控内恢复备份、标记问题版本、清固定、以原核再起；START_FAILED + rolledBack；门控 [t,f,t,f]', async () => {
    const env = makeEnv({
      proxy: {
        running: true,
        startFails: (active) => (active === 'old' ? null : 'FATAL bad core'),
      },
      armOnInstall: true,
    });
    const res = await env.svc.installTag({ tag: PRE_TAG, pin: true });
    expect(res).toEqual({
      ok: false,
      code: 'START_FAILED',
      detail: 'FATAL bad core',
      rolledBack: true,
    });
    expect(env.pm!.events).toEqual([
      'gate:true',
      'stop',
      `install:${PRE}`,
      'gate:false',
      `start:${PRE}`,
      'gate:true',
      'stop',
      'restore',
      'gate:false',
      'start:old',
    ]);
    expect(env.pm!.gate).toEqual([true, false, true, false]);
    expect(env.pm!.gateOwners.every((o) => o === 'singbox')).toBe(true);
    expect(env.restoreGate).toEqual([true]);
    // 验证闩已撤（原核首启不被当新核观察 / 回滚），自动重启抑制已解除
    expect(env.s.pendingUpdateVersion).toBeNull();
    expect(env.s.pendingFallbackTimer).toBeNull();
    expect(env.pm!.setAutoRestartSuppressed).toHaveBeenLastCalledWith(false);
    expect(env.knownBad(PRE)).toBe(true);
    expect(env.state().pinned).toBeUndefined();
    expect(env.core.active).toBe('old');
    expectLockReleased(env);
  });

  it('回滚本身失败 → START_FAILED + rolledBack:false（detail 说明回滚失败）', async () => {
    const env = makeEnv({
      proxy: { running: true, startFails: (active) => (active === 'old' ? null : 'boom') },
      restoreOk: false,
    });
    const res = await env.svc.installTag({ tag: STABLE_TAG });
    expect(res).toMatchObject({
      ok: false,
      code: 'START_FAILED',
      rolledBack: false,
      detail: expect.stringMatching(/boom；回滚原内核失败/),
    });
  });
});

describe('installTag：重启失败时固定回到换核前', () => {
  const PRIOR = {
    version: BUNDLED,
    tag: `v${BUNDLED}`,
    prerelease: true,
    pinnedAt: '2026-01-01T00:00:00.000Z',
  };

  it.each([[false], [true]])(
    '原先固定着现役版本、本次 pin:%p 的新核起不来 → 回滚后原固定恢复（不因这次失败恢复自动更新）',
    async (pin) => {
      const env = makeEnv({
        proxy: { running: true, startFails: (a) => (a === 'old' ? null : 'FATAL bad core') },
      });
      env.s.saveAutoState({ pinned: PRIOR });
      const res = await env.svc.installTag({ tag: STABLE_TAG, pin });
      expect(res).toMatchObject({ ok: false, code: 'START_FAILED', rolledBack: true });
      expect(env.core.active).toBe('old');
      expect(env.state().pinned).toEqual(PRIOR);
      const statuses = env.autoStatusEvents();
      expect(statuses[statuses.length - 1].payload).toMatchObject({ pinned: PRIOR });
    }
  );

  it('回滚本身失败 → 固定清除（现役核不明，不保留指向原版本的固定）', async () => {
    const env = makeEnv({
      proxy: { running: true, startFails: (a) => (a === 'old' ? null : 'boom') },
      restoreOk: false,
    });
    env.s.saveAutoState({ pinned: PRIOR });
    const res = await env.svc.installTag({ tag: STABLE_TAG, pin: true });
    expect(res).toMatchObject({ ok: false, code: 'START_FAILED', rolledBack: false });
    expect(env.state().pinned).toBeUndefined();
  });

  it('换核成功 / 未重启的路径照常以本次选择覆盖旧固定', async () => {
    const env = makeEnv();
    env.s.saveAutoState({ pinned: PRIOR });
    await expect(env.svc.installTag({ tag: STABLE_TAG })).resolves.toMatchObject({ ok: true });
    expect(env.state().pinned).toBeUndefined();
  });
});

describe('installTag：起不来但原因与内核无关（环境 / 用户）→ 不回滚、不标记、新核留用（START_BLOCKED）', () => {
  it.each([
    [
      'TUN 地址冲突（CoreStartTunPersistentError，FATAL tun-address-conflict）',
      () =>
        new CoreStartTunPersistentError(
          'TUN 地址 172.19.0.1/30 已被其它网卡占用。',
          'tun-address-conflict'
        ),
    ],
    [
      'wintun 适配器创建失败（CoreStartTunPersistentError，FATAL tun-adapter-create）',
      () => new CoreStartTunPersistentError(undefined, 'tun-adapter-create'),
    ],
    ['取消 UAC / 管理员密码框', () => new Error('用户取消了管理员权限请求')],
    [
      '提权引导里点了取消（HELPER_GATE_ABORTED）',
      () => Object.assign(new Error('用户取消了提权助手引导'), { code: 'HELPER_GATE_ABORTED' }),
    ],
    [
      'Linux pkexec 授权被取消',
      () => new Error('TUN 模式需要管理员权限：授权被取消。可手动执行: sudo setcap …'),
    ],
    [
      'clash_api 端口被其它进程占用（起核前）',
      () =>
        Object.assign(new Error('clash_api 端口 9090 被「x」占用'), {
          code: 'CLASH_API_PORT_BUSY_FOREIGN',
        }),
    ],
  ])('%s', async (_name, mk) => {
    const env = makeEnv({
      proxy: { running: true, startThrows: (a) => (a === 'old' ? null : mk()) },
      armOnInstall: true,
    });
    const res = await env.svc.installTag({ tag: PRE_TAG, pin: true });
    expect(res).toEqual({
      ok: false,
      code: 'START_BLOCKED',
      detail: expect.any(String),
      rolledBack: false,
    });
    expect(env.restore).not.toHaveBeenCalled();
    expect(env.knownBad(PRE)).toBe(false);
    expect(env.state().pinned).toMatchObject({ version: PRE });
    expect(env.core.active).toBe(PRE);
    expect(env.pm!.events).toEqual([
      'gate:true',
      'stop',
      `install:${PRE}`,
      'gate:false',
      `start:${PRE}`,
    ]);
    // 首启验证闩保持 armed：之后真正的首启崩溃仍由 autoRollbackIfPendingUpdate 兜底
    expect(env.s.pendingUpdateVersion).toBe(PRE);
    expect(env.pm!.refreshCoreVersionAfterExternalReseed).toHaveBeenCalled();
    expectLockReleased(env);
  });

  it('泛化的权限错误（如新二进制 EACCES）不算环境原因 → 照常回滚并标记', async () => {
    const env = makeEnv({
      proxy: {
        running: true,
        startThrows: (a) =>
          a === 'old' ? null : Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }),
      },
    });
    const res = await env.svc.installTag({ tag: STABLE_TAG });
    expect(res).toMatchObject({ ok: false, code: 'START_FAILED', rolledBack: true });
    expect(env.knownBad(STABLE)).toBe(true);
  });
});

describe('installTag：泛化的 TUN 持续性终态（核未写出 TUN 层 FATAL）→ 照常回滚', () => {
  // Windows TUN + helper：新核在建 wintun 之前就崩（`check` 查不出的运行期 FATAL / panic），重试预算耗尽后 ProxyManager
  // 也会把它收口成 CoreStartTunPersistentError——但 fatalKind 是 'other' / null，成因可能就是新核本身。
  const PRIOR = {
    version: BUNDLED,
    tag: `v${BUNDLED}`,
    prerelease: false,
    pinnedAt: '2026-01-01T00:00:00.000Z',
  };

  it.each([['other' as const], [null]])(
    'fatalKind %p → START_FAILED：恢复备份、标记问题版本、固定回到换核前、以原核再起',
    async (kind) => {
      const env = makeEnv({
        proxy: {
          running: true,
          startThrows: (a) =>
            a === 'old' ? null : new CoreStartTunPersistentError(undefined, kind),
        },
        armOnInstall: true,
      });
      env.s.saveAutoState({ pinned: PRIOR });
      const res = await env.svc.installTag({ tag: PRE_TAG, pin: true });
      expect(res).toMatchObject({ ok: false, code: 'START_FAILED', rolledBack: true });
      expect(env.restore).toHaveBeenCalledTimes(1);
      expect(env.knownBad(PRE)).toBe(true);
      expect(env.state().pinned).toEqual(PRIOR);
      expect(env.core.active).toBe('old');
      expect(env.pm!.events[env.pm!.events.length - 1]).toBe('start:old');
      expect(env.s.pendingUpdateVersion).toBeNull();
    }
  );

  it('恢复的原核也以同样的 TUN 持续性终态失败 → 成因是环境：回滚但不把新版本记为问题版本', async () => {
    const env = makeEnv({
      proxy: { running: true, startThrows: () => new CoreStartTunPersistentError() },
      armOnInstall: true,
    });
    const res = await env.svc.installTag({ tag: PRE_TAG });
    expect(res).toMatchObject({ ok: false, code: 'START_FAILED', rolledBack: true });
    expect(env.core.active).toBe('old');
    expect(env.knownBad(PRE)).toBe(false);
  });

  it('原核再起失败但不是 TUN 持续性终态 → 照常标记问题版本', async () => {
    const env = makeEnv({
      proxy: {
        running: true,
        startThrows: (a) =>
          a === 'old' ? new Error('port in use') : new CoreStartTunPersistentError(),
      },
    });
    const res = await env.svc.installTag({ tag: PRE_TAG });
    expect(res).toMatchObject({ ok: false, code: 'START_FAILED', rolledBack: true });
    expect(env.knownBad(PRE)).toBe(true);
  });
});

describe('首启失败回滚遇上另一内核操作持锁：推迟到放锁后执行，不丢弃、不判稳', () => {
  const autoCfg = async () =>
    ({ servers: [], autoUpdateCore: true, tunConfig: { stack: 'system' } }) as never;

  /** 卡住自动轮次的 GitHub 检查（持 isUpdating），返回放行函数。 */
  function holdAutoCycleCheck(env: Env): () => void {
    let release!: () => void;
    jest.spyOn(env.s, 'checkUpdate').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ hasUpdate: false, currentVersion: BUNDLED });
        })
    );
    return () => release();
  }

  it('自动轮次检查中报错 → 推迟；轮次结束放锁 → 执行回滚（经注入的执行方）并标记问题版本', async () => {
    const env = makeEnv();
    env.svc.setConfigProvider(autoCfg);
    env.s.armPendingValidation('1.2.3');
    jest.spyOn(env.s, 'hasBackup').mockReturnValue(true);
    const rollback = jest.spyOn(env.svc, 'rollbackCore').mockResolvedValue(undefined);
    const ran: boolean[] = [];
    env.svc.setDeferredRollbackHandler(async () => {
      ran.push(await env.svc.autoRollbackIfPendingUpdate());
    });
    const release = holdAutoCycleCheck(env);
    const cycle = env.svc.runAutoUpdateCycle();
    await new Promise((r) => setImmediate(r));
    expect(env.s.isUpdating).toBe(true);

    await expect(env.svc.autoRollbackIfPendingUpdate()).resolves.toBe(false);
    expect(rollback).not.toHaveBeenCalled();
    expect(env.s.rollbackDeferred).toBe(true);
    expect(env.s.pendingUpdateVersion).toBe('1.2.3');

    release();
    await cycle;
    await new Promise((r) => setImmediate(r));
    expect(ran).toEqual([true]);
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(env.knownBad('1.2.3')).toBe(true);
    expect(env.s.rollbackDeferred).toBe(false);
    expect(env.s.pendingUpdateVersion).toBeNull();
    expectLockReleased(env);
  });

  it("'started' 之后报错、被推迟：撤掉稳定观察（不删 .bak、不清待验证态），之后再 'started' 也不重新判稳", async () => {
    const env = makeEnv();
    env.s.armPendingValidation('1.2.3');
    await env.svc.recordSuccessfulVersion();
    expect(env.s.stabilityTimer).not.toBeNull();

    env.s.isUpdating = true; // 无关的持锁方（自动轮次 / 选文件对话框…）
    await expect(env.svc.autoRollbackIfPendingUpdate()).resolves.toBe(false);
    expect(env.s.stabilityTimer).toBeNull();
    await env.svc.recordSuccessfulVersion();
    expect(env.s.stabilityTimer).toBeNull();
    expect(env.s.pendingUpdateVersion).toBe('1.2.3');

    const handler = jest.fn(async () => undefined);
    env.svc.setDeferredRollbackHandler(handler);
    env.s.isUpdating = false;
    env.s.afterCoreOpReleased();
    expect(handler).toHaveBeenCalledTimes(1);
    env.s.afterCoreOpReleased(); // 只执行一次
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('持锁时没有待验证版本 → 不推迟', async () => {
    const env = makeEnv();
    env.s.isUpdating = true;
    await expect(env.svc.autoRollbackIfPendingUpdate()).resolves.toBe(false);
    expect(env.s.rollbackDeferred).toBe(false);
    env.s.isUpdating = false;
  });

  it('installTag 重启：新核在 start() 收尾阶段崩溃（报错被推迟）→ 不报成功，就地回滚（START_FAILED）、作废推迟', async () => {
    const PRIOR = {
      version: BUNDLED,
      tag: `v${BUNDLED}`,
      prerelease: false,
      pinnedAt: '2026-01-01T00:00:00.000Z',
    };
    const hookResults: Array<Promise<boolean>> = [];
    let envRef!: Env;
    const env = makeEnv({
      proxy: {
        running: true,
        // index.ts 的 'error' 监听：新核起来后随即崩溃 → 首启验证钩子（此刻 installTag 持锁）
        duringStart: () => {
          if (envRef.core.active === PRE)
            hookResults.push(envRef.svc.autoRollbackIfPendingUpdate());
        },
      },
      armOnInstall: true,
    });
    envRef = env;
    const handler = jest.fn(async () => undefined);
    env.svc.setDeferredRollbackHandler(handler);
    env.s.saveAutoState({ pinned: PRIOR });

    const res = await env.svc.installTag({ tag: PRE_TAG, pin: true });
    await expect(Promise.all(hookResults)).resolves.toEqual([false]);
    expect(res).toMatchObject({
      ok: false,
      code: 'START_FAILED',
      rolledBack: true,
      detail: expect.stringMatching(/启动后随即退出/),
    });
    expect(env.core.active).toBe('old');
    expect(env.knownBad(PRE)).toBe(true);
    expect(env.state().pinned).toEqual(PRIOR);
    expect(env.s.rollbackDeferred).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    expectLockReleased(env);
  });
});

// ── 用户介入 ─────────────────────────────────────────────────────────────────────────────────────

describe('installTag：用户介入（停止 / 连接 / 退出）', () => {
  it('重启中用户点停止（起核被杀抛错）→ 不回滚、不再起；新核留用，ok + restarted:false，固定保留', async () => {
    const env = makeEnv({
      proxy: {
        running: true,
        duringStart: (pm) => {
          pm.userStop();
          return 'throw';
        },
      },
    });
    const res = await env.svc.installTag({ tag: STABLE_TAG, pin: true });
    expect(res).toMatchObject({ ok: true, restarted: false, pinned: true });
    expect(env.restore).not.toHaveBeenCalled();
    expect(env.pm!.start).toHaveBeenCalledTimes(1);
    expect(env.knownBad(STABLE)).toBe(false);
    expect(env.state().pinned).toMatchObject({ version: STABLE });
    expect(env.core.active).toBe(STABLE);
  });

  it('重启中用户点连接（接管）→ 即便本次 start 报错也不回滚、不 stop 掉用户的连接', async () => {
    const env = makeEnv({
      proxy: {
        running: true,
        duringStart: (pm) => pm.userStart(),
        startFails: (active) => (active === 'old' ? null : 'raced'),
      },
    });
    const res = await env.svc.installTag({ tag: STABLE_TAG });
    expect(res).toMatchObject({ ok: true, restarted: false });
    expect(env.restore).not.toHaveBeenCalled();
    expect(env.pm!.stop).toHaveBeenCalledTimes(1); // 只有换核前那一次
  });

  it('换核窗口内用户停止 / 退出 → 换核完成但不再起代理（刷新版本缓存）', async () => {
    const env = makeEnv({ proxy: { running: true }, onInstall: (e) => e.pm!.userStop() });
    const res = await env.svc.installTag({ tag: STABLE_TAG });
    expect(res).toMatchObject({ ok: true, restarted: false });
    expect(env.pm!.start).not.toHaveBeenCalled();
    expect(env.pm!.refreshCoreVersionAfterExternalReseed).toHaveBeenCalledTimes(1);
  });

  it('换核窗口内用户先停止再点连接（被门控拒绝）→ 最后意图是运行，照常重启', async () => {
    const env = makeEnv({
      proxy: { running: true },
      onInstall: (e) => {
        e.pm!.userStop();
        e.pm!.userStart();
      },
    });
    const res = await env.svc.installTag({ tag: STABLE_TAG });
    expect(res).toMatchObject({ ok: true, restarted: true });
    expect(env.pm!.events).toContain('USER_START_REJECTED');
    expect(env.pm!.events[env.pm!.events.length - 1]).toBe(`start:${STABLE}`);
  });

  it('代理原本没在跑、换核窗口内用户点连接（被门控拒绝）→ 不替用户起代理', async () => {
    const env = makeEnv({ proxy: { running: false }, onInstall: (e) => e.pm!.userStart() });
    const res = await env.svc.installTag({ tag: STABLE_TAG });
    expect(res).toMatchObject({ ok: true, restarted: false });
    expect(env.pm!.start).not.toHaveBeenCalled();
  });

  it('回滚窗口内退出（teardownForQuit 的 stop）→ 回滚二进制但不再起代理', async () => {
    const env = makeEnv({
      proxy: { running: true, startFails: (active) => (active === 'old' ? null : 'bad') },
      onRestore: (e) => e.pm!.userStop(),
    });
    const res = await env.svc.installTag({ tag: STABLE_TAG });
    expect(res).toMatchObject({ ok: false, code: 'START_FAILED', rolledBack: true });
    expect(env.pm!.start).toHaveBeenCalledTimes(1); // 只有新核那一次
    expect(env.pm!.refreshCoreVersionAfterExternalReseed).toHaveBeenCalledTimes(1);
  });
});

// ── 备份：原子落位 ───────────────────────────────────────────────────────────────────────────────

// Windows 的备份经 copyFileElevatedWindows（userData 下 sing-box.exe.bak），不走这条；inode 语义也只在 POSIX 成立。
const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('backupCurrentCore：原子落位（不原地覆盖可能正被执行的 .bak）', () => {
  function arrange() {
    const env = makeEnv();
    env.install.mockRestore();
    const cur = path.join(env.root, 'current-sing-box');
    fs.writeFileSync(cur, 'NEW-CORE');
    jest.spyOn(resourceManager, 'getSingBoxPath').mockReturnValue(cur);
    const bak: string = env.s.getBackupPath();
    fs.mkdirSync(path.dirname(bak), { recursive: true });
    return { env, bak };
  }

  it('写同目录临时名再 rename：执行中的旧 .bak（持有的 inode）不被截断改写；不留临时文件', async () => {
    const { env, bak } = arrange();
    fs.writeFileSync(bak, 'OLD-BACKUP');
    const fd = fs.openSync(bak, 'r'); // 模拟 `<.bak> version` 正在执行：持有旧 inode
    try {
      const inoBefore = fs.fstatSync(fd).ino;
      await env.s.backupCurrentCore();
      expect(fs.readFileSync(bak, 'utf8')).toBe('NEW-CORE');
      expect(fs.statSync(bak).ino).not.toBe(inoBefore);
      expect(fs.readFileSync(fd, 'utf8')).toBe('OLD-BACKUP');
    } finally {
      fs.closeSync(fd);
    }
    expect(fs.existsSync(`${bak}.tmp`)).toBe(false);
  });

  it('落位失败 → 删临时文件并抛错（调用方据此不认为已备份）', async () => {
    const { env, bak } = arrange();
    // .bak 位置是个非空目录 → rename 失败（复制到临时名已成功）
    fs.mkdirSync(bak, { recursive: true });
    fs.writeFileSync(path.join(bak, 'x'), 'x');
    await expect(env.s.backupCurrentCore()).rejects.toBeTruthy();
    expect(fs.existsSync(`${bak}.tmp`)).toBe(false);
    expect(fs.readFileSync(path.join(bak, 'x'), 'utf8')).toBe('x');
  });
});

// ── listReleases ─────────────────────────────────────────────────────────────────────────────────

describe('listReleases', () => {
  const listRaw = (tags: Array<[string, Partial<{ prerelease: boolean; draft: boolean }>]>) =>
    tags.map(([tag, o]) => ({
      tag_name: tag,
      name: tag,
      prerelease: o.prerelease === true,
      draft: o.draft === true,
      published_at: '2026-10-10T00:00:00Z',
      html_url: `https://github.com/SagerNet/sing-box/releases/tag/${tag}`,
      assets: [
        { name: `sing-box-${tag.slice(1)}-linux-amd64-glibc.tar.gz` },
        { name: `sing-box-${tag.slice(1)}-linux-amd64.tar.gz` },
      ],
    }));
  // API 时间序（分支交错）≠ 版本序
  const raw = listRaw([
    [PRE_TAG, { prerelease: true }],
    [STABLE_TAG, {}],
    [`v${BELOW}`, { prerelease: true }],
    ['v1.13.21', {}],
    [`v${B_MAJ}.${B_MIN + 1}.2`, {}],
    [`v${B_MAJ}.${B_MIN + 3}.0-alpha.1`, { prerelease: true, draft: true }],
  ]);

  it('per_page=100 拉取；剔除草稿 / 低于随包 / 无精确资产；semver 新→旧；附随包与当前版本（读缓存，不 spawn）', async () => {
    const env = makeEnv();
    env.fetchGithubJson.mockResolvedValueOnce(raw);
    const list = await env.svc.listReleases();
    expect(env.fetchGithubJson).toHaveBeenCalledWith(
      'https://api.github.com/repos/SagerNet/sing-box/releases?per_page=100'
    );
    expect(list.releases.map((r) => [r.tag, r.prerelease, r.channel])).toEqual([
      [PRE_TAG, true, 'alpha'],
      [STABLE_TAG, false, 'stable'],
      [`v${B_MAJ}.${B_MIN + 1}.2`, false, 'stable'],
    ]);
    expect(list.releases[0].assetName).toBe(`sing-box-${PRE}-linux-amd64.tar.gz`);
    expect(list.bundledVersion).toBe(BUNDLED);
    expect(list.currentVersion).toBe(BUNDLED);
    expect(env.pm!.getCoreVersion).toHaveBeenCalledWith(false);
    expect(list.fetchedAt).toBe(1_000_000);
  });

  it('knownBad 每次现算（缓存命中也反映最新的问题版本名单）', async () => {
    const env = makeEnv();
    env.fetchGithubJson.mockResolvedValue(raw);
    const a = await env.svc.listReleases();
    expect(a.releases.every((r) => r.knownBad === false)).toBe(true);
    env.s.markKnownBad(STABLE);
    const b = await env.svc.listReleases();
    expect(env.fetchGithubJson).toHaveBeenCalledTimes(1);
    expect(b.releases.find((r) => r.tag === STABLE_TAG)?.knownBad).toBe(true);
  });

  it('10 分钟内命中缓存；force 绕过；过期后重拉', async () => {
    const env = makeEnv();
    env.fetchGithubJson.mockResolvedValue(raw);
    await env.svc.listReleases();
    env.advance(SINGBOX_LIST_TTL_MS - 1);
    await env.svc.listReleases();
    expect(env.fetchGithubJson).toHaveBeenCalledTimes(1);
    await env.svc.listReleases({ force: true });
    expect(env.fetchGithubJson).toHaveBeenCalledTimes(2);
    env.advance(SINGBOX_LIST_TTL_MS);
    const list = await env.svc.listReleases();
    expect(env.fetchGithubJson).toHaveBeenCalledTimes(3);
    expect(list.fetchedAt).toBe(1_000_000 + 2 * SINGBOX_LIST_TTL_MS - 1);
  });

  it('并发调用合并为一次请求（含 force）', async () => {
    const env = makeEnv();
    let release!: (v: unknown) => void;
    env.fetchGithubJson.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const a = env.svc.listReleases();
    const b = env.svc.listReleases({ force: true });
    release(raw);
    const [la, lb] = await Promise.all([a, b]);
    expect(env.fetchGithubJson).toHaveBeenCalledTimes(1);
    expect(la.releases).toEqual(lb.releases);
  });

  it('403 → code RATE_LIMITED；其它失败 / 非数组 → NETWORK；失败不污染缓存', async () => {
    const env = makeEnv();
    env.fetchGithubJson.mockRejectedValueOnce(
      Object.assign(new Error('GitHub API 访问频率限制 (403)'), { code: 'RATE_LIMITED' })
    );
    await expect(env.svc.listReleases()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    env.fetchGithubJson.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(env.svc.listReleases()).rejects.toMatchObject({
      code: 'NETWORK',
      message: 'ECONNRESET',
    });
    env.fetchGithubJson.mockResolvedValueOnce({ message: 'Not Found' });
    await expect(env.svc.listReleases()).rejects.toMatchObject({ code: 'NETWORK' });
    env.fetchGithubJson.mockResolvedValueOnce(raw);
    await expect(env.svc.listReleases()).resolves.toMatchObject({
      releases: expect.arrayContaining([expect.objectContaining({ tag: STABLE_TAG })]),
    });
  });

  it('无 ProxyManager → currentVersion 为「未知」', async () => {
    const env = makeEnv({ proxy: null });
    env.fetchGithubJson.mockResolvedValueOnce(raw);
    await expect(env.svc.listReleases()).resolves.toMatchObject({ currentVersion: '未知' });
  });
});

// ── preflightValidate：execFile 超时 / check 输出 ───────────────────────────────────────────────

describe('preflightValidate：子进程超时与 check 输出', () => {
  /** 以带 util.promisify.custom 的假 execFile 替换 child_process.execFile（被测代码调用时现取 require）。 */
  function withFakeExecFile(
    impl: (file: string, args: string[], opts: Record<string, unknown>) => Promise<unknown>
  ) {
    const cp = require('child_process');
    const orig = cp.execFile;
    const calls: Array<{ file: string; args: string[]; opts: Record<string, unknown> }> = [];
    const fake: any = () => {
      throw new Error('callback form not expected');
    };
    fake[util.promisify.custom] = (file: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ file, args, opts });
      return impl(file, args, opts);
    };
    cp.execFile = fake;
    return { calls, restore: () => (cp.execFile = orig) };
  }

  const versionOut = (v: string, tags: string[]) =>
    `sing-box version ${v}\n\nEnvironment: go1.26.8 linux/amd64\nTags: ${tags.join(',')}\nRevision: abc\nCGO: disabled\n`;

  it('`version` / `check` 均带超时；解析版本行与构建 tag', async () => {
    const env = makeEnv();
    env.preflight.mockRestore();
    env.pm!.buildPreflightConfigJson.mockReturnValue('{"log":{}}' as never);
    const fx = withFakeExecFile(async (_f, args) =>
      args[0] === 'version'
        ? { stdout: versionOut(PRE, NO_GVISOR_TAGS), stderr: '' }
        : { stdout: '', stderr: '' }
    );
    try {
      const r = await env.s.preflightValidate('/fake/sing-box');
      expect(r).toEqual({
        ok: true,
        version: PRE,
        versionLine: `sing-box version ${PRE}`,
        buildTags: NO_GVISOR_TAGS,
      });
      expect(fx.calls.map((c) => c.args[0])).toEqual(['version', 'check']);
      for (const c of fx.calls) {
        expect(c.opts).toMatchObject({ timeout: 20_000, windowsHide: true });
      }
      expect(env.pm!.buildPreflightConfigJson).toHaveBeenCalledWith(PRE);
    } finally {
      fx.restore();
    }
  });

  it('check 失败：剥 ANSI 色码；摘要取 FATAL 行（1.15 起首行是 WARN），detail 带全文', async () => {
    const env = makeEnv();
    env.preflight.mockRestore();
    env.pm!.buildPreflightConfigJson.mockReturnValue('{}' as never);
    // 实测：sing-box 输出到管道也带色码
    const stderr =
      '\x1b[33mWARN\x1b[0m[0000] stack option in TUN is deprecated in sing-box 1.15.0\n\x1b[31mFATAL\x1b[0m[0000] initialize endpoint[0]: invalid public key\n';
    const fx = withFakeExecFile(async (_f, args) => {
      if (args[0] === 'version') return { stdout: versionOut(PRE, GVISOR_TAGS), stderr: '' };
      throw Object.assign(new Error('Command failed'), { stderr, code: 1 });
    });
    try {
      const r = await env.s.preflightValidate('/fake/sing-box');
      expect(r.ok).toBe(false);
      expect(r.reason).toBe(
        '新核心无法解析当前配置：FATAL[0000] initialize endpoint[0]: invalid public key'
      );
      expect(r.detail).toBe(
        'WARN[0000] stack option in TUN is deprecated in sing-box 1.15.0\nFATAL[0000] initialize endpoint[0]: invalid public key'
      );
      expect(r.version).toBe(PRE);
    } finally {
      fx.restore();
    }
  });

  it('check 超时被杀 → 不通过（reason 说明超时）；version 超时 → 视为不可执行', async () => {
    const env = makeEnv();
    env.preflight.mockRestore();
    env.pm!.buildPreflightConfigJson.mockReturnValue('{}' as never);
    let hangVersion = false;
    const fx = withFakeExecFile(async (_f, args) => {
      if (args[0] === 'version') {
        if (hangVersion)
          throw Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' });
        return { stdout: versionOut(STABLE, GVISOR_TAGS), stderr: '' };
      }
      throw Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' });
    });
    try {
      const r = await env.s.preflightValidate('/fake/sing-box');
      expect(r).toMatchObject({
        ok: false,
        version: STABLE,
        reason: expect.stringMatching(/超时/),
      });
      hangVersion = true;
      const r2 = await env.s.preflightValidate('/fake/sing-box');
      expect(r2).toMatchObject({ ok: false, version: null, buildTags: null });
    } finally {
      fx.restore();
    }
  });
});
