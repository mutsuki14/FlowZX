/**
 * CoreUpdateScheduler + CoreUpdateService.runAutoUpdateCycle 单测（fake timers + mock 依赖）。
 *
 * 覆盖不变量：
 * - autoUpdateCore 默认/false → 不触发 runAutoUpdateCycle（总开关守门）
 * - 距上次检查 < 24h → 跳过；≥ 24h → 触发（CHECK_INTERVAL due）
 * - onProxyStopped：延 5s 双查，仍 running → 不落位（不断流：规避 stop→start 窗口）
 * - kick 幂等：cycleIfDue 内 isRunning 防重入，并发调用只跑一轮
 * - runAutoUpdateCycle：带内→stage、跨带→发事件不下载、known-bad→跳、staged 同版本→免重下
 */

// electron 仅在方法内被调用（构造期不触碰）；mock 掉 app.getPath 供 state/known-bad 文件路径用临时目录。
jest.mock('electron', () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-core-test-'));
  return {
    app: { getPath: (_k: string) => tmpRoot },
    net: { request: jest.fn() },
    dialog: { showOpenDialog: jest.fn() },
  };
});
// ResourceManager 含 electron 间接依赖；CoreUpdateService 落位路径会用到，但本测试只走 runAutoUpdateCycle 的
// 「检查→stage/跨带」分支（代理 mock 为 running，永不落位），故 ensureCronetBeside 等不会被调用。
jest.mock('../ResourceManager', () => ({
  resourceManager: {
    getSingBoxPath: () => '/tmp/flowz-fake/sing-box',
    getSingBoxUpdateTargetPath: () => '/tmp/flowz-fake/sing-box',
    getBundledSingBoxPath: () => '/tmp/flowz-fake/sing-box-bundled',
    ensureCronetBeside: jest.fn(),
  },
}));

import * as fs from 'fs';
import * as nodePath from 'path';
import { setTimeout as realSetTimeout } from 'timers';

import { CoreUpdateScheduler } from '../CoreUpdateScheduler';
import { CoreUpdateService } from '../CoreUpdateService';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import { encodeMajorMinor } from '../../../shared/version';
import coreManifest from '../../../shared/core-manifest.json';

// M1 修复：jest30 + node26 组合下 useFakeTimers() 会删除 globalThis.setTimeout，且 useRealTimers() 不恢复
// （typeof globalThis.setTimeout === 'undefined'）。applyStagedNow 内裸用 setTimeout(2000) 会 ReferenceError。
// 修法：M1 测试在 useRealTimers() 后从 node 'timers' 模块钉回真实 setTimeout 到 globalThis；
//   后续 test 的 beforeEach useFakeTimers() 会用 mocked 版替换它（非删除），不破坏 scheduler 其他 fake-timer 测试。

function makeLogManager() {
  return { addLog: jest.fn() } as any;
}

function makeConfigManager(config: any) {
  return { loadConfig: jest.fn().mockResolvedValue(config) } as any;
}

describe('CoreUpdateScheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  function makeCoreService(autoStatus: any = { lastCheckAt: null }) {
    return {
      getAutoStatus: jest.fn().mockResolvedValue(autoStatus),
      runAutoUpdateCycle: jest.fn().mockResolvedValue(undefined),
      tryApplyStaged: jest.fn().mockResolvedValue('noop'),
    } as any;
  }

  it('autoUpdateCore 未设 → 启动 30s 后不触发 runAutoUpdateCycle', async () => {
    const core = makeCoreService();
    const sched = new CoreUpdateScheduler(
      makeConfigManager({}),
      core,
      makeLogManager(),
      () => false
    );
    sched.start();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(core.runAutoUpdateCycle).not.toHaveBeenCalled();
    sched.stop();
  });

  it('autoUpdateCore=false → 不触发', async () => {
    const core = makeCoreService();
    const sched = new CoreUpdateScheduler(
      makeConfigManager({ autoUpdateCore: false }),
      core,
      makeLogManager(),
      () => false
    );
    sched.start();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(core.runAutoUpdateCycle).not.toHaveBeenCalled();
    sched.stop();
  });

  it('autoUpdateCore=true 且无 lastCheckAt → 启动 30s 后触发一次', async () => {
    const core = makeCoreService({ lastCheckAt: null });
    const sched = new CoreUpdateScheduler(
      makeConfigManager({ autoUpdateCore: true }),
      core,
      makeLogManager(),
      () => false
    );
    sched.start();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(core.runAutoUpdateCycle).toHaveBeenCalledTimes(1);
    sched.stop();
  });

  it('距上次检查 < 24h → 跳过；≥ 24h → 触发', async () => {
    const now = Date.now();
    // < 24h
    const coreRecent = makeCoreService({ lastCheckAt: now - 1 * 60 * 60_000 });
    const sched1 = new CoreUpdateScheduler(
      makeConfigManager({ autoUpdateCore: true }),
      coreRecent,
      makeLogManager(),
      () => false
    );
    sched1.start();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(coreRecent.runAutoUpdateCycle).not.toHaveBeenCalled();
    sched1.stop();

    // ≥ 24h
    const coreStale = makeCoreService({ lastCheckAt: now - 25 * 60 * 60_000 });
    const sched2 = new CoreUpdateScheduler(
      makeConfigManager({ autoUpdateCore: true }),
      coreStale,
      makeLogManager(),
      () => false
    );
    sched2.start();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(coreStale.runAutoUpdateCycle).toHaveBeenCalledTimes(1);
    sched2.stop();
  });

  it('onProxyStopped：5s 后仍 running → 不落位（不断流，规避重启窗口）', async () => {
    const core = makeCoreService();
    let running = false;
    const sched = new CoreUpdateScheduler(
      makeConfigManager({ autoUpdateCore: true }),
      core,
      makeLogManager(),
      () => running
    );
    sched.start();
    sched.onProxyStopped();
    // 5s 内代理又起来了（attemptAutoRestart/switchMode 的 stop→start 窗口）
    running = true;
    await jest.advanceTimersByTimeAsync(5_000);
    expect(core.tryApplyStaged).not.toHaveBeenCalled();
    sched.stop();
  });

  it('onProxyStopped：5s 后确实未运行 → 落位 staged', async () => {
    const core = makeCoreService();
    const sched = new CoreUpdateScheduler(
      makeConfigManager({ autoUpdateCore: true }),
      core,
      makeLogManager(),
      () => false
    );
    sched.start();
    sched.onProxyStopped();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(core.tryApplyStaged).toHaveBeenCalledWith('proxy-stopped');
    sched.stop();
  });

  it('kick 幂等：并发 cycleIfDue 防重入，只跑一轮', async () => {
    let resolveCycle: () => void = () => {};
    const core = makeCoreService({ lastCheckAt: null });
    core.runAutoUpdateCycle = jest.fn(() => new Promise<void>((r) => (resolveCycle = r)));
    const sched = new CoreUpdateScheduler(
      makeConfigManager({ autoUpdateCore: true }),
      core,
      makeLogManager(),
      () => false
    );
    sched.start();
    // 第一次 kick 启动一轮（在途未结束）
    sched.kick();
    await Promise.resolve();
    // 第二次 kick：isRunning 防重入，应被吞
    sched.kick();
    await Promise.resolve();
    resolveCycle();
    await jest.advanceTimersByTimeAsync(0);
    expect(core.runAutoUpdateCycle).toHaveBeenCalledTimes(1);
    sched.stop();
  });
});

describe('CoreUpdateService.runAutoUpdateCycle', () => {
  function makeProxyManager(running: boolean) {
    return {
      getStatus: () => ({ running }),
      getCoreVersion: jest.fn().mockResolvedValue('1.13.13'),
      buildPreflightConfigJson: () => null,
      hasNaiveNodes: () => false,
      setAutoRestartSuppressed: jest.fn(),
    } as any;
  }

  function makeService(opts: { config: any; checkResult: any; running?: boolean }) {
    const svc = new CoreUpdateService(makeLogManager());
    svc.setProxyManager(makeProxyManager(opts.running ?? true));
    svc.setConfigProvider(() => Promise.resolve(opts.config));
    const events: Array<{ channel: string; payload: any }> = [];
    svc.setEventSender((channel, payload) => events.push({ channel, payload }));
    // 边界打桩：checkUpdate（网络）/ download / extract / preflight / stage / save-state
    jest.spyOn(svc as any, 'checkUpdate').mockResolvedValue(opts.checkResult);
    const downloadSpy = jest
      .spyOn((svc as any).coreDownloader, 'downloadFile')
      .mockResolvedValue('/tmp/fake.tar.gz');
    jest
      .spyOn((svc as any).coreDownloader, 'extractCore')
      .mockResolvedValue({ corePath: '/tmp/x/sing-box', extractDir: '/tmp/x' });
    jest.spyOn(svc as any, 'preflightValidate').mockResolvedValue({
      ok: true,
      version: opts.checkResult.latestVersion,
      versionLine: `sing-box version ${opts.checkResult.latestVersion}`,
    });
    const stageSpy = jest.spyOn(svc as any, 'stageCore').mockImplementation((_d: any, v: any) => ({
      version: v,
      dir: '/tmp/staged',
      stagedAt: 'now',
    }));
    jest.spyOn(svc as any, 'saveAutoState').mockImplementation(() => {});
    let autoState: any = {};
    jest.spyOn(svc as any, 'loadAutoState').mockImplementation(() => autoState);
    (svc as any).__setAutoState = (s: any) => (autoState = s);
    jest.spyOn(svc as any, 'tryApplyStaged').mockResolvedValue(undefined);
    return { svc, events, downloadSpy, stageSpy };
  }

  afterEach(() => jest.restoreAllMocks());

  it('带内新版 → 下载并 stage', async () => {
    const { svc, downloadSpy, stageSpy } = makeService({
      config: { autoUpdateCore: true },
      checkResult: {
        hasUpdate: true,
        currentVersion: '1.13.13',
        latestVersion: '1.13.14',
        downloadUrl: 'https://x/sing-box-1.13.14.tar.gz',
        // 真实 checkUpdate 恒带上资产摘要；缺它自动腿会拒装（见下一条用例）。
        downloadSha256: 'a'.repeat(64),
      },
    });
    await svc.runAutoUpdateCycle();
    expect(downloadSpy).toHaveBeenCalledTimes(1);
    expect(stageSpy).toHaveBeenCalledWith(expect.any(String), '1.13.14');
  });

  /**
   * 自动更新是**无人值守**的：没人会看日志、没人会核对下载来源。故「取不到官方 sha256」时必须直接中止，
   * 而不是退化成不校验就装——运行期换核会回落 gh-proxy 第三方镜像，无摘要即无从判断拿到的是什么。
   */
  it('取不到资产摘要 → 自动腿中止，绝不下载安装未校验的内核', async () => {
    const { svc, downloadSpy, stageSpy } = makeService({
      config: { autoUpdateCore: true },
      checkResult: {
        hasUpdate: true,
        currentVersion: '1.13.13',
        latestVersion: '1.13.14',
        downloadUrl: 'https://x/sing-box-1.13.14.tar.gz',
        // 无 downloadSha256
      },
    });
    // 现取也拿不到（releases 里没有匹配 URL 的 asset）
    jest.spyOn(svc as any, 'resolveAssetSha256').mockResolvedValue(null);
    await svc.runAutoUpdateCycle();
    expect(downloadSpy).not.toHaveBeenCalled();
    expect(stageSpy).not.toHaveBeenCalled();
  });

  it('跨 minor 新版 → 发跨带事件、绝不下载', async () => {
    const { svc, events, downloadSpy, stageSpy } = makeService({
      config: { autoUpdateCore: true },
      checkResult: {
        hasUpdate: false, // checkUpdate 内 ceiling 闸通常已挡，但即便放行也不下载
        currentVersion: '1.13.13',
        latestVersion: '1.14.0',
      },
    });
    await svc.runAutoUpdateCycle();
    expect(downloadSpy).not.toHaveBeenCalled();
    expect(stageSpy).not.toHaveBeenCalled();
    expect(events.some((e) => e.channel === 'event:coreAutoUpdateStatus')).toBe(true);
  });

  it('autoUpdateCore=false → 直接返回，不检查不下载', async () => {
    const { svc, downloadSpy } = makeService({
      config: { autoUpdateCore: false },
      checkResult: { hasUpdate: true, currentVersion: '1.13.13', latestVersion: '1.13.14' },
    });
    const checkSpy = jest.spyOn(svc as any, 'checkUpdate');
    await svc.runAutoUpdateCycle();
    expect(checkSpy).not.toHaveBeenCalled();
    expect(downloadSpy).not.toHaveBeenCalled();
  });

  it('已有相同版本 staged → tryApplyStaged，免重下', async () => {
    const { svc, downloadSpy } = makeService({
      config: { autoUpdateCore: true },
      checkResult: {
        hasUpdate: true,
        currentVersion: '1.13.13',
        latestVersion: '1.13.14',
        downloadUrl: 'https://x/sing-box-1.13.14.tar.gz',
      },
    });
    (svc as any).__setAutoState({
      staged: { version: '1.13.14', dir: '/tmp/staged', stagedAt: 'now' },
    });
    const applySpy = jest.spyOn(svc as any, 'tryApplyStaged');
    await svc.runAutoUpdateCycle();
    // H1：runAutoUpdateCycle 内调 tryApplyStaged 传 lockHeld=true（复用入口持的 isUpdating 闸，不二次置/复位）
    expect(applySpy).toHaveBeenCalledWith('staged-same-version', true);
    expect(downloadSpy).not.toHaveBeenCalled();
  });

  // M3：用户手动升级追上跨带提示版本 → 清除残留跨带提示
  it('M3：current 追上 crossBandNotifiedVersion → 清除提示并发 crossBandLatest:null', async () => {
    const { svc, events } = makeService({
      config: { autoUpdateCore: true },
      // 当前已升到 1.14.0，无更新（latest 缺省）→ 仍应清掉旧的 1.14.0 跨带提示
      checkResult: { hasUpdate: false, currentVersion: '1.14.0', latestVersion: undefined },
    });
    const saved: any[] = [];
    jest.spyOn(svc as any, 'saveAutoState').mockImplementation((p: any) => saved.push(p));
    (svc as any).loadAutoState = () => ({ crossBandNotifiedVersion: '1.14.0' });
    await svc.runAutoUpdateCycle();
    expect(saved.some((p) => p.crossBandNotifiedVersion === undefined)).toBe(true);
    const ev = events.filter((e) => e.channel === 'event:coreAutoUpdateStatus');
    expect(ev.some((e) => e.payload.crossBandLatest === null)).toBe(true);
  });

  it('M3：current 仍落后 notified → 不清除', async () => {
    const { svc } = makeService({
      config: { autoUpdateCore: true },
      checkResult: { hasUpdate: false, currentVersion: '1.13.13', latestVersion: undefined },
    });
    const saved: any[] = [];
    jest.spyOn(svc as any, 'saveAutoState').mockImplementation((p: any) => saved.push(p));
    (svc as any).loadAutoState = () => ({ crossBandNotifiedVersion: '1.14.0' });
    await svc.runAutoUpdateCycle();
    expect(saved.some((p) => 'crossBandNotifiedVersion' in p)).toBe(false);
  });
});

/**
 * tryApplyStaged 枚举结果 + applyStagedNow 恢复 + M4 守门（修 fable review M1/M2/M4）。
 * 直接 mock 文件/进程边界，断言枚举返回与 restoreBackup / proxy 恢复行为。
 */
describe('CoreUpdateService.tryApplyStaged / applyStagedNow', () => {
  // 真实临时 staged 目录 + sing-box 文件（避免 spy 不可配置的 fs.existsSync）
  const os = require('os');
  const realPath = require('path');
  const stagedDir = fs.mkdtempSync(realPath.join(os.tmpdir(), 'flowz-staged-'));
  const coreName = process.platform === 'win32' ? 'sing-box.exe' : 'sing-box';
  fs.writeFileSync(realPath.join(stagedDir, coreName), 'fake-core');
  const STAGED = { version: '1.13.14', dir: stagedDir, stagedAt: 'now' };

  afterAll(() => {
    try {
      fs.rmSync(stagedDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function makeProxy(running: boolean) {
    // 有状态：stop() 翻转 running→false（拟真，否则 applyStagedNow 停代理后 tryApplyStaged 仍判运行中误 deferred）
    let isRunning = running;
    return {
      getStatus: jest.fn(() => ({ running: isRunning })),
      getCoreVersion: jest.fn().mockResolvedValue('1.13.13'),
      buildPreflightConfigJson: () => null,
      hasNaiveNodes: () => false,
      setAutoRestartSuppressed: jest.fn(),
      setCoreSwapInProgress: jest.fn(),
      stop: jest.fn().mockImplementation(async () => {
        isRunning = false;
      }),
      start: jest.fn().mockResolvedValue(undefined),
    } as any;
  }

  /**
   * 构造一个 staged 已就绪、可落位的 service。
   * @param opts.running 代理是否运行
   * @param opts.autoUpdateCore 开关（M4 守门）
   * @param opts.installImpl installCoreFromDir 桩实现（用于模拟 M2 中途失败）
   */
  function makeSvc(opts: {
    running: boolean;
    autoUpdateCore?: boolean;
    installImpl?: (dir: string, ver: any, onBackupDone?: () => void) => Promise<void>;
    hasStaged?: boolean;
  }) {
    const svc = new CoreUpdateService(makeLogManager());
    const proxy = makeProxy(opts.running);
    svc.setProxyManager(proxy);
    svc.setConfigProvider(() =>
      Promise.resolve({ autoUpdateCore: opts.autoUpdateCore ?? true } as any)
    );
    svc.setEventSender(() => {});

    // 文件/状态边界打桩
    let staged: any = opts.hasStaged === false ? undefined : { ...STAGED };
    jest.spyOn(svc as any, 'loadAutoState').mockImplementation(() => ({ staged }));
    const clearSpy = jest
      .spyOn(svc as any, 'clearStaged')
      .mockImplementation(() => (staged = undefined));
    jest.spyOn(svc as any, 'emitAutoStatus').mockImplementation(() => {});
    jest.spyOn(svc as any, 'saveAutoState').mockImplementation(() => {});
    jest.spyOn(svc as any, 'getCurrentVersion').mockResolvedValue('1.13.13');
    jest.spyOn(svc as any, 'isKnownBad').mockReturnValue(false);
    jest
      .spyOn(svc as any, 'preflightValidate')
      .mockResolvedValue({ ok: true, version: '1.13.14', versionLine: 'sing-box version 1.13.14' });
    jest.spyOn(svc as any, 'hasBackup').mockReturnValue(true);
    const restoreSpy = jest.spyOn(svc as any, 'restoreBackup').mockResolvedValue(undefined);
    const installSpy = jest
      .spyOn(svc as any, 'installCoreFromDir')
      .mockImplementation((opts.installImpl ?? (async () => {})) as any);
    return { svc, proxy, clearSpy, restoreSpy, installSpy };
  }

  afterEach(() => jest.restoreAllMocks());

  it('代理未运行 + install 成功 → applied，清 staged', async () => {
    const { svc, clearSpy } = makeSvc({ running: false });
    const r = await svc.tryApplyStaged('proxy-stopped');
    expect(r).toBe('applied');
    expect(clearSpy).toHaveBeenCalled();
  });

  it('代理运行中 → deferred，不换核、保留 staged', async () => {
    const { svc, installSpy, clearSpy } = makeSvc({ running: true });
    const r = await svc.tryApplyStaged('proxy-stopped');
    expect(r).toBe('deferred');
    expect(installSpy).not.toHaveBeenCalled();
    expect(clearSpy).not.toHaveBeenCalled();
  });

  it('M2：install 中途失败（已备份）→ failed 且 restoreBackup 被调用，staged 保留', async () => {
    const { svc, restoreSpy, clearSpy } = makeSvc({
      running: false,
      installImpl: async (_d, _v, onBackupDone) => {
        onBackupDone?.(); // 备份已完成
        throw new Error('disk full mid-copy'); // 复制半截失败
      },
    });
    const r = await svc.tryApplyStaged('proxy-stopped');
    expect(r).toBe('failed');
    expect(restoreSpy).toHaveBeenCalledTimes(1);
    expect(clearSpy).not.toHaveBeenCalled(); // 失败保留 staged 待重试
  });

  it('M2：install 失败但尚未备份 → failed 且不误调 restoreBackup（不恢复陈旧 .bak）', async () => {
    const { svc, restoreSpy } = makeSvc({
      running: false,
      installImpl: async () => {
        throw new Error('fail before backup'); // onBackupDone 未触发
      },
    });
    const r = await svc.tryApplyStaged('proxy-stopped');
    expect(r).toBe('failed');
    expect(restoreSpy).not.toHaveBeenCalled();
  });

  it('M4：自动触发(proxy-stopped) + 开关关 → deferred，保留 staged 不换核', async () => {
    const { svc, installSpy, clearSpy } = makeSvc({ running: false, autoUpdateCore: false });
    const r = await svc.tryApplyStaged('proxy-stopped');
    expect(r).toBe('deferred');
    expect(installSpy).not.toHaveBeenCalled();
    expect(clearSpy).not.toHaveBeenCalled();
  });

  it('M4：manual-apply 不受开关影响 → 开关关也落位 applied', async () => {
    const { svc } = makeSvc({ running: false, autoUpdateCore: false });
    const r = await svc.tryApplyStaged('manual-apply');
    expect(r).toBe('applied');
  });

  it('staged 不再领先当前 → discarded', async () => {
    const { svc, clearSpy } = makeSvc({ running: false });
    jest.spyOn(svc as any, 'getCurrentVersion').mockResolvedValue('1.13.14'); // 已是该版本
    const r = await svc.tryApplyStaged('proxy-stopped');
    expect(r).toBe('discarded');
    expect(clearSpy).toHaveBeenCalled();
  });

  it('无 staged → noop', async () => {
    const { svc } = makeSvc({ running: false, hasStaged: false });
    const r = await svc.tryApplyStaged('proxy-stopped');
    expect(r).toBe('noop');
  });

  it('落位前重预检失败 → markKnownBad + clearStaged → discarded', async () => {
    const { svc, clearSpy, installSpy } = makeSvc({ running: false });
    // 重预检返回 ok:false（下载到落位间 config 变）→ 标记坏 + 清 staged，绝不落位
    jest.spyOn(svc as any, 'preflightValidate').mockResolvedValue({
      ok: false,
      version: '1.13.14',
      versionLine: 'sing-box version 1.13.14',
      reason: 'config invalid',
    });
    const markBadSpy = jest.spyOn(svc as any, 'markKnownBad').mockImplementation(() => {});
    const r = await svc.tryApplyStaged('proxy-stopped');
    expect(r).toBe('discarded');
    expect(markBadSpy).toHaveBeenCalledWith('1.13.14');
    expect(clearSpy).toHaveBeenCalled();
    expect(installSpy).not.toHaveBeenCalled(); // 重预检失败 → 不换核
  });

  it('staged 暂存核心文件缺失 → clearStaged → discarded（不预检不换核）', async () => {
    // staged.dir 指向一个空临时目录（无 sing-box 二进制）
    const emptyDir = fs.mkdtempSync(realPath.join(os.tmpdir(), 'flowz-staged-empty-'));
    const { svc, clearSpy, installSpy } = makeSvc({ running: false });
    (svc as any).loadAutoState = () => ({
      staged: { version: '1.13.14', dir: emptyDir, stagedAt: 'now' },
    });
    const preflightSpy = jest.spyOn(svc as any, 'preflightValidate');
    const r = await svc.tryApplyStaged('proxy-stopped');
    expect(r).toBe('discarded');
    expect(clearSpy).toHaveBeenCalled();
    expect(preflightSpy).not.toHaveBeenCalled(); // 文件缺失早于重预检
    expect(installSpy).not.toHaveBeenCalled();
    try {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('isUpdating 重入（已有落位/更新在途）→ noop', async () => {
    const { svc, installSpy, clearSpy } = makeSvc({ running: false });
    (svc as any).isUpdating = true; // 模拟另一更新流程持闸在途
    const r = await svc.tryApplyStaged('proxy-stopped');
    expect(r).toBe('noop');
    expect(installSpy).not.toHaveBeenCalled();
    expect(clearSpy).not.toHaveBeenCalled();
  });

  it('M1：applyStagedNow wasRunning + install 失败 → 仍恢复代理(start)，返回 failed', async () => {
    jest.useRealTimers(); // applyStagedNow 内 setTimeout(2000) 需真实定时器
    (globalThis as any).setTimeout = realSetTimeout; // 钉回真实 setTimeout（jest30 useRealTimers 不恢复 global）
    const { svc, proxy } = makeSvc({
      running: true,
      installImpl: async (_d, _v, onBackupDone) => {
        onBackupDone?.();
        throw new Error('mid-copy fail');
      },
    });
    const r = await svc.applyStagedNow();
    expect(r).toBe('failed');
    expect(proxy.stop).toHaveBeenCalled();
    expect(proxy.start).toHaveBeenCalled(); // 不留停止态
  });

  it('M1：applyStagedNow wasRunning + applied → 落位后重启代理', async () => {
    jest.useRealTimers(); // 同上：applyStagedNow 内 setTimeout 需真实定时器
    (globalThis as any).setTimeout = realSetTimeout; // 同上钉回
    const { svc, proxy } = makeSvc({ running: true });
    const r = await svc.applyStagedNow();
    expect(r).toBe('applied');
    expect(proxy.stop).toHaveBeenCalled();
    expect(proxy.start).toHaveBeenCalled();
  });
});

describe('B0：兼容版本带去硬编码 + verifiedCeiling', () => {
  // 真跑 checkUpdate 的兼容带闸，只 mock 网络/版本/状态依赖
  function rawSvc(opts: { current: string; latest: string; autoState: any; restrict?: boolean }) {
    const svc = new CoreUpdateService(makeLogManager());
    svc.setConfigProvider(() =>
      Promise.resolve({ restrictCoreUpdateToCompatibleMinor: opts.restrict ?? true } as any)
    );
    jest.spyOn(svc as any, 'getCurrentVersion').mockResolvedValue(opts.current);
    jest.spyOn(svc as any, 'loadAutoState').mockReturnValue(opts.autoState);
    jest.spyOn(svc as any, 'isKnownBad').mockReturnValue(false);
    jest
      .spyOn((svc as any).coreDownloader, 'fetchReleases')
      .mockResolvedValue([
        { tag_name: `v${opts.latest}`, prerelease: false, assets: [{ name: 'x' }] },
      ]);
    jest.spyOn((svc as any).coreDownloader, 'findSuitableAsset').mockReturnValue({
      browser_download_url: `http://x/sing-box-${opts.latest}.tar.gz`,
      // 真实 GitHub API 对每个 asset 恒返回 digest；缺它会被完整性门拒装（这正是该门的意图），
      // 故 mock 也要带上，否则测的是「拒装」而非本 suite 关心的调度/stage 逻辑。
      digest: `sha256:${'a'.repeat(64)}`,
    });
    return svc;
  }

  it('出厂带地板(=bundled 1.14)：current 1.14 + 无 verifiedCeiling → 高于地板的 1.15 跨带被拦', async () => {
    // WS-D 换核后 bundled=1.14 → 出厂带地板升至 1.14；原「1.13→1.14 被拦」过时（1.14 已是地板内、放行追平）。
    // 改测高于新地板的 1.15：无 verifiedCeiling 不放行跨带。
    const r = await rawSvc({ current: '1.14.0', latest: '1.15.0', autoState: {} }).checkUpdate();
    expect(r.hasUpdate).toBe(false);
    expect(r.latestVersion).toBe('1.15.0');
  });

  it('verifiedCeiling=1014（已实证 1.14）→ 1.14 放行', async () => {
    const r = await rawSvc({
      current: '1.13.13',
      latest: '1.14.0',
      autoState: { verifiedCeiling: 1014 },
    }).checkUpdate();
    expect(r.hasUpdate).toBe(true);
    expect(r.downloadUrl).toBeTruthy();
  });

  it('current 实跑 1.14（手动升过）→ 1.14 内 patch 放行（current 纳入有效上限）', async () => {
    const r = await rawSvc({ current: '1.14.0', latest: '1.14.5', autoState: {} }).checkUpdate();
    expect(r.hasUpdate).toBe(true);
  });

  it('关 restrict → 跨带不经兼容带闸，直接放行', async () => {
    const r = await rawSvc({
      current: '1.13.13',
      latest: '1.14.0',
      autoState: {},
      restrict: false,
    }).checkUpdate();
    expect(r.hasUpdate).toBe(true);
  });

  // recordSuccessfulVersion 已去 core-version.json 写（旧持久位废除，改 push 型 pendingChangeNotice）→ 无平台相关写盘、全平台可跑。
  it('verifiedCeiling 棘轮升：成功运行 1.14.0 → 写 verifiedCeiling=1014', async () => {
    const svc = new CoreUpdateService(makeLogManager());
    jest.spyOn(svc as any, 'getCurrentVersion').mockResolvedValue('1.14.0');
    jest.spyOn(svc as any, 'clearKnownBad').mockImplementation(() => {});
    let state: any = { verifiedCeiling: 1013 };
    jest.spyOn(svc as any, 'loadAutoState').mockImplementation(() => state);
    const saved: any[] = [];
    jest.spyOn(svc as any, 'saveAutoState').mockImplementation((p: any) => {
      saved.push(p);
      state = { ...state, ...p };
    });
    await svc.recordSuccessfulVersion();
    expect(saved).toContainEqual({ verifiedCeiling: 1014 });
  });

  it('verifiedCeiling 不降级：成功运行 1.13（低于已验证 1.14）→ 不覆盖', async () => {
    const svc = new CoreUpdateService(makeLogManager());
    jest.spyOn(svc as any, 'getCurrentVersion').mockResolvedValue('1.13.20');
    jest.spyOn(svc as any, 'clearKnownBad').mockImplementation(() => {});
    jest.spyOn(svc as any, 'loadAutoState').mockReturnValue({ verifiedCeiling: 1014 });
    const saved: any[] = [];
    jest.spyOn(svc as any, 'saveAutoState').mockImplementation((p: any) => saved.push(p));
    await svc.recordSuccessfulVersion();
    expect(saved.find((s) => 'verifiedCeiling' in s)).toBeUndefined();
  });
});

// ============================================================================
// 版本选择配套：固定版本（pin）× 自动更新 / staged / 各改版本路径；verifiedCeiling 预发布不棘轮；恢复随包清状态；
// checkUpdate 取版本号最大的正式版。真实 CoreUpdateStateStore（core-update-state.json 落临时 userData，每例清空），
// 假 ProxyManager 的 getCoreVersion 读可变的「当前内核」——断言的是持久状态与推送事件，而非私有方法的调用。
// ============================================================================

const BUNDLED = coreManifest.bundledCoreVersion;
const BUNDLED_CEILING = encodeMajorMinor(BUNDLED);
// 由随包版本推出（随包升级不致夹具失效）：本带正式补丁 / 下一带 alpha / 下一带正式 / 上一带补丁。
const [B_MAJ, B_MIN] = BUNDLED.split('.').map((p) => parseInt(p, 10));
const SAME_BAND = `${B_MAJ}.${B_MIN}.3`;
const NEXT_PRE = `${B_MAJ}.${B_MIN + 1}.0-alpha.12`;
const NEXT_STABLE = `${B_MAJ}.${B_MIN + 1}.0`;
const PREV_BAND = `${B_MAJ}.${B_MIN - 1}.21`;
const pinOf = (version: string) => ({
  version,
  tag: `v${version}`,
  prerelease: version.includes('-'),
  pinnedAt: '2026-10-12T00:00:00.000Z',
});
const last = <T>(xs: T[]): T | undefined => xs[xs.length - 1];

describe('版本选择配套（pin / verifiedCeiling / 恢复随包 / checkUpdate 取最大正式版）', () => {
  const userData: string = require('electron').app.getPath('userData');
  const stateFile = nodePath.join(userData, 'core-update-state.json');
  const knownBadFile = nodePath.join(userData, 'core-known-bad.json');
  const coreName = process.platform === 'win32' ? 'sing-box.exe' : 'sing-box';
  const svcs: CoreUpdateService[] = [];

  beforeEach(() => {
    // 见文件头 M1 注：前面 fake-timer suite 之后 globalThis.setTimeout 可能缺失（验证闩 / 停代理等待要用真定时器）。
    jest.useRealTimers();
    (globalThis as any).setTimeout = realSetTimeout;
    for (const f of [stateFile, knownBadFile]) fs.rmSync(f, { force: true });
  });
  afterEach(() => {
    for (const s of svcs.splice(0)) (s as any).disarmPendingValidation();
    jest.restoreAllMocks();
  });

  function makeEnv(o: {
    current: string;
    running?: boolean;
    autoUpdateCore?: boolean;
    state?: Record<string, unknown>;
  }) {
    // 每个 env 代表一份全新的 userData（同一用例里先后建的 env 共用临时目录，故建时清空持久状态）。
    for (const f of [stateFile, knownBadFile]) fs.rmSync(f, { force: true });
    const svc = new CoreUpdateService(makeLogManager());
    svcs.push(svc);
    const s = svc as any;
    let current = o.current;
    let running = o.running ?? false;
    const proxy = {
      getStatus: jest.fn(() => ({ running })),
      getCoreVersion: jest.fn(async (_force?: boolean) => current),
      getCoreVersionLine: jest.fn(async () => `sing-box version ${current}`),
      buildPreflightConfigJson: () => null,
      hasNaiveNodes: () => false,
      setAutoRestartSuppressed: jest.fn(),
      setCoreSwapInProgress: jest.fn(),
      isCoreSwapInProgress: jest.fn(() => false),
      isLifecycleBusy: jest.fn(() => false),
      refreshCoreVersionAfterExternalReseed: jest.fn(async () => undefined),
      stop: jest.fn(async () => {
        running = false;
      }),
      start: jest.fn(async () => {
        running = true;
      }),
    };
    svc.setProxyManager(proxy as any);
    svc.setConfigProvider(async () => ({ autoUpdateCore: o.autoUpdateCore ?? true }) as any);
    // win32 回滚 / 写核经 privilegeService；注入空实现使各平台走同一断言。
    svc.setPrivilegeService({ copyFileElevated: async () => {} } as any);
    const events: Array<{ channel: string; payload: any }> = [];
    svc.setEventSender((channel, payload) => events.push({ channel, payload }));
    if (o.state) s.saveAutoState(o.state);
    return {
      svc,
      s,
      proxy,
      events,
      setCurrent: (v: string) => {
        current = v;
      },
      state: () => s.loadAutoState(),
      autoStatus: () =>
        events
          .filter((e) => e.channel === IPC_CHANNELS.EVENT_CORE_AUTO_UPDATE_STATUS)
          .map((e) => e.payload),
      progress: () =>
        events
          .filter((e) => e.channel === IPC_CHANNELS.EVENT_CORE_INSTALL_PROGRESS)
          .map((e) => e.payload),
    };
  }

  /** 真实暂存目录（含核心文件），模拟自动更新已下载预检通过、待落位的新核。 */
  function makeStaged(version: string) {
    const dir = fs.mkdtempSync(nodePath.join(userData, 'staged-'));
    fs.writeFileSync(nodePath.join(dir, coreName), 'staged-core');
    return { version, dir, stagedAt: '2026-10-12T00:00:00.000Z' };
  }

  /** 回滚的文件 IO 桩（备份「存在」、写核 no-op）——断言回滚后的状态收尾，不碰真实内核文件。 */
  function stubRollbackIo(env: ReturnType<typeof makeEnv>) {
    const realFs = require('fs');
    jest.spyOn(env.s, 'hasBackup').mockReturnValue(true);
    jest.spyOn(env.s, 'getBackupPath').mockReturnValue(nodePath.join(userData, 'no-such.bak'));
    jest.spyOn(env.s, 'isProtectedCoreActive').mockResolvedValue(false);
    jest.spyOn(realFs, 'copyFileSync').mockImplementation(() => {});
    jest.spyOn(realFs, 'chmodSync').mockImplementation(() => {});
    jest.spyOn(realFs, 'unlinkSync').mockImplementation(() => {});
  }

  describe('pin × runAutoUpdateCycle', () => {
    it('固定生效（当前内核 = 固定版本）→ 不检查、不下载、不暂存，只记 lastCheckAt；固定保留', async () => {
      const env = makeEnv({ current: NEXT_PRE, state: { pinned: pinOf(NEXT_PRE) } });
      const check = jest.spyOn(env.s, 'checkUpdate').mockResolvedValue({} as never);
      const download = jest.spyOn(env.s.coreDownloader, 'downloadFile');
      const stage = jest.spyOn(env.s, 'stageCore');
      const before = Date.now();
      await env.svc.runAutoUpdateCycle();
      expect(check).not.toHaveBeenCalled();
      expect(download).not.toHaveBeenCalled();
      expect(stage).not.toHaveBeenCalled();
      expect(env.state().pinned).toEqual(pinOf(NEXT_PRE));
      expect(env.state().lastCheckAt).toBeGreaterThanOrEqual(before);
      expect(env.s.isUpdating).toBe(false);
    });

    it('固定已陈旧（版本被其它途径改变，如 App 升级后刷回随包核）→ 清固定、推 pinned:null，照常检查', async () => {
      const env = makeEnv({ current: BUNDLED, state: { pinned: pinOf(NEXT_PRE) } });
      const check = jest
        .spyOn(env.s, 'checkUpdate')
        .mockResolvedValue({ hasUpdate: false, currentVersion: BUNDLED });
      await env.svc.runAutoUpdateCycle();
      expect(env.state().pinned).toBeUndefined();
      expect(last(env.autoStatus())).toMatchObject({ pinned: null });
      expect(check).toHaveBeenCalledTimes(1);
    });

    it('无固定 → 不为固定多探一次版本，直接进入检查；开关关 → 照旧直接返回', async () => {
      const env = makeEnv({ current: BUNDLED });
      const check = jest
        .spyOn(env.s, 'checkUpdate')
        .mockResolvedValue({ hasUpdate: false, currentVersion: BUNDLED });
      await env.svc.runAutoUpdateCycle();
      expect(env.proxy.getCoreVersion).not.toHaveBeenCalled();
      expect(check).toHaveBeenCalledTimes(1);

      const off = makeEnv({
        current: NEXT_PRE,
        autoUpdateCore: false,
        state: { pinned: pinOf(NEXT_PRE) },
      });
      await off.svc.runAutoUpdateCycle();
      expect(off.proxy.getCoreVersion).not.toHaveBeenCalled();
      expect(off.state().lastCheckAt).toBeUndefined();
    });
  });

  describe('pin × tryApplyStaged', () => {
    it.each([
      ['proxy-stopped', true],
      ['startup', true],
      ['tick', true],
      ['proxy-stopped', false], // 开关关也作废：暂存核留着只会在重开开关后覆盖掉用户选的版本
    ])(
      '固定生效 + 自动触发 %s（autoUpdateCore=%s）→ 作废暂存核（discarded），不预检不落位；固定保留',
      async (trigger, auto) => {
        const staged = makeStaged(NEXT_STABLE);
        const env = makeEnv({
          current: NEXT_PRE,
          autoUpdateCore: auto,
          state: { pinned: pinOf(NEXT_PRE), staged },
        });
        const install = jest.spyOn(env.s, 'installCoreFromDir').mockResolvedValue(undefined);
        const preflight = jest.spyOn(env.s, 'preflightValidate');
        await expect(env.svc.tryApplyStaged(trigger)).resolves.toBe('discarded');
        expect(install).not.toHaveBeenCalled();
        expect(preflight).not.toHaveBeenCalled();
        expect(env.state().staged).toBeUndefined();
        expect(fs.existsSync(staged.dir)).toBe(false);
        expect(env.state().pinned).toEqual(pinOf(NEXT_PRE));
        expect(last(env.autoStatus())).toMatchObject({ staged: null, pinned: pinOf(NEXT_PRE) });
        expect(env.s.isUpdating).toBe(false);
        expect(env.svc.isBusy()).toBe(false);
      }
    );

    it('manual-apply（用户点「立即应用」）不受固定约束：照常落位；版本已变 → 固定清除并推 pinned:null', async () => {
      const staged = makeStaged(NEXT_STABLE);
      const env = makeEnv({ current: NEXT_PRE, state: { pinned: pinOf(NEXT_PRE), staged } });
      jest.spyOn(env.s, 'preflightValidate').mockResolvedValue({
        ok: true,
        version: NEXT_STABLE,
        versionLine: `sing-box version ${NEXT_STABLE}`,
      });
      const install = jest
        .spyOn(env.s, 'installCoreFromDir')
        .mockImplementation(async () => env.setCurrent(NEXT_STABLE));
      await expect(env.svc.tryApplyStaged('manual-apply')).resolves.toBe('applied');
      expect(install).toHaveBeenCalledTimes(1);
      expect(env.state().pinned).toBeUndefined();
      expect(last(env.autoStatus())).toMatchObject({ staged: null, pinned: null });
    });

    it('固定已陈旧 → 清固定后按原逻辑继续（代理在跑 → deferred，暂存保留）', async () => {
      const staged = makeStaged(NEXT_STABLE);
      const env = makeEnv({
        current: SAME_BAND,
        running: true,
        state: { pinned: pinOf(NEXT_PRE), staged },
      });
      await expect(env.svc.tryApplyStaged('proxy-stopped')).resolves.toBe('deferred');
      expect(env.state().pinned).toBeUndefined();
      expect(env.state().staged).toEqual(staged);
      expect(fs.existsSync(staged.dir)).toBe(true);
      fs.rmSync(staged.dir, { recursive: true, force: true });
    });
  });

  describe('pin 快照与取消', () => {
    it('getAutoStatus：当前内核仍是固定版本 → 给出 pinned（读版本缓存，不 force）；已陈旧 → null 但只过滤不清除', async () => {
      const env = makeEnv({ current: NEXT_PRE, state: { pinned: pinOf(NEXT_PRE) } });
      await expect(env.svc.getAutoStatus()).resolves.toMatchObject({
        autoUpdateEnabled: true,
        pinned: pinOf(NEXT_PRE),
      });
      expect(env.proxy.getCoreVersion).toHaveBeenCalledWith(false);
      env.setCurrent(SAME_BAND);
      await expect(env.svc.getAutoStatus()).resolves.toMatchObject({ pinned: null });
      expect(env.state().pinned).toEqual(pinOf(NEXT_PRE));
      // 无固定 → 不为快照探版本
      const none = makeEnv({ current: SAME_BAND });
      await expect(none.svc.getAutoStatus()).resolves.toMatchObject({ pinned: null });
      expect(none.proxy.getCoreVersion).not.toHaveBeenCalled();
    });

    it('getVersionInfo：附随包版本与生效中的固定；已陈旧 → 清除并推状态，但换核进行中只过滤不清', async () => {
      const env = makeEnv({ current: NEXT_PRE, state: { pinned: pinOf(NEXT_PRE) } });
      await expect(env.svc.getVersionInfo()).resolves.toMatchObject({
        currentVersion: NEXT_PRE,
        bundledVersion: BUNDLED,
        pinned: pinOf(NEXT_PRE),
      });
      env.setCurrent(SAME_BAND);
      env.s.isUpdating = true; // 安装 / 恢复进行中：版本在变
      await expect(env.svc.getVersionInfo()).resolves.toMatchObject({ pinned: null });
      expect(env.state().pinned).toEqual(pinOf(NEXT_PRE));
      env.s.isUpdating = false;
      await expect(env.svc.getVersionInfo()).resolves.toMatchObject({ pinned: null });
      expect(env.state().pinned).toBeUndefined();
      expect(last(env.autoStatus())).toMatchObject({ pinned: null });
    });

    it('版本探测失败（getCoreVersion 回落随包版本、诚实复核探测也失败）→ 按版本未知保留固定：getVersionInfo / 自动轮次 / 自动落位都不清', async () => {
      const staged = makeStaged(NEXT_STABLE);
      const env = makeEnv({ current: NEXT_PRE, state: { pinned: pinOf(NEXT_PRE), staged } });
      // ProxyManager.getCoreVersion 的 catch 分支：spawn 失败 → 返回随包版本（不是 '' / '未知'）；
      // getCoreVersionLine(true) 失败 → ''（不回落）
      env.proxy.getCoreVersion.mockResolvedValue(BUNDLED);
      env.proxy.getCoreVersionLine.mockResolvedValue('');
      await expect(env.svc.getVersionInfo()).resolves.toMatchObject({ pinned: pinOf(NEXT_PRE) });
      expect(env.proxy.getCoreVersionLine).toHaveBeenCalledWith(true);
      const check = jest.spyOn(env.s, 'checkUpdate');
      await env.svc.runAutoUpdateCycle();
      expect(check).not.toHaveBeenCalled();
      await expect(env.svc.tryApplyStaged('proxy-stopped')).resolves.toBe('discarded');
      expect(env.state().pinned).toEqual(pinOf(NEXT_PRE));
      expect(env.autoStatus().every((p) => p.pinned !== null)).toBe(true);
      // 复核探测本身抛错 → 同样按未知保留
      env.proxy.getCoreVersionLine.mockRejectedValue(new Error('spawn EBUSY'));
      await expect(env.svc.getVersionInfo()).resolves.toMatchObject({ pinned: pinOf(NEXT_PRE) });
      expect(env.state().pinned).toEqual(pinOf(NEXT_PRE));
    });

    it('缓存 / 回落版本与固定不符，但诚实复核读到的仍是固定版本 → 固定照常有效；复核读到别的版本才清', async () => {
      const env = makeEnv({ current: NEXT_PRE, state: { pinned: pinOf(NEXT_PRE) } });
      env.proxy.getCoreVersion.mockResolvedValue(BUNDLED);
      await expect(env.svc.getVersionInfo()).resolves.toMatchObject({ pinned: pinOf(NEXT_PRE) });
      expect(env.state().pinned).toEqual(pinOf(NEXT_PRE));
      env.setCurrent(SAME_BAND); // 复核读活二进制：版本确实变了
      await expect(env.svc.getVersionInfo()).resolves.toMatchObject({ pinned: null });
      expect(env.state().pinned).toBeUndefined();
    });

    it('当前版本未知（无 ProxyManager）→ 无从判断，固定照常生效不清；畸形固定记录 → 视为无固定并清除', async () => {
      const svc = new CoreUpdateService(makeLogManager());
      svcs.push(svc);
      (svc as any).saveAutoState({ pinned: pinOf(NEXT_PRE) });
      await expect(svc.getVersionInfo()).resolves.toMatchObject({
        currentVersion: '未知',
        pinned: pinOf(NEXT_PRE),
      });
      expect((svc as any).loadAutoState().pinned).toEqual(pinOf(NEXT_PRE));

      const env = makeEnv({ current: NEXT_PRE, state: { pinned: { tag: 42 } } });
      await expect(env.svc.getVersionInfo()).resolves.toMatchObject({ pinned: null });
      expect(env.state().pinned).toBeUndefined();
    });

    it('clearPin：清固定 + 清 lastCheckAt（固定期间的轮次只记时间未真检查，清掉后下个巡检即恢复），推 pinned:null', async () => {
      const env = makeEnv({
        current: NEXT_PRE,
        state: { pinned: pinOf(NEXT_PRE), lastCheckAt: 123 },
      });
      await env.svc.clearPin();
      expect(env.state().pinned).toBeUndefined();
      expect(env.state().lastCheckAt).toBeUndefined();
      expect(last(env.autoStatus())).toMatchObject({ pinned: null, lastCheckAt: null });
    });
  });

  describe('改版本的其它路径清固定', () => {
    it('rollbackCore：清固定并推状态', async () => {
      const env = makeEnv({ current: SAME_BAND, state: { pinned: pinOf(NEXT_STABLE) } });
      stubRollbackIo(env);
      await env.svc.rollbackCore();
      expect(env.state().pinned).toBeUndefined();
      expect(last(env.autoStatus())).toMatchObject({ pinned: null });
    });

    it('autoRollbackIfPendingUpdate（固定版本首启失败）→ 回滚、标记问题版本、清固定', async () => {
      const env = makeEnv({ current: BUNDLED, state: { pinned: pinOf(NEXT_STABLE) } });
      stubRollbackIo(env);
      env.s.armPendingValidation(NEXT_STABLE);
      await expect(env.svc.autoRollbackIfPendingUpdate()).resolves.toBe(true);
      expect(env.state().pinned).toBeUndefined();
      expect(env.svc.isKnownBad(NEXT_STABLE)).toBe(true);
    });

    it('replaceManualCore：成功 → 清固定并推状态；写核失败（已恢复原核）→ 固定保留', async () => {
      const env = makeEnv({ current: NEXT_PRE, state: { pinned: pinOf(NEXT_PRE) } });
      jest.spyOn(env.s, 'preflightValidate').mockResolvedValue({
        ok: true,
        version: SAME_BAND,
        versionLine: `sing-box version ${SAME_BAND}`,
      });
      jest.spyOn(env.s, 'backupCurrentCore').mockResolvedValue(undefined);
      jest.spyOn(env.s, 'recordSuccessfulVersion').mockResolvedValue(undefined);
      const write = jest.spyOn(env.s, 'writeManualCoreToBundle').mockResolvedValue(undefined);
      await expect(
        env.svc.replaceManualCore({ filePath: '/tmp/manual-sing-box', force: true })
      ).resolves.toMatchObject({ ok: true });
      expect(write).toHaveBeenCalledTimes(1);
      expect(env.state().pinned).toBeUndefined();
      expect(last(env.autoStatus())).toMatchObject({ pinned: null });

      const failed = makeEnv({ current: NEXT_PRE, state: { pinned: pinOf(NEXT_PRE) } });
      jest.spyOn(failed.s, 'preflightValidate').mockResolvedValue({
        ok: true,
        version: SAME_BAND,
        versionLine: `sing-box version ${SAME_BAND}`,
      });
      jest.spyOn(failed.s, 'backupCurrentCore').mockResolvedValue(undefined);
      jest.spyOn(failed.s, 'restoreBackup').mockResolvedValue(true);
      jest.spyOn(failed.s, 'writeManualCoreToBundle').mockRejectedValue(new Error('write fail'));
      await expect(
        failed.svc.replaceManualCore({ filePath: '/tmp/manual-sing-box', force: true })
      ).resolves.toMatchObject({ ok: false });
      expect(failed.state().pinned).toEqual(pinOf(NEXT_PRE));
    });

    it('updateCore（「检查更新 → 更新」）：成功 → 清固定；换核失败 → 固定保留', async () => {
      const arrange = (installFails: boolean) => {
        const env = makeEnv({ current: NEXT_PRE, state: { pinned: pinOf(NEXT_PRE) } });
        jest.spyOn(env.s, 'resolveAssetSha256').mockResolvedValue('a'.repeat(64));
        jest
          .spyOn(env.s.coreDownloader, 'downloadFile')
          .mockResolvedValue('/tmp/flowz-fake.tar.gz');
        jest
          .spyOn(env.s.coreDownloader, 'extractCore')
          .mockResolvedValue({ corePath: '/tmp/flowz-x/sing-box', extractDir: '/tmp/flowz-x' });
        jest.spyOn(env.s, 'preflightValidate').mockResolvedValue({
          ok: true,
          version: NEXT_STABLE,
          versionLine: `sing-box version ${NEXT_STABLE}`,
        });
        jest
          .spyOn(env.s, 'installCoreFromDir')
          .mockImplementation(async () =>
            installFails ? Promise.reject(new Error('disk full')) : env.setCurrent(NEXT_STABLE)
          );
        return env;
      };
      const ok = arrange(false);
      await expect(ok.svc.updateCore('https://x/sing-box.tar.gz')).resolves.toBe(true);
      expect(ok.state().pinned).toBeUndefined();
      expect(last(ok.autoStatus())).toMatchObject({ pinned: null });

      const bad = arrange(true);
      await expect(bad.svc.updateCore('https://x/sing-box.tar.gz')).rejects.toThrow('disk full');
      expect(bad.state().pinned).toEqual(pinOf(NEXT_PRE));
    });
  });

  describe('verifiedCeiling：预发布不棘轮', () => {
    it('成功运行预发布 → 不抬高 verifiedCeiling（仍清问题版本标记）；成功运行正式版 → 照常棘轮', async () => {
      const env = makeEnv({ current: NEXT_PRE, state: { verifiedCeiling: BUNDLED_CEILING } });
      env.s.markKnownBad(NEXT_PRE);
      await env.svc.recordSuccessfulVersion();
      expect(env.state().verifiedCeiling).toBe(BUNDLED_CEILING);
      expect(env.svc.isKnownBad(NEXT_PRE)).toBe(false);

      // 官方 dev 构建（预发布 + 短 hash）同样不算实证
      env.setCurrent(`${NEXT_PRE}-0123abc`);
      await env.svc.recordSuccessfulVersion();
      expect(env.state().verifiedCeiling).toBe(BUNDLED_CEILING);

      env.setCurrent(NEXT_STABLE);
      await env.svc.recordSuccessfulVersion();
      expect(env.state().verifiedCeiling).toBe(encodeMajorMinor(NEXT_STABLE));
    });

    it('试装下一带 alpha 跑通后切回本带：「检查更新」的兼容带闸不被 alpha 放宽（下一带正式版仍判跨带）', async () => {
      const env = makeEnv({ current: NEXT_PRE });
      await env.svc.recordSuccessfulVersion(); // alpha 成功运行
      env.setCurrent(SAME_BAND); // 用户换回本带正式版
      jest.spyOn(env.s.coreDownloader, 'fetchReleases').mockResolvedValue([
        {
          tag_name: `v${NEXT_STABLE}`,
          prerelease: false,
          assets: [
            { name: 'x', browser_download_url: 'https://x/a', digest: `sha256:${'a'.repeat(64)}` },
          ],
        },
      ]);
      jest.spyOn(env.s.coreDownloader, 'findSuitableAsset').mockImplementation((a: any) => a[0]);
      const r = await env.svc.checkUpdate();
      expect(r.hasUpdate).toBe(false);
      expect(r.latestVersion).toBe(NEXT_STABLE);
      expect(r.error).toMatch(/跨越兼容版本带/);
    });

    it('回滚：回滚后是正式版 → verifiedCeiling 重置到其带；回滚后是预发布 → 只降不升（不借回滚把上限抬到 alpha 的带）', async () => {
      const toStable = makeEnv({
        current: SAME_BAND,
        state: { verifiedCeiling: encodeMajorMinor(NEXT_STABLE) },
      });
      stubRollbackIo(toStable);
      await toStable.svc.rollbackCore();
      expect(toStable.state().verifiedCeiling).toBe(encodeMajorMinor(SAME_BAND));

      const toPre = makeEnv({ current: NEXT_PRE, state: { verifiedCeiling: BUNDLED_CEILING } });
      stubRollbackIo(toPre);
      await toPre.svc.rollbackCore();
      expect(toPre.state().verifiedCeiling).toBe(BUNDLED_CEILING);

      const toPreNoPrev = makeEnv({ current: NEXT_PRE });
      stubRollbackIo(toPreNoPrev);
      await toPreNoPrev.svc.rollbackCore();
      expect(toPreNoPrev.state().verifiedCeiling).toBe(BUNDLED_CEILING);
    });
  });

  describe('resetCoreToFactory（恢复随包）', () => {
    function arrangeReset(env: ReturnType<typeof makeEnv>) {
      jest.spyOn(env.s, 'verifyFactoryCore').mockReturnValue(null);
      jest.spyOn(env.s, 'preflightValidate').mockResolvedValue({
        ok: true,
        version: BUNDLED,
        versionLine: `sing-box version ${BUNDLED}`,
      });
      const write = jest
        .spyOn(env.s, 'writeManualCoreToBundle')
        .mockImplementation(async () => env.setCurrent(BUNDLED));
      const prune = jest.spyOn(env.s, 'pruneBackup').mockImplementation(() => {});
      return { write, prune };
    }

    it('成功 → 清固定 / 暂存核 / verifiedCeiling 回出厂带；问题版本与跨带提示不动；进度 kind=reset 各阶段后推 null', async () => {
      const staged = makeStaged(NEXT_STABLE);
      const env = makeEnv({
        current: NEXT_PRE,
        running: true,
        state: {
          pinned: pinOf(NEXT_PRE),
          staged,
          verifiedCeiling: encodeMajorMinor(NEXT_STABLE),
          crossBandNotifiedVersion: NEXT_STABLE,
        },
      });
      env.s.markKnownBad(SAME_BAND);
      const { write, prune } = arrangeReset(env);
      await expect(env.svc.resetCoreToFactory()).resolves.toEqual({ ok: true, error: undefined });
      expect(write).toHaveBeenCalledTimes(1);
      expect(prune).toHaveBeenCalledTimes(1);
      const st = env.state();
      expect(st.pinned).toBeUndefined();
      expect(st.staged).toBeUndefined();
      expect(fs.existsSync(staged.dir)).toBe(false);
      expect(st.verifiedCeiling).toBe(BUNDLED_CEILING);
      expect(st.crossBandNotifiedVersion).toBe(NEXT_STABLE);
      expect(env.svc.isKnownBad(SAME_BAND)).toBe(true);
      expect(last(env.autoStatus())).toMatchObject({ pinned: null, staged: null });
      const tag = `v${BUNDLED}`;
      expect(env.progress()).toEqual([
        { kind: 'reset', tag, phase: 'testing' },
        { kind: 'reset', tag, phase: 'switching' },
        { kind: 'reset', tag, phase: 'restarting' },
        null,
      ]);
      expect(env.proxy.stop).toHaveBeenCalledTimes(1);
      expect(env.proxy.start).toHaveBeenCalledTimes(1);
      expect(env.svc.getInstallState()).toEqual({ installing: null });
      expect(env.s.isUpdating).toBe(false);
      expect(env.svc.isBusy()).toBe(false);
    });

    it('入口同步持 isUpdating：恢复进行中 staged 落位 / 在线安装 / 自动轮次 / 再次恢复 / 回滚 / 手动替换 / 立即应用一律让开；结束释放', async () => {
      const env = makeEnv({ current: NEXT_PRE });
      arrangeReset(env);
      let release!: () => void;
      jest.spyOn(env.s, 'preflightValidate').mockImplementation(
        () =>
          new Promise((r) => {
            release = () =>
              r({ ok: true, version: BUNDLED, versionLine: `sing-box version ${BUNDLED}` });
          })
      );
      const resetting = env.svc.resetCoreToFactory();
      expect(env.s.isUpdating).toBe(true); // 第一个 await 之前已持锁
      expect(env.svc.isBusy()).toBe(true);
      expect(env.svc.getInstallState().installing).toMatchObject({ kind: 'reset' });

      const staged = makeStaged(NEXT_STABLE);
      env.s.saveAutoState({ staged });
      await expect(env.svc.tryApplyStaged('proxy-stopped')).resolves.toBe('noop');
      await expect(env.svc.installTag({ tag: `v${NEXT_STABLE}` })).resolves.toMatchObject({
        ok: false,
        code: 'BUSY',
      });
      const check = jest.spyOn(env.s, 'checkUpdate');
      await env.svc.runAutoUpdateCycle();
      expect(check).not.toHaveBeenCalled();
      await expect(env.svc.resetCoreToFactory()).resolves.toMatchObject({
        ok: false,
        code: 'BUSY',
      });
      // 回滚 / 手动替换 / 立即应用的公开入口同样让开（否则与恢复并发写核、先结束的一方放开换核门控）
      jest.spyOn(env.s, 'hasBackup').mockReturnValue(true);
      await expect(env.svc.rollbackCore()).rejects.toMatchObject({ code: 'BUSY' });
      await expect(env.svc.replaceManualCore({ filePath: '/tmp/x', force: true })).resolves.toEqual(
        { ok: false, code: 'BUSY', error: expect.stringMatching(/内核更新正在进行中/) }
      );
      await expect(env.svc.applyStagedNow()).rejects.toMatchObject({ code: 'BUSY' });
      expect(env.s.coreOps).toBe(1);
      expect(env.s.isUpdating).toBe(true); // 被拒的调用不动别人的锁

      release();
      await expect(resetting).resolves.toMatchObject({ ok: true });
      expect(env.state().staged).toBeUndefined(); // 恢复期间写入的暂存核同被清
      expect(env.s.isUpdating).toBe(false);
      expect(env.svc.isBusy()).toBe(false);
      expect(env.svc.getInstallState()).toEqual({ installing: null });
    });

    it('已有内核操作在飞（isUpdating / coreOps>0）→ BUSY；Xray 正在切换 → XRAY_BUSY；均不动锁、不推进度', async () => {
      const busy = makeEnv({ current: NEXT_PRE });
      const replace = jest.spyOn(busy.s, 'replaceManualCoreLocked');
      busy.s.isUpdating = true;
      await expect(busy.svc.resetCoreToFactory()).resolves.toMatchObject({
        ok: false,
        code: 'BUSY',
      });
      busy.s.isUpdating = false;
      busy.s.coreOps = 1;
      await expect(busy.svc.resetCoreToFactory()).resolves.toMatchObject({
        ok: false,
        code: 'BUSY',
      });
      expect(busy.s.coreOps).toBe(1);
      busy.s.coreOps = 0;
      busy.svc.setXrayBusyCheck(() => true);
      await expect(busy.svc.resetCoreToFactory()).resolves.toMatchObject({
        ok: false,
        code: 'XRAY_BUSY',
        error: expect.stringMatching(/Xray 内核正在切换/),
      });
      expect(replace).not.toHaveBeenCalled();
      expect(busy.progress()).toEqual([]);
      expect(busy.s.isUpdating).toBe(false);
    });

    it('失败（出厂核指纹不符）→ 固定 / 暂存 / verifiedCeiling 原样保留；锁释放、进度推 null', async () => {
      const staged = makeStaged(NEXT_STABLE);
      const ceiling = encodeMajorMinor(NEXT_STABLE);
      const env = makeEnv({
        current: NEXT_PRE,
        state: { pinned: pinOf(NEXT_PRE), staged, verifiedCeiling: ceiling },
      });
      jest.spyOn(env.s, 'verifyFactoryCore').mockReturnValue('随包出厂内核与官方指纹不符');
      await expect(env.svc.resetCoreToFactory()).resolves.toMatchObject({ ok: false });
      expect(env.state()).toMatchObject({
        pinned: pinOf(NEXT_PRE),
        staged,
        verifiedCeiling: ceiling,
      });
      expect(last(env.progress())).toBeNull();
      expect(env.s.isUpdating).toBe(false);
      fs.rmSync(staged.dir, { recursive: true, force: true });
    });
  });

  describe('checkUpdate：取版本号最大的正式版（非 API 时间序）', () => {
    const CUR = `${B_MAJ}.${B_MIN}.0`;
    const rel = (tag: string, extra: Record<string, unknown> = {}) => ({
      tag_name: tag,
      prerelease: false,
      draft: false,
      body: `notes ${tag}`,
      assets: [
        {
          name: `sing-box-${tag}.tar.gz`,
          browser_download_url: `https://github.com/SagerNet/sing-box/releases/download/${tag}/sing-box-${tag}.tar.gz`,
          digest: `sha256:${'b'.repeat(64)}`,
        },
      ],
      ...extra,
    });
    // 上游真实的交错发布：旧分支补丁、下一带 alpha、本带补丁交替出现（API 按发布时间新→旧）。
    const interleaved = () => [
      rel(`v${PREV_BAND}`),
      rel(`v${NEXT_PRE}`, { prerelease: true }),
      rel(`v${B_MAJ}.${B_MIN}.9-rc.1`), // API 标志漏标，但 tag 后缀是预发布 → 不算正式版
      rel(`v${B_MAJ}.${B_MIN}.8`, { draft: true }),
      rel(`v${SAME_BAND}`),
      rel('nightly'),
      rel(`v${B_MAJ}.${B_MIN}.1`),
    ];

    function arrange(current: string) {
      const env = makeEnv({ current, running: true });
      jest.spyOn(env.s.coreDownloader, 'fetchReleases').mockResolvedValue(interleaved());
      jest.spyOn(env.s.coreDownloader, 'findSuitableAsset').mockImplementation((a: any) => a[0]);
      return env;
    }

    it('交错序里取 semver 最大的正式版（跳过旧分支补丁 / 预发布 / tag 带预发布后缀 / 草稿 / 非法 tag）', async () => {
      const env = arrange(CUR);
      const r = await env.svc.checkUpdate();
      expect(r).toMatchObject({
        hasUpdate: true,
        currentVersion: CUR,
        latestVersion: SAME_BAND,
        downloadUrl: expect.stringContaining(`/v${SAME_BAND}/`),
        releaseNotes: `notes v${SAME_BAND}`,
        crossBand: false,
      });
    });

    it('自动轮次同经此处：下载并暂存的是最大正式版（而非 API 首个的旧分支补丁）', async () => {
      const env = arrange(CUR);
      const download = jest
        .spyOn(env.s.coreDownloader, 'downloadFile')
        .mockResolvedValue('/tmp/flowz-fake.tar.gz');
      jest
        .spyOn(env.s.coreDownloader, 'extractCore')
        .mockResolvedValue({ corePath: '/tmp/flowz-x/sing-box', extractDir: '/tmp/flowz-x' });
      jest.spyOn(env.s, 'preflightValidate').mockResolvedValue({
        ok: true,
        version: SAME_BAND,
        versionLine: `sing-box version ${SAME_BAND}`,
      });
      const stage = jest.spyOn(env.s, 'stageCore').mockImplementation((_d: any, v: any) => ({
        version: v,
        dir: '/tmp/flowz-staged',
        stagedAt: 'now',
      }));
      jest.spyOn(env.s, 'tryApplyStaged').mockResolvedValue('deferred');
      await env.svc.runAutoUpdateCycle();
      expect(download).toHaveBeenCalledTimes(1);
      expect(String(download.mock.calls[0][0])).toContain(`/v${SAME_BAND}/`);
      expect(stage).toHaveBeenCalledWith(expect.any(String), SAME_BAND);
    });

    it('已是最大正式版 → 无更新（不会被更晚发布的旧分支补丁误导成「有更新 / 降级」）', async () => {
      const env = arrange(SAME_BAND);
      const r = await env.svc.checkUpdate();
      expect(r.hasUpdate).toBe(false);
      expect(r.error).toBeUndefined();
    });
  });
});
