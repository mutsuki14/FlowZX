/**
 * ProxyManager × Xray sidecar 生命周期单测（注入假 XrayCoreManager，零真实进程 / 二进制，CI 三平台可跑）：
 *  - sidecar 随 sing-box 终态回收：起核失败 / 退出终态 / 放弃自动重启 / 用户中止自动重启；cleanup（重试腿之间）不碰它；
 *  - prepareXrayBridge 无轮数上限：>51 个可归因失败节点全部剔除，选中的好节点照常入桥；
 *  - 起核路径（xrayPrepared）绝不回落占位桥；未起核的快照/预检路径仍用占位桥；
 *  - `xray run -test` 归因不到 tag（handler 实例化期错误）→ 逐节点单测，只剔失败者；
 *  - sing-box 绑 xray-dial-in 失败 → 重分配端口 + 重起 Xray，由下一条起核腿 await；修正失败（选中 Xray 节点）→ 终态；
 *  - 启动期回收测速临时 Xray 残留（PID + 配置），退出时回收进行中的测速会话。
 * 私有方法/字段经 `(svc as any)` 直调注入。
 */
const os = require('os');
const path = require('path');
const fsSync = require('fs');

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-xraylc-'));

jest.mock('electron', () => ({
  app: { getPath: () => TMP, getVersion: () => '9.9.9', isPackaged: false, getAppPath: () => TMP },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));
// 真实 ResourceManager，仅把「Xray 内核在位」固定为 true（CI 不拉二进制，否则 Xray 节点被 isNodeUsable 判不可用）。
jest.mock('../ResourceManager', () => {
  const actual = jest.requireActual('../ResourceManager');
  actual.resourceManager.hasXrayCore = () => true;
  actual.resourceManager.getXrayPath = () => '/fake/xray';
  actual.resourceManager.ensureWritableCore = async () => '/fake/sing-box';
  return actual;
});
// 起核重试退避压到 10ms（真实为 2s 指数），其余语义不变。
jest.mock('../../../shared/start-retry-policy', () => ({
  resolveStartRetryBudget: () => ({ maxRetries: 2, delay: 10, exponentialBackoff: false }),
}));

import { ProxyManager } from '../ProxyManager';
import { XrayCoreManager } from '../XrayCoreManager';
import { CoreStartSupersededError } from '../core-readiness';
import type { XrayConfig } from '../xray-config-builder';
import type { XrayTestResult } from '../XrayCoreManager';
import type { SingBoxConfig } from '../singbox-config-types';
import type { ServerConfig, UserConfig } from '../../../shared/types';
import { withPlatformAsync } from './platform-test-utils';

afterAll(() => {
  try {
    fsSync.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const UUID = '8a502aeb-b677-4fc6-bdbf-0b11435a99ec';
const xh = (id: string): ServerConfig =>
  ({
    id,
    name: id.toUpperCase(),
    protocol: 'vless',
    address: `${id}.example.com`,
    port: 443,
    uuid: UUID,
    network: 'xhttp',
    security: 'tls',
    tlsSettings: { serverName: `${id}.example.com` },
  }) as ServerConfig;
const hy2 = (id: string): ServerConfig =>
  ({
    id,
    name: id.toUpperCase(),
    protocol: 'hysteria2',
    address: 'h.example.com',
    port: 443,
    password: 'p',
  }) as ServerConfig;

function userConfig(servers: ServerConfig[], selected: string): UserConfig {
  return {
    subscriptions: [],
    servers,
    selectedServerId: selected,
    proxyMode: 'smart',
    proxyModeType: 'manual',
    tunConfig: { mtu: 1350, stack: 'auto', autoRoute: true, strictRoute: true },
    customRules: [],
    appRules: [],
    customAppPresets: [],
    autoStart: false,
    silentStart: false,
    autoConnect: false,
    minimizeToTray: false,
    mixedPort: 7890,
    logLevel: 'info',
    clashApiSecret: 'testsecret',
  } as unknown as UserConfig;
}

/** Xray 配置里的节点 outbound tag（n-<id>，不含 dialer / blackhole）。 */
const nodeTags = (cfg: XrayConfig): string[] =>
  cfg.outbounds.map((o) => o.tag).filter((t) => t.startsWith('n-'));

function fakeXray(test: (cfg: XrayConfig) => XrayTestResult = () => ({ ok: true })) {
  let running = false;
  return {
    isAvailable: () => true,
    isRunning: () => running,
    getPid: () => (running ? 4242 : null),
    stop: jest.fn(async () => {
      running = false;
    }),
    start: jest.fn(async (_cfg: XrayConfig) => {
      running = true;
    }),
    test: jest.fn(async (cfg: XrayConfig) => test(cfg)),
    killOrphan: jest.fn(async () => {}),
  };
}

function makeSvc(xray = fakeXray()): any {
  const configPath = path.join(TMP, `sb-${Math.random().toString(36).slice(2)}.json`);
  const svc: any = new ProxyManager(undefined, undefined, configPath, '/fake/sing-box');
  svc.coreVersion = '1.14.0';
  svc._xrayManager = xray;
  svc.ensureSystemProxyCleared = jest.fn(async () => {});
  svc.on('error', () => {}); // 终态路径会 emit('error')，无监听者时 EventEmitter 会抛
  return svc;
}

const dialIn = (sb: SingBoxConfig) => sb.inbounds.find((i) => i.tag === 'xray-dial-in');

describe('Xray sidecar 随 sing-box 终态回收', () => {
  /** 模拟「本会话已起 sidecar」的桥状态。 */
  function arm(svc: any): void {
    svc.xrayBridge = {
      nodes: [],
      dialers: [],
      dialInbound: { port: 1, users: [] },
      dialRoutes: [],
    };
    svc.xrayPrepared = true;
    svc.xrayRunningNodes = 2;
  }
  const expectDisarmed = (svc: any, xray: ReturnType<typeof fakeXray>) => {
    expect(xray.stop).toHaveBeenCalled();
    expect(svc.xrayBridge).toBeNull();
    expect(svc.xrayPrepared).toBe(false);
    expect(svc.xrayRunningNodes).toBe(0);
  };

  it('start() 失败（非让位，如取消授权 / 起核 FATAL）→ 停 sidecar 并清桥状态', async () => {
    const xray = fakeXray();
    const svc = makeSvc(xray);
    svc.startWithTunAddressAvoidance = jest.fn(async () => {
      arm(svc);
      throw new Error('用户取消了管理员权限请求');
    });
    await expect(svc.start(userConfig([], 'x'))).rejects.toThrow('用户取消');
    expectDisarmed(svc, xray);
  });

  it('start() 让位 → 不碰 sidecar（已属接管方）', async () => {
    const xray = fakeXray();
    const svc = makeSvc(xray);
    svc.startWithTunAddressAvoidance = jest.fn(async () => {
      arm(svc);
      throw new CoreStartSupersededError();
    });
    await svc.start(userConfig([], 'x'));
    expect(xray.stop).not.toHaveBeenCalled();
    expect(svc.xrayPrepared).toBe(true);
  });

  it('cleanup()（重试腿之间也会跑）不碰 sidecar', () => {
    const xray = fakeXray();
    const svc = makeSvc(xray);
    arm(svc);
    svc.cleanup();
    expect(xray.stop).not.toHaveBeenCalled();
    expect(svc.xrayBridge).not.toBeNull();
  });

  it('sing-box 被外部杀死（终态退出）→ 停 sidecar；主动停止过程中的退出不重复停', () => {
    const xray = fakeXray();
    const svc = makeSvc(xray);
    arm(svc);
    svc.handleProcessExit(null, 'SIGKILL');
    expectDisarmed(svc, xray);

    const xray2 = fakeXray();
    const svc2 = makeSvc(xray2);
    arm(svc2);
    svc2.stopping = true;
    svc2.handleProcessExit(null, 'SIGTERM');
    expect(xray2.stop).not.toHaveBeenCalled();
  });

  it('崩溃但走自动重启 → 不停 sidecar（重启腿的 prepareXrayBridge 负责替换）', () => {
    const xray = fakeXray();
    const svc = makeSvc(xray);
    arm(svc);
    svc.shouldAutoRestart = () => true;
    svc.attemptAutoRestart = jest.fn(async () => {});
    svc.handleProcessExit(1, null);
    expect(svc.attemptAutoRestart).toHaveBeenCalled();
    expect(xray.stop).not.toHaveBeenCalled();
  });

  it('崩溃且不再自动重启 → 停 sidecar', () => {
    const xray = fakeXray();
    const svc = makeSvc(xray);
    arm(svc);
    svc.shouldAutoRestart = () => false;
    svc.handleProcessExit(1, null);
    expectDisarmed(svc, xray);
  });

  it('放弃自动重启 → 停 sidecar', async () => {
    const xray = fakeXray();
    const svc = makeSvc(xray);
    arm(svc);
    svc.maybeNotifyHelperBackgroundDisabled = jest.fn(async () => {});
    await svc.giveUpAutoRestart('boom');
    expectDisarmed(svc, xray);
  });

  it('放弃自动重启时已有更新的 start 在飞（lifecycleDepth>0）→ sidecar 属接管方，不停', async () => {
    const xray = fakeXray();
    const svc = makeSvc(xray);
    arm(svc);
    svc.maybeNotifyHelperBackgroundDisabled = jest.fn(async () => {});
    svc.lifecycleDepth = 1; // 用户新起的 start 正在飞，已 prepare/起了自己的 Xray
    await svc.giveUpAutoRestart('boom');
    expect(xray.stop).not.toHaveBeenCalled();
    expect(svc.xrayBridge).not.toBeNull();
  });

  it('用户中止自动重启 → 停 sidecar', () => {
    const xray = fakeXray();
    const svc = makeSvc(xray);
    arm(svc);
    svc.finalizeUserAbortedRestart();
    expectDisarmed(svc, xray);
  });
});

describe('prepareXrayBridge：无轮数上限 + 起核路径不回落占位桥', () => {
  const bad = Array.from({ length: 55 }, (_, i) => xh(`bad${i}`));
  const good = xh('good');
  const servers = [...bad, good, hy2('hop')];
  const failFirstBad = (cfg: XrayConfig): XrayTestResult => {
    const tag = nodeTags(cfg).find((t) => t.startsWith('n-bad'));
    return tag
      ? { stderr: `Failed to start: main: failed to build outbound config with tag ${tag} > x` }
      : { ok: true };
  };

  it('55 个可归因失败节点逐个剔除，选中的好节点入桥；起核配置用真实端口/凭据', async () => {
    const xray = fakeXray(failFirstBad);
    const svc = makeSvc(xray);
    const config = userConfig(servers, 'good');
    await svc.prepareXrayBridge(config);

    expect(xray.test).toHaveBeenCalledTimes(56);
    expect(bad.every((s) => svc.gateInvalidNodes.has(s.id))).toBe(true);
    expect(svc.xrayBridge.nodes.map((n: { serverId: string }) => n.serverId)).toEqual(['good']);

    const sb = svc.generateSingBoxConfig(config) as SingBoxConfig;
    const ob = sb.outbounds.find((o) => o.tag === 'GOOD');
    expect(ob?.type).toBe('socks');
    expect(ob?.server_port).toBe(svc.xrayBridge.nodes[0].port);
    expect(ob?.password).not.toBe('placeholder');
    expect(dialIn(sb)?.listen_port).toBe(svc.xrayBridge.dialInbound.port);
    expect(dialIn(sb)?.listen_port).toBeGreaterThan(1024);
    expect(sb.outbounds.some((o) => o.tag.startsWith('BAD'))).toBe(false);
  });

  it('本会话无可用 Xray 节点（全部失败）→ 起核配置不含任何 Xray 桥（不回落占位桥）', async () => {
    const xray = fakeXray(() => ({ stderr: 'Failed to start: main: something global failed' }));
    const svc = makeSvc(xray);
    const config = userConfig([xh('a'), xh('b'), hy2('hop')], 'hop');
    await svc.prepareXrayBridge(config);
    expect(svc.xrayBridge).toBeNull();
    expect(svc.xrayPrepared).toBe(true);

    // 模拟残留：节点没进 gate（如将来逻辑漏网）——起核路径依然不得为它们发射占位桥
    svc.gateInvalidNodes.clear();
    const sb = svc.generateSingBoxConfig(config) as SingBoxConfig;
    expect(dialIn(sb)).toBeUndefined();
    expect(sb.outbounds.some((o) => o.tag === 'A' || o.tag === 'B')).toBe(false);
    expect(JSON.stringify(sb)).not.toContain('placeholder');
  });

  it('未起核路径（快照 / 预检 / 诊断）仍用占位桥；停核后回到占位', async () => {
    const config = userConfig([xh('a'), hy2('hop')], 'hop');
    const fresh = makeSvc();
    const snap = fresh.generateSingBoxConfig(config) as SingBoxConfig;
    expect(dialIn(snap)?.users?.[0]?.password).toBe('placeholder');

    const svc = makeSvc();
    await svc.prepareXrayBridge(config);
    expect(
      svc.generateSingBoxConfig(config).outbounds.find((o: any) => o.tag === 'A')?.password
    ).not.toBe('placeholder');
    await svc.stopXraySidecar();
    const after = svc.generateSingBoxConfig(config) as SingBoxConfig;
    expect(dialIn(after)?.users?.[0]?.password).toBe('placeholder');
  });
});

describe('prepareXrayBridge：归因不到 tag 的 -test 失败逐节点归因', () => {
  const UNTAGGED =
    'Failed to start: main: failed to create server > proxy/shadowsocks_2022: create method > decode key: illegal base64 data at input byte 4';

  it('只剔真正失败的节点，其余（含选中）照常入桥', async () => {
    const xray = fakeXray((cfg) =>
      nodeTags(cfg).includes('n-ss') ? { stderr: UNTAGGED } : { ok: true }
    );
    const svc = makeSvc(xray);
    const config = userConfig([xh('a'), xh('ss'), xh('sel')], 'sel');
    await svc.prepareXrayBridge(config);

    expect(svc.gateInvalidNodes.has('ss')).toBe(true);
    expect(svc.gateInvalidNodes.get('ss').reason).toContain('decode key');
    expect(svc.gateInvalidNodes.has('a')).toBe(false);
    expect(svc.xrayBridge.nodes.map((n: { serverId: string }) => n.serverId).sort()).toEqual([
      'a',
      'sel',
    ]);
    // 1 次全量 + 3 次单节点 + 1 次剔除后全量
    expect(xray.test).toHaveBeenCalledTimes(5);
  });

  it('逐个都能过（组合才失败）→ 按全局错误：全部不可用，选中 Xray 节点 throw', async () => {
    const xray = fakeXray((cfg) =>
      nodeTags(cfg).length > 1 ? { stderr: UNTAGGED } : { ok: true }
    );
    const svc = makeSvc(xray);
    await expect(
      svc.prepareXrayBridge(userConfig([xh('a'), xh('b'), hy2('hop')], 'a'))
    ).rejects.toThrow(/选中节点「A」Xray 配置校验失败/);

    const svc2 = makeSvc(
      fakeXray((cfg) => (nodeTags(cfg).length > 1 ? { stderr: UNTAGGED } : { ok: true }))
    );
    await svc2.prepareXrayBridge(userConfig([xh('a'), xh('b'), hy2('hop')], 'hop'));
    expect(svc2.gateInvalidNodes.has('a') && svc2.gateInvalidNodes.has('b')).toBe(true);
    expect(svc2.xrayBridge).toBeNull();
  });

  it('只剩一个节点时不再单测（直接记失败）', async () => {
    const xray = fakeXray(() => ({ stderr: UNTAGGED }));
    const svc = makeSvc(xray);
    await svc.prepareXrayBridge(userConfig([xh('a'), hy2('hop')], 'hop'));
    expect(xray.test).toHaveBeenCalledTimes(1);
    expect(svc.gateInvalidNodes.has('a')).toBe(true);
  });
});

describe('xray-dial-in 端口被抢占：重分配 + 重起 Xray，由下一条起核腿 await', () => {
  it('isXrayDialPortConflict：点名 tag 或端口的 bind 冲突才算', () => {
    const svc = makeSvc();
    svc.xrayBridge = { dialInbound: { port: 40123, users: [] } };
    const line = (s: string) => `FATAL[0000] start service: ${s}: bind: address already in use`;
    expect(
      svc.isXrayDialPortConflict(
        line('start inbound/socks[xray-dial-in]: listen tcp 127.0.0.1:40123')
      )
    ).toBe(true);
    expect(
      svc.isXrayDialPortConflict(line('start inbound/socks[x]: listen tcp 127.0.0.1:40123'))
    ).toBe(true);
    expect(
      svc.isXrayDialPortConflict(line('start inbound/mixed[mixed-in]: listen tcp 127.0.0.1:401234'))
    ).toBe(false);
    expect(
      svc.isXrayDialPortConflict(line('start inbound/mixed[mixed-in]: listen tcp 127.0.0.1:7890'))
    ).toBe(false);
    expect(svc.isXrayDialPortConflict('xray-dial-in: connection refused')).toBe(false);
    svc.xrayBridge = null;
    expect(svc.isXrayDialPortConflict(line('start inbound/socks[xray-dial-in]: x'))).toBe(false);
  });

  /** startInternal 的外围重活全部桩掉，只留 Xray 规划 / 配置生成 / 重试编排是真的。 */
  function harness(xray: ReturnType<typeof fakeXray>, legs: Array<(svc: any) => Promise<void>>) {
    const svc = makeSvc(xray);
    const stub = (name: string, impl: (...a: any[]) => any = async () => {}) => {
      svc[name] = jest.fn(impl);
    };
    for (const n of [
      'maybePromptHelperGate',
      'killOrphanedSingBoxProcesses',
      'resolveClashApiPortConflict',
      'reconcileCoreWithBundledBaseline',
      'fixFilePermissions',
      'applyTunAddressPreflight',
      'copyRuleSetsToUserData',
      'writeCustomRuleFiles',
      'allocateProbePorts',
      'startNodeDnsRaceServer',
      'checkAndPruneConfig',
      'ensureCronetReadyForLaunch',
      'captureDefaultRoute',
      'ensureSystemDnsRestored',
    ]) {
      stub(n);
    }
    stub('getCoreVersion', async () => '1.14.0');
    stub('resolveTailscaleApiPort', async () => 19099);
    stub('startTunAddressPreflight', async () => null);
    stub('resolveMacTunDefaultInterface', async () => null);
    stub('reconcileRuntimeOwnershipBeforeStart', () => {});
    stub('readNetworkFingerprint', () => '');
    // 起核成功后的首个非 try 收尾步骤：抛哨兵截停（之后是管理 API / 系统代理等与本题无关的重活）。
    stub('flushOsDnsCacheBestEffort', () => {
      throw new Error('SENTINEL-after-start');
    });
    svc.meshExitRoute.snapshotBaseline = jest.fn(async () => {});
    const written: SingBoxConfig[] = [];
    stub('writeSingBoxConfig', async (cfg: SingBoxConfig) => {
      written.push(JSON.parse(JSON.stringify(cfg)));
    });
    let leg = 0;
    stub('startSingBoxProcess', async () => legs[leg++](svc));
    return { svc, written, legCount: () => leg };
  }

  const dialers = (cfg: XrayConfig) =>
    cfg.outbounds
      .filter((o) => o.tag.startsWith('flowz-dialer'))
      .map((o) => (o.settings as any).servers[0].port as number);

  it('下一腿起核前：桥规划 / sing-box 入站 / Xray dialer 已切到新端口，Xray 已按新配置重起完成', async () => {
    const xray = fakeXray();
    let restartDone = false;
    xray.start.mockImplementation(async () => {
      if (xray.start.mock.calls.length === 2) {
        await new Promise((r) => setTimeout(r, 150)); // 重起比重试退避（10ms）慢：fire-and-forget 会被下一腿抢跑
        restartDone = true;
      }
    });
    let oldPort = 0;
    let seenAtLeg2: {
      restartDone: boolean;
      plan: number;
      inbound?: number;
      dialers: number[];
    } | null = null;
    const { svc, written } = harness(xray, [
      async (s) => {
        oldPort = s.xrayBridge.dialInbound.port;
        throw new Error(
          `端口已被占用，请在设置中更换其他端口或关闭占用端口的程序 [FATAL[0000] start service: start inbound/socks[xray-dial-in]: listen tcp 127.0.0.1:${oldPort}: bind: address already in use]`
        );
      },
      async (s) => {
        seenAtLeg2 = {
          restartDone,
          plan: s.xrayBridge.dialInbound.port,
          inbound: dialIn(written[written.length - 1])?.listen_port,
          dialers: dialers(xray.start.mock.calls[1][0]),
        };
      },
    ]);
    const config = userConfig([xh('a'), xh('b'), hy2('hop')], 'hop');
    config.servers[1].detour = 'hop'; // 走前置代理 → 多一个 dialer，同样须切端口
    await expect(svc.startInternal(config)).rejects.toThrow('SENTINEL-after-start');

    expect(xray.start).toHaveBeenCalledTimes(2);
    expect(seenAtLeg2).not.toBeNull();
    const s2 = seenAtLeg2!;
    expect(s2.restartDone).toBe(true);
    expect(s2.plan).not.toBe(oldPort);
    expect(s2.inbound).toBe(s2.plan);
    expect(s2.dialers).toHaveLength(2);
    expect(s2.dialers.every((p) => p === s2.plan)).toBe(true);
    expect(svc.xrayBridge.dialers.every((d: { port: number }) => d.port === s2.plan)).toBe(true);
  });

  it('重分配后重起 Xray 失败且选中 Xray 节点 → 终态失败，不再起下一腿', async () => {
    const xray = fakeXray();
    xray.start.mockImplementation(async () => {
      if (xray.start.mock.calls.length === 2)
        throw new Error('Xray 内核启动失败（退出码 23）：boom');
    });
    const { svc, legCount } = harness(xray, [
      async (s) => {
        throw new Error(
          `端口已被占用 [listen tcp 127.0.0.1:${s.xrayBridge.dialInbound.port}: bind: address already in use]`
        );
      },
      async () => {
        throw new Error('不应起第二腿');
      },
    ]);
    await expect(svc.startInternal(userConfig([xh('a'), hy2('hop')], 'a'))).rejects.toThrow(
      /Xray 内核启动失败（退出码 23）/
    );
    expect(legCount()).toBe(1);
  });
});

describe('测速临时 Xray：启动期回收残留 + 退出回收进行中会话', () => {
  it('reapOrphanedXray 回收 xray_speedtest_*.pid（进程名确认）并删配置；本会话进行中的不动', async () => {
    const svc = makeSvc();
    const pid = (stamp: string) => path.join(TMP, `xray_speedtest_${stamp}.pid`);
    const json = (stamp: string) => path.join(TMP, `xray_speedtest_${stamp}.json`);
    fsSync.writeFileSync(pid('old-1'), JSON.stringify({ pid: 999991 }));
    fsSync.writeFileSync(json('old-1'), '{"secret":1}');
    fsSync.writeFileSync(json('old-2'), '{"secret":2}'); // 只剩配置（停了没删完）
    fsSync.writeFileSync(pid('live'), JSON.stringify({ pid: 999992 }));
    fsSync.writeFileSync(json('live'), '{}');
    svc.xraySpeedTestSessions.set(pid('live'), async () => {});
    const reaped: string[] = [];
    const spy = jest
      .spyOn(XrayCoreManager.prototype, 'killOrphan')
      .mockImplementation(async function (this: any) {
        reaped.push(this.deps.pidPath);
        fsSync.rmSync(this.deps.pidPath, { force: true });
      });
    try {
      await svc.reapOrphanedXray();
    } finally {
      spy.mockRestore();
    }
    expect(svc._xrayManager.killOrphan).toHaveBeenCalled(); // 主 sidecar 的 xray.pid 照旧
    expect(reaped.sort()).toEqual([pid('old-1'), pid('old-2')].sort());
    expect(fsSync.existsSync(json('old-1'))).toBe(false);
    expect(fsSync.existsSync(json('old-2'))).toBe(false);
    expect(fsSync.existsSync(pid('live'))).toBe(true);
    expect(fsSync.existsSync(json('live'))).toBe(true);
  });

  it('teardownForQuit 回收进行中的测速会话', async () => {
    const svc = makeSvc();
    svc.stop = jest.fn(async () => {});
    const dispose = jest.fn(async () => {});
    svc.xraySpeedTestSessions.set('/x/xray_speedtest_a.pid', dispose);
    await withPlatformAsync('linux', () => svc.teardownForQuit());
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
