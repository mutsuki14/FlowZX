/**
 * Xray 桥：规划（planXrayBridge）+ sing-box 侧接线（buildOutbounds / buildInbounds / buildRouteConfig）。
 * 运行时真链路由 xray-runtime-e2e 覆盖；这里锁形状与 fail-closed 语义（前置代理不可用绝不改直连）。
 */
jest.mock('electron', () => ({
  app: { getPath: () => '/fake/userData', getAppPath: () => '/fake/app', isPackaged: false },
  net: {},
}));
// 局部 mock：真实 ResourceManager（geo 规则集等路径照常），仅把「Xray 内核在位」固定为 true——
// CI 不拉二进制，若走真实探测 Xray 节点会被 isNodeUsable 判不可用而跳过，用例失去对象。
jest.mock('../ResourceManager', () => {
  const actual = jest.requireActual('../ResourceManager');
  actual.resourceManager.hasXrayCore = () => true;
  return actual;
});

import { planXrayBridge } from '../xray-bridge';
import { buildOutbounds } from '../singbox-outbound-builder';
import { buildInbounds } from '../singbox-inbounds-builder';
import { buildRouteConfig } from '../singbox-route-builder';
import type { ServerConfig, UserConfig, InvalidNodeInfo } from '../../../shared/types';

const xh = (id: string, over: Partial<ServerConfig> = {}): ServerConfig =>
  ({
    id,
    name: id.toUpperCase(),
    protocol: 'vless',
    address: `${id}.example.com`,
    port: 443,
    uuid: 'u',
    network: 'xhttp',
    security: 'tls',
    ...over,
  }) as ServerConfig;
const hy2 = (id: string): ServerConfig =>
  ({
    id,
    name: id.toUpperCase(),
    protocol: 'hysteria2',
    address: 'h',
    port: 443,
    password: 'p',
  }) as ServerConfig;
const wg = (id: string): ServerConfig =>
  ({
    id,
    name: id.toUpperCase(),
    protocol: 'wireguard',
    address: 'w',
    port: 51820,
    wireguardSettings: { privateKey: 'k', peerPublicKey: 'p', localAddress: ['10.0.0.2/32'] },
  }) as ServerConfig;

let n = 0;
const secret = () => `s${++n}`;
const ports = (k: number) => Array.from({ length: k }, (_, i) => 20000 + i);
const cfg = (servers: ServerConfig[], selected = servers[0].id): UserConfig =>
  ({
    proxyMode: 'smart',
    proxyModeType: 'systemProxy',
    servers,
    selectedServerId: selected,
    customRules: [],
    appRules: [],
    mixedPort: 7890,
  }) as unknown as UserConfig;
const idMap = (servers: ServerConfig[]) => new Map(servers.map((s) => [s.id, s.name]));

describe('planXrayBridge', () => {
  beforeEach(() => (n = 0));

  it('每节点独立端口/凭据；无前置共用 flowz-dialer(direct)；dialInbound 取末位端口', () => {
    const a = xh('a');
    const b = xh('b');
    const plan = planXrayBridge({
      candidates: [a, b],
      allServers: [a, b],
      ports: ports(3),
      secret,
    });
    expect(
      plan.nodes.map((x) => [x.serverId, x.port, x.inboundTag, x.outboundTag, x.dialerTag])
    ).toEqual([
      ['a', 20000, 'in-a', 'n-a', 'flowz-dialer'],
      ['b', 20001, 'in-b', 'n-b', 'flowz-dialer'],
    ]);
    expect(new Set(plan.nodes.map((x) => x.pass)).size).toBe(2);
    expect(plan.dialInbound.port).toBe(20002);
    expect(plan.dialRoutes).toEqual([{ username: 'direct' }]);
    expect(plan.dialers).toHaveLength(1);
  });

  it('前置代理：同一前置复用一个 dialer；成环 / endpoint / 不存在 → 忽略前置（告警）', () => {
    const hop = hy2('hop');
    const a = xh('a', { detour: 'hop' });
    const b = xh('b', { detour: 'hop' });
    const loopA = xh('la', { detour: 'lb' });
    const loopB = xh('lb', { detour: 'la' });
    const viaWg = xh('vw', { detour: 'w' });
    const ghost = xh('gh', { detour: 'nope' });
    const all = [hop, a, b, loopA, loopB, viaWg, wg('w'), ghost];
    const warns: string[] = [];
    const cands = [a, b, loopA, loopB, viaWg, ghost];
    const plan = planXrayBridge({
      candidates: cands,
      allServers: all,
      ports: ports(cands.length + 1),
      secret,
      warn: (m) => warns.push(m),
    });
    expect([...plan.detourOf.entries()]).toEqual([
      ['a', 'hop'],
      ['b', 'hop'],
    ]);
    expect(plan.dialers.map((d) => d.tag)).toEqual(['flowz-dialer', 'flowz-dialer-via-0']);
    expect(plan.dialRoutes).toEqual([
      { username: 'direct' },
      { username: 'via-0', detourServerId: 'hop' },
    ]);
    expect(plan.nodes.find((x) => x.serverId === 'la')?.dialerTag).toBe('flowz-dialer');
    expect(warns.some((w) => /成环/.test(w))).toBe(true);
    expect(warns.some((w) => /endpoint/.test(w))).toBe(true);
  });

  it('withDialer=false（临时测速直拨）：无 dialer、无回环入站', () => {
    const a = xh('a', { detour: 'hop' });
    const plan = planXrayBridge({
      candidates: [a],
      allServers: [a, hy2('hop')],
      ports: ports(1),
      secret,
      withDialer: false,
    });
    expect(plan.dialers).toEqual([]);
    expect(plan.dialInbound.port).toBe(0);
    expect(plan.nodes[0].dialerTag).toBeUndefined();
    expect(plan.detourOf.size).toBe(0);
  });
});

describe('buildOutbounds × Xray 桥', () => {
  const deps = (bridge: ReturnType<typeof planXrayBridge> | null) => ({
    gateInvalidNodes: new Map<string, InvalidNodeInfo>(),
    log: () => {},
    xrayBridge: bridge,
  });

  it('Xray 节点 → 指向 sidecar 的 socks 出站（无 detour 字段），进 proxy-selector；xray-dial-direct 用节点解析器', () => {
    const servers = [xh('a'), hy2('h')];
    const bridge = planXrayBridge({
      candidates: [servers[0]],
      allServers: servers,
      ports: ports(2),
      secret,
    });
    const r = buildOutbounds(servers[0], cfg(servers), idMap(servers), deps(bridge));
    const ob = r.outbounds.find((o) => o.tag === 'A')!;
    expect(ob).toEqual({
      type: 'socks',
      tag: 'A',
      server: '127.0.0.1',
      server_port: 20000,
      username: 'flowz',
      password: bridge.nodes[0].pass,
    });
    expect(r.outbounds.find((o) => o.tag === 'proxy-selector')?.outbounds).toEqual([
      'A',
      'H',
      'direct',
    ]);
    expect(r.outbounds.find((o) => o.tag === 'xray-dial-direct')).toMatchObject({ type: 'direct' });
  });

  it('无桥（预检/快照或 Xray 不可用）→ Xray 节点不发射、不产 xray-dial-direct', () => {
    const servers = [hy2('h'), xh('a')];
    const r = buildOutbounds(servers[0], cfg(servers), idMap(servers), deps(null));
    expect(r.outbounds.map((o) => o.tag)).not.toContain('A');
    expect(r.outbounds.map((o) => o.tag)).not.toContain('xray-dial-direct');
  });

  it('前置节点未发射 → Xray 节点剔除并记 gate 原因（不改直连）；选中则 throw', () => {
    const naive = {
      id: 'nv',
      name: 'NV',
      protocol: 'naive',
      address: 'x',
      port: 443,
      username: 'u',
      password: 'p',
    } as ServerConfig;
    const a = xh('a', { detour: 'gone' });
    const servers = [hy2('h'), a, { ...hy2('gone') }];
    const bridge = planXrayBridge({
      candidates: [a],
      allServers: servers,
      ports: ports(2),
      secret,
    });
    const d = deps(bridge);
    d.gateInvalidNodes.set('gone', { id: 'gone', tag: 'GONE', reason: 'x' }); // 前置被 gate 剔除
    const r = buildOutbounds(servers[0], cfg(servers), idMap(servers), d);
    expect(r.outbounds.map((o) => o.tag)).not.toContain('A');
    expect(d.gateInvalidNodes.get('a')?.reason).toMatch(/前置/);
    expect(() =>
      buildOutbounds(a, cfg(servers, 'a'), idMap(servers), {
        ...deps(bridge),
        gateInvalidNodes: new Map([['gone', { id: 'gone', tag: 'GONE', reason: 'x' }]]),
      })
    ).toThrow(/前置节点不可用/);
    void naive;
  });

  it('Shadow-TLS 后处理跳过 Xray 节点（socks 桥出站不得被挂 detour）', () => {
    const a = xh('a', { shadowTlsSettings: { password: 'p', sni: 's' } });
    const servers = [a];
    const bridge = planXrayBridge({
      candidates: [a],
      allServers: servers,
      ports: ports(2),
      secret,
    });
    const r = buildOutbounds(a, cfg(servers), idMap(servers), deps(bridge));
    expect(r.outbounds.find((o) => o.tag === 'A')?.detour).toBeUndefined();
    expect(r.outbounds.some((o) => o.type === 'shadowtls')).toBe(false);
  });
});

describe('buildInbounds / buildRouteConfig × Xray 回环', () => {
  it('xray-dial-in：loopback socks + 凭据', () => {
    const ib = buildInbounds(cfg([hy2('h')]), undefined, {
      probeDirectPort: null,
      probeProxyPort: null,
      updateInPort: null,
      xrayDialInbound: { port: 21081, users: [{ username: 'direct', password: 'pw' }] },
    }).find((i) => i.tag === 'xray-dial-in');
    expect(ib).toEqual({
      type: 'socks',
      tag: 'xray-dial-in',
      listen: '127.0.0.1',
      listen_port: 21081,
      users: [{ username: 'direct', password: 'pw' }],
    });
  });

  it('回环路由先于 sniff；缺前置 → reject；兜底 reject；按 Xray 路径直连', () => {
    const rc = buildRouteConfig(cfg([hy2('h')]), new Map(), {
      probeDirectPort: null,
      probeProxyPort: null,
      updateInPort: null,
      lanResolverForDns: null,
      pendingEndpoints: [],
      log: () => {},
      onDegraded: () => {},
      xrayDialRoutes: [
        { username: 'direct', outbound: 'xray-dial-direct' },
        { username: 'via-0', outbound: undefined },
      ],
      xrayProcessPath: '/opt/FlowZ/resources/linux/xray',
    });
    const rules = rc.rules ?? [];
    expect(rules.slice(0, 4)).toEqual([
      {
        inbound: ['xray-dial-in'],
        auth_user: ['direct'],
        action: 'route',
        outbound: 'xray-dial-direct',
      },
      { inbound: ['xray-dial-in'], auth_user: ['via-0'], action: 'reject' },
      { inbound: ['xray-dial-in'], action: 'reject' },
      { action: 'sniff' },
    ]);
    expect(rules).toContainEqual({
      process_path: ['/opt/FlowZ/resources/linux/xray'],
      action: 'route',
      outbound: 'direct',
    });
  });

  it('无 Xray 节点 → 零注入（既有配置字节不变）', () => {
    const rc = buildRouteConfig(cfg([hy2('h')]), new Map(), {
      probeDirectPort: null,
      probeProxyPort: null,
      updateInPort: null,
      lanResolverForDns: null,
      pendingEndpoints: [],
      log: () => {},
      onDegraded: () => {},
    });
    expect(JSON.stringify(rc.rules)).not.toMatch(/xray/);
    expect(rc.rules?.[0]).toEqual({ action: 'sniff' });
  });
});
