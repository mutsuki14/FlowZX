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

import { planXrayBridge, xrayNodeWantsTlsFragment } from '../xray-bridge';
import { resourceManager } from '../ResourceManager';
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

describe('TLS 分片 × Xray 节点（经 xray-dial-in 路由选项 tls_fragment）', () => {
  beforeEach(() => (n = 0));
  const custom = (id: string, stream: Record<string, unknown>, protocol = 'vless'): ServerConfig =>
    ({
      id,
      name: id.toUpperCase(),
      protocol: 'custom',
      address: '',
      port: 0,
      customSettings: { engine: 'xray', outbound: { protocol, streamSettings: stream } },
    }) as ServerConfig;

  it('xrayNodeWantsTlsFragment：全局或节点 fragment，且仅 TLS/REALITY（含 trojan 隐式 TLS）；自定义 JSON 只认全局', () => {
    expect(xrayNodeWantsTlsFragment(xh('a'), true)).toBe(true);
    expect(xrayNodeWantsTlsFragment(xh('a'), false)).toBe(false);
    expect(xrayNodeWantsTlsFragment(xh('a', { tlsSettings: { fragment: true } }), false)).toBe(
      true
    );
    expect(
      xrayNodeWantsTlsFragment(
        xh('a', { security: 'reality', realitySettings: { publicKey: 'k' } }),
        true
      )
    ).toBe(true);
    expect(xrayNodeWantsTlsFragment(xh('a', { security: 'none' }), true)).toBe(false);
    expect(
      xrayNodeWantsTlsFragment(
        xh('t', { protocol: 'trojan', security: undefined, password: 'p' }),
        true
      )
    ).toBe(true);
    expect(xrayNodeWantsTlsFragment(custom('c', { security: 'tls' }), true)).toBe(true);
    expect(xrayNodeWantsTlsFragment(custom('c', { security: 'REALITY' }), true)).toBe(true);
    expect(xrayNodeWantsTlsFragment(custom('c', { security: 'none' }), true)).toBe(false);
    expect(xrayNodeWantsTlsFragment(custom('c', {}), true)).toBe(false);
    expect(xrayNodeWantsTlsFragment(custom('c', { security: 'tls' }), false)).toBe(false);
    // QUIC 系（Xray hysteria）无 TCP ClientHello → 不分片
    expect(
      xrayNodeWantsTlsFragment(
        custom('c', { network: 'hysteria', security: 'tls' }, 'hysteria'),
        true
      )
    ).toBe(false);
  });

  it('planXrayBridge：需分片节点改用 -frag dialer 用户（按前置复用、via 序号与非分片同号）；dialRoute 标 tlsFragment', () => {
    const hop = hy2('hop');
    const a = xh('a'); // TLS → 分片
    const b = xh('b', { security: 'none' }); // 明文 → 不分片
    const c = xh('c', { detour: 'hop' }); // TLS + 前置 → via-0-frag
    const d = xh('d', { detour: 'hop', security: 'none' }); // 前置、不分片 → via-0
    const e = xh('e'); // 与 a 共用 flowz-dialer-frag
    const cands = [a, b, c, d, e];
    const plan = planXrayBridge({
      candidates: cands,
      allServers: [hop, ...cands],
      ports: ports(cands.length + 1),
      secret,
      tlsFragment: true,
    });
    expect(plan.nodes.map((x) => [x.serverId, x.dialerTag])).toEqual([
      ['a', 'flowz-dialer-frag'],
      ['b', 'flowz-dialer'],
      ['c', 'flowz-dialer-via-0-frag'],
      ['d', 'flowz-dialer-via-0'],
      ['e', 'flowz-dialer-frag'],
    ]);
    expect(plan.dialRoutes).toEqual([
      { username: 'direct' },
      { username: 'direct-frag', tlsFragment: true },
      { username: 'via-0-frag', detourServerId: 'hop', tlsFragment: true },
      { username: 'via-0', detourServerId: 'hop' },
    ]);
    expect(plan.dialers.map((x) => [x.tag, x.user])).toEqual([
      ['flowz-dialer', 'direct'],
      ['flowz-dialer-frag', 'direct-frag'],
      ['flowz-dialer-via-0-frag', 'via-0-frag'],
      ['flowz-dialer-via-0', 'via-0'],
    ]);
    expect(plan.dialInbound.users.map((u) => u.username)).toEqual([
      'direct',
      'direct-frag',
      'via-0-frag',
      'via-0',
    ]);
    expect(new Set(plan.dialInbound.users.map((u) => u.password)).size).toBe(4);
  });

  it('全局关、无节点 fragment → 规划与旧版一致（零 -frag）；withDialer=false 不涉及分片', () => {
    const a = xh('a');
    const off = planXrayBridge({ candidates: [a], allServers: [a], ports: ports(2), secret });
    expect(off.dialers.map((x) => x.tag)).toEqual(['flowz-dialer']);
    expect(off.dialRoutes).toEqual([{ username: 'direct' }]);
    const direct = planXrayBridge({
      candidates: [a],
      allServers: [a],
      ports: ports(1),
      secret,
      withDialer: false,
      tlsFragment: true,
    });
    expect(direct.dialers).toEqual([]);
    expect(direct.dialRoutes).toEqual([]);
  });

  it('buildRouteConfig：tlsFragment 路由挂 tls_fragment:true；前置不可用的 reject 规则不挂', () => {
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
        { username: 'direct-frag', outbound: 'xray-dial-direct', tlsFragment: true },
        { username: 'via-0-frag', outbound: undefined, tlsFragment: true },
      ],
    });
    expect((rc.rules ?? []).slice(0, 4)).toEqual([
      {
        inbound: ['xray-dial-in'],
        auth_user: ['direct'],
        action: 'route',
        outbound: 'xray-dial-direct',
      },
      {
        inbound: ['xray-dial-in'],
        auth_user: ['direct-frag'],
        action: 'route',
        outbound: 'xray-dial-direct',
        tls_fragment: true,
      },
      { inbound: ['xray-dial-in'], auth_user: ['via-0-frag'], action: 'reject' },
      { inbound: ['xray-dial-in'], action: 'reject' },
    ]);
  });
});

describe('buildOutbounds × Xray 前置链级联 / 跳过原因', () => {
  const vlessTls = (id: string, detour?: string): ServerConfig =>
    ({
      id,
      name: id.toUpperCase(),
      protocol: 'vless',
      address: `${id}.example.com`,
      port: 443,
      uuid: '8a502aeb-b677-4fc6-bdbf-0b11435a99ec',
      security: 'tls',
      tlsSettings: { serverName: `${id}.example.com` },
      detour,
    }) as ServerConfig;

  it('Xray 节点的前置（sing-box 节点）因自身 detour 失效被预校验剔除 → Xray 节点一并剔除并记 gate（不留 reject 死节点）', () => {
    const x1 = xh('x1', { detour: 'd1' });
    const d1 = vlessTls('d1', 'e1');
    const e1 = hy2('e1');
    const s2 = hy2('s2');
    const servers = [x1, d1, e1, s2];
    const bridge = planXrayBridge({
      candidates: [x1],
      allServers: servers,
      ports: ports(2),
      secret,
    });
    expect(bridge.detourOf.get('x1')).toBe('d1');
    const gate = new Map<string, InvalidNodeInfo>([
      ['e1', { id: 'e1', tag: 'E1', reason: 'xray -test failed' }],
    ]);
    const ids = idMap(servers);
    const r = buildOutbounds(s2, cfg(servers, 's2'), ids, {
      gateInvalidNodes: gate,
      log: () => {},
      xrayBridge: bridge,
    });
    const tags = r.outbounds.map((o) => o.tag);
    expect(tags).not.toContain('D1');
    expect(tags).not.toContain('X1');
    expect(r.outbounds.find((o) => o.tag === 'proxy-selector')?.outbounds).toEqual([
      'S2',
      'direct',
    ]);
    expect(gate.get('d1')?.reason).toMatch(/detour/);
    expect(gate.get('x1')?.reason).toMatch(/detour/);
    expect(ids.has('x1')).toBe(false);

    // 选中的正是该 Xray 节点 → 明确 throw（不静默选中一个回环路由 reject 的死节点）
    expect(() =>
      buildOutbounds(x1, cfg(servers, 'x1'), idMap(servers), {
        gateInvalidNodes: new Map([['e1', { id: 'e1', tag: 'E1', reason: 'x' }]]),
        log: () => {},
        xrayBridge: bridge,
      })
    ).toThrow(/前置节点/);
  });

  it('Xray 内核缺失：跳过日志写明 Xray 内核（不误报 libcronet）', () => {
    const logs: string[] = [];
    const orig = resourceManager.hasXrayCore;
    resourceManager.hasXrayCore = () => false;
    try {
      const servers = [hy2('h'), xh('a')];
      buildOutbounds(servers[0], cfg(servers), idMap(servers), {
        gateInvalidNodes: new Map(),
        log: (_l: string, m: string) => logs.push(m),
        xrayBridge: null,
      });
    } finally {
      resourceManager.hasXrayCore = orig;
    }
    const line = logs.find((m) => m.includes('「A」'));
    expect(line).toMatch(/Xray 内核/);
    expect(line).not.toMatch(/libcronet/);
  });
});
