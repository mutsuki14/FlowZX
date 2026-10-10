/**
 * singbox-outbound-builder 共享端点/选择器 helper 单测。
 * buildProxyOutbound 由 protocol-parser/config-snapshot 集成覆盖；此处锁 step9 抽入的 WG endpoint 构造默认值
 * （keepalive=25 / allowed_ips 全量 / mtu 兜底）与 isNodeUsable naive 门控（resourceManager spy）。
 */
// buildTailscaleEndpoint 调用 tailscaleStateDir(→ electron app.getPath) + mkdirSync。mock tailscale-state
// 把 state 目录指向 tmp，避免依赖 electron（与 tailscale-state.test 同款隔离思路，但只 mock 路径产出）。
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
const TS_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-ts-ep-'));
jest.mock('../tailscale-state', () => ({
  tailscaleStateDir: (id: string) => `${require('os').tmpdir()}/flowz-ts-ep-state/${id}`,
}));

import {
  buildWireGuardEndpoint,
  buildTailscaleEndpoint,
  buildProxyOutbound,
  isNodeUsable,
  prunedSelectorDefault,
  shouldEmitTlsEngine,
} from '../singbox-outbound-builder';
import { getNodeDialDomainResolver } from '../singbox-config-helpers';
import { resourceManager } from '../ResourceManager';
import type { ServerConfig, UserConfig } from '../../../shared/types';

afterAll(() => {
  try {
    fs.rmSync(TS_TMP, { recursive: true, force: true });
    fs.rmSync(`${os.tmpdir()}/flowz-ts-ep-state`, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/**
 * buildProxyOutbound 第三参 `nodeResolverTag` 已改**必填**（原 `= 'dns-bootstrap'` 默认值是静默后门：漏传与
 * 「显式选字符串形态」在类型上不可区分 → 实测删掉一处实参后全量 3451 测试零红）。
 *
 * 下面三个常量 = **生产中真实出现的全部形态**，供本文件里与 domain_resolver 正交的用例轮换使用（而非全填
 * 同一个字面量）：被测字段与解析器形态无关，轮换则顺带保证「任一形态下这些字段都照常下发」。
 * domain_resolver 形态本身的锁在下方 `domain_resolver 形态 — IPv6-only 域名节点修复` 组，走 toEqual 深等。
 */
/** config-gen 关 IPv6（出厂默认档）：getNodeDialDomainResolver → { server:'dns-node-race', strategy:'prefer_ipv4' }。 */
const DR_V6_OFF = getNodeDialDomainResolver({ enableIPv6: false } as unknown as UserConfig);
/** config-gen 开 IPv6：字符串 tag 'dns-node-race'（顶层已 prefer_ipv4，结构化冗余）。 */
const DR_V6_ON = getNodeDialDomainResolver({ enableIPv6: true } as unknown as UserConfig);
/** 测速链路（ProxyManager.buildSpeedTestConfig）硬传的固定 tag。 */
const DR_SPEEDTEST = 'dns-direct';

const wgServer = (over: Partial<ServerConfig> = {}): ServerConfig =>
  ({
    id: 'w1',
    name: 'WG',
    protocol: 'wireguard',
    address: 'wg.example.com',
    port: 51820,
    wireguardSettings: {
      privateKey: 'cHJpdmtleQ==',
      peerPublicKey: 'cHVia2V5',
      localAddress: ['10.0.0.2/32'],
    },
    ...over,
  }) as unknown as ServerConfig;

// CI 决定性（gate≠CI 的 host-OS 依赖）：WG `name` / TS `system_interface_name` 固定接口名**仅非 macOS 下发**（macOS
// utun 名动态、刻意不设）。macOS CI 是 darwin 则 name=undefined → 断言挂。强制非 darwin 让接口名断言跨 host 确定。
// 本文件内自设 platform 的用例（跨平台导入降级 ~L490 / shouldEmitTlsEngine 显式传 platform）各自 restore 到捕获的
// orig，不受此 beforeEach 影响。
const __realPlatform = process.platform;
beforeEach(() =>
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
);
afterEach(() =>
  Object.defineProperty(process, 'platform', { value: __realPlatform, configurable: true })
);

describe('buildWireGuardEndpoint', () => {
  it('最小配置 → keepalive 兜 25s / allowed_ips 全量 / mtu 兜 1408 / system:false', () => {
    const ep = buildWireGuardEndpoint(wgServer(), 'WG');
    expect(ep.type).toBe('wireguard');
    expect(ep.tag).toBe('WG');
    expect(ep.system).toBe(false);
    expect(ep.mtu).toBe(1408);
    const peer = ep.peers![0];
    expect(peer.persistent_keepalive_interval).toBe(25);
    expect(peer.allowed_ips).toEqual(['0.0.0.0/0', '::/0']);
    expect(peer.pre_shared_key).toBeUndefined();
  });

  it('显式 keepalive/preSharedKey/mtu/reserved 原样下发；allowInternet 缺省 on → 具体段并入全网段', () => {
    const ep = buildWireGuardEndpoint(
      wgServer({
        wireguardSettings: {
          privateKey: 'pk',
          peerPublicKey: 'pub',
          localAddress: ['10.0.0.3/32'],
          allowedIPs: ['192.168.50.0/24'],
          preSharedKey: 'psk',
          persistentKeepalive: 15,
          mtu: 1280,
          reserved: [1, 2, 3],
        },
      } as unknown as Partial<ServerConfig>),
      'WG2'
    );
    expect(ep.mtu).toBe(1280);
    const peer = ep.peers![0];
    // allowInternet 缺省 true（向后兼容）→ allowed_ips = 具体段 ∪ {0/0,::/0}（Layer A，两族全给）。
    expect(peer.allowed_ips).toEqual(['192.168.50.0/24', '0.0.0.0/0', '::/0']);
    expect(peer.pre_shared_key).toBe('psk');
    expect(peer.persistent_keepalive_interval).toBe(15);
    expect(peer.reserved).toEqual([1, 2, 3]);
  });

  it('allowInternet=off + 具体段 → allowed_ips 仅具体段（剥离全网段）', () => {
    const ep = buildWireGuardEndpoint(
      wgServer({
        wireguardSettings: {
          privateKey: 'pk',
          peerPublicKey: 'pub',
          localAddress: ['10.0.0.3/32'],
          allowedIPs: ['10.8.0.0/24', '0.0.0.0/0', '::/0'],
          allowInternet: false,
        },
      } as unknown as Partial<ServerConfig>),
      'WG3'
    );
    expect(ep.peers![0].allowed_ips).toEqual(['10.8.0.0/24']);
  });

  it('allowInternet=off + 无具体段 → 抛错（空 allowed_ips=FATAL，调用方预拦不发射）', () => {
    expect(() =>
      buildWireGuardEndpoint(
        wgServer({
          wireguardSettings: {
            privateKey: 'pk',
            peerPublicKey: 'pub',
            localAddress: ['10.0.0.3/32'],
            allowedIPs: ['0.0.0.0/0', '::/0'],
            allowInternet: false,
          },
        } as unknown as Partial<ServerConfig>),
        'WG4'
      )
    ).toThrow(/外网访问|allowed/i);
  });

  it('缺 privateKey/peerPublicKey/localAddress → 抛错', () => {
    expect(() =>
      buildWireGuardEndpoint(
        wgServer({
          wireguardSettings: { privateKey: '', peerPublicKey: '', localAddress: [] },
        } as unknown as Partial<ServerConfig>),
        'X'
      )
    ).toThrow(/WireGuard/);
  });

  it('Phase2 reverseMesh=true(全隧道) → system:true + 固定名 + allowed_ips 含 0/0（System 也保留,sing-box 装接口作用域路由）', () => {
    const ep = buildWireGuardEndpoint(
      wgServer({
        wireguardSettings: {
          privateKey: 'pk',
          peerPublicKey: 'pub',
          localAddress: ['10.0.0.3/32'],
          allowedIPs: ['10.8.0.0/24'],
          reverseMesh: true,
        },
      } as unknown as Partial<ServerConfig>),
      'WGS'
    );
    expect(ep.system).toBe(true);
    expect(ep.name).toBe('flowz-wg'); // sing-box 1.14 WG endpoint 内核接口名字段=`name`（非 interface_name）
    // system WG 全隧道也用裸 0/0（cryptokey 需要；预折半已证伪：sing-tun 落内核前把 0/1+128/1 合并回裸 0/0）→ 撞
    // en0 default EEXIST、被 setRoutes 善后删、停核不回填 → 断网，由 ProxyManager 的全局 default 安全网兜底。
    expect(ep.peers![0].allowed_ips).toEqual(['10.8.0.0/24', '0.0.0.0/0', '::/0']);
  });

  it('Phase2 reverseMesh=true + 无具体段 + on → allowed_ips 仅 0/0（承载全隧道、可发射）', () => {
    const ep = buildWireGuardEndpoint(
      wgServer({
        wireguardSettings: {
          privateKey: 'pk',
          peerPublicKey: 'pub',
          localAddress: ['10.0.0.3/32'],
          reverseMesh: true,
        },
      } as unknown as Partial<ServerConfig>),
      'WGS2'
    );
    expect(ep.system).toBe(true);
    expect(ep.peers![0].allowed_ips).toEqual(['0.0.0.0/0', '::/0']);
  });

  // #58：域名 server 的 WG endpoint 需 dial 级 domain_resolver（1.14 域名拨号无确定解析上游 → WARP 测速超时）。
  it('域名 server + domainResolverTag → endpoint 顶层 emit domain_resolver', () => {
    const ep = buildWireGuardEndpoint(wgServer(), 'WG', 'dns-direct');
    expect(ep.domain_resolver).toBe('dns-direct');
  });

  it('不传 domainResolverTag → 不下发 domain_resolver（保持旧行为 / 主配置依赖 route 默认）', () => {
    const ep = buildWireGuardEndpoint(wgServer(), 'WG');
    expect(ep.domain_resolver).toBeUndefined();
  });

  it('IPv4 字面量 server + domainResolverTag → 不下发 domain_resolver（IP 直拨无需 DNS 解析）', () => {
    const ep = buildWireGuardEndpoint(wgServer({ address: '162.159.192.1' }), 'WG', 'dns-direct');
    expect(ep.domain_resolver).toBeUndefined();
  });

  it('IPv6 字面量 server + domainResolverTag → 不下发 domain_resolver', () => {
    const ep = buildWireGuardEndpoint(
      wgServer({ address: '2606:4700:d0::a29f:c001' }),
      'WG',
      'dns-direct'
    );
    expect(ep.domain_resolver).toBeUndefined();
  });
});

// ── IPv6-only（AAAA-only）域名节点修复：dial 侧结构化 domain_resolver ────────────────────────
// 病因：关 IPv6 时顶层 dns.strategy=ipv4_only（#57，抑制**目标站点** AAAA）连带使内核对**节点域名**也从不发
// AAAA 查询 → AAAA-only 域名节点解析不到地址、整个代理不可用。修复 = 节点 dial 侧单独下发结构化
// `{ server, strategy:'prefer_ipv4' }`（per-outbound strategy 覆盖顶层，loopback 实证），顶层一字不动。
//
// 本组刻意按 **production 装配方式**组合（config → getNodeDialDomainResolver → builder），断言最终 config 形态——
// 直接给 builder 喂手写形态只能验「透传」，验不到「关 IPv6 时到底发什么」这个修复对象本身。
//
// 为什么必须 toEqual（不得降级 toMatchObject / 属性点检）：`sing-box check` 对对象内**键名** typo 无牙
// （实测 `stratgy:` 仍 exit=0 → strategy 被静默丢弃、修复静默失效），对**值**才有牙。键名逃逸的唯一杀手
// 就是此处的精确形状深等断言。
describe('domain_resolver 形态 — IPv6-only 域名节点修复（关 IPv6 时 dial 侧放宽 AAAA）', () => {
  const tags = new Map<string, string>();
  const domainNode = (over: Partial<ServerConfig> = {}): ServerConfig =>
    ({
      id: 'n',
      name: 'N',
      protocol: 'trojan',
      address: 'node.v6only.test',
      port: 443,
      password: 'pw',
      security: 'tls',
      ...over,
    }) as unknown as ServerConfig;

  /** dnsConfig 缺省 = race on（isNodeRaceOn !== false）→ dial tag = dns-node-race。 */
  const ipv6Cfg = (enableIPv6: boolean, over: Partial<UserConfig> = {}): UserConfig =>
    ({
      servers: [],
      selectedServerId: null,
      proxyMode: 'smart',
      proxyModeType: 'tun',
      enableIPv6,
      ...over,
    }) as unknown as UserConfig;

  it('关 IPv6 + 域名节点 → outbound.domain_resolver 深等于 { server:<tag>, strategy:"prefer_ipv4" }', () => {
    const ob = buildProxyOutbound(domainNode(), tags, getNodeDialDomainResolver(ipv6Cfg(false)));
    // toEqual 深等：键名 typo（stratgy/Strategy）、多余键、strategy 值改回 ipv4_only 均在此处死。
    expect(ob.domain_resolver).toEqual({ server: 'dns-node-race', strategy: 'prefer_ipv4' });
  });

  it('关 IPv6 + race off（单上游档 auto）→ 换的只是 server tag，strategy 包裹层不变（档位与修复正交）', () => {
    const ob = buildProxyOutbound(
      domainNode(),
      tags,
      getNodeDialDomainResolver(
        ipv6Cfg(false, { dnsConfig: { resolveNodeDomainsAhead: false } } as Partial<UserConfig>)
      )
    );
    expect(ob.domain_resolver).toEqual({ server: 'dns-bootstrap', strategy: 'prefer_ipv4' });
  });

  it('开 IPv6 → 回字符串 tag（顶层已 prefer_ipv4，结构化冗余；该分支 config 字节零变化）', () => {
    const ob = buildProxyOutbound(domainNode(), tags, getNodeDialDomainResolver(ipv6Cfg(true)));
    // 条件反转（=true 结构化 / =false 字符串）在此与上面两条一起被封死。
    expect(ob.domain_resolver).toBe('dns-node-race');
  });

  it('IP 字面量节点 → 形态与域名节点一致（builder 不按地址类型分叉；IP 直拨不经 DNS，无行为影响）', () => {
    const ob = buildProxyOutbound(
      domainNode({ address: '198.51.100.9' }),
      tags,
      getNodeDialDomainResolver(ipv6Cfg(false))
    );
    expect(ob.server).toBe('198.51.100.9'); // 不烧 IP/不改写
    expect(ob.domain_resolver).toEqual({ server: 'dns-node-race', strategy: 'prefer_ipv4' });
  });

  // M5：只改 buildProxyOutbound 漏改 buildWireGuardEndpoint —— 域名 peer 的 WG endpoint 同病同修。
  it('WG 域名 endpoint + 关 IPv6 → endpoint.domain_resolver 深等于 { server:<tag>, strategy:"prefer_ipv4" }', () => {
    const ep = buildWireGuardEndpoint(wgServer(), 'WG', getNodeDialDomainResolver(ipv6Cfg(false)));
    expect(ep.domain_resolver).toEqual({ server: 'dns-node-race', strategy: 'prefer_ipv4' });
  });

  it('WG 域名 endpoint + 开 IPv6 → 字符串 tag', () => {
    const ep = buildWireGuardEndpoint(wgServer(), 'WG', getNodeDialDomainResolver(ipv6Cfg(true)));
    expect(ep.domain_resolver).toBe('dns-node-race');
  });

  it('WG IP 字面量 peer + 关 IPv6 → 仍不下发 domain_resolver（IP 直拨无需解析，结构化形态不误触发发射）', () => {
    const ep = buildWireGuardEndpoint(
      wgServer({ address: '162.159.192.1' }),
      'WG',
      getNodeDialDomainResolver(ipv6Cfg(false))
    );
    expect(ep.domain_resolver).toBeUndefined();
  });
});

describe('isNodeUsable', () => {
  it('非 naive → 恒可用', () => {
    expect(isNodeUsable({ protocol: 'vless' } as ServerConfig)).toBe(true);
  });
  it('naive：有/无 libcronet 决定可用性（resourceManager.hasCronetLib spy）', () => {
    const spy = jest.spyOn(resourceManager, 'hasCronetLib');
    try {
      spy.mockReturnValue(false);
      expect(isNodeUsable({ protocol: 'naive' } as ServerConfig)).toBe(false);
      spy.mockReturnValue(true);
      expect(isNodeUsable({ protocol: 'naive' } as ServerConfig)).toBe(true);
    } finally {
      spy.mockRestore(); // try/finally：断言失败也恢复 spy，防泄漏污染同文件后续用例（对齐 config-snapshot/custom-rules）
    }
  });
});

describe('prunedSelectorDefault', () => {
  it('rule-sel-* → proxy-selector；其它 → 剩余首成员', () => {
    expect(prunedSelectorDefault('rule-sel-x', ['a', 'proxy-selector'])).toBe('proxy-selector');
    expect(prunedSelectorDefault('proxy-selector', ['a', 'b'])).toBe('a');
  });
  it('proxy-selector 成员剔光（空数组）→ undefined（不伪造默认，退化态由 buildOutbounds 空守卫 throw 拦截）', () => {
    expect(prunedSelectorDefault('proxy-selector', [])).toBeUndefined();
    // rule-sel 恒嵌套回 proxy-selector，与成员是否剔空无关。
    expect(prunedSelectorDefault('rule-sel-y', [])).toBe('proxy-selector');
  });
});

// issue #147：buildProxyOutbound 的 server 恒用原域名（删 resolve-ahead 烧 IP）→ 交内核 resolveDialer 多 A 重试；
// SNI/server_name 不受影响（本就读 server.address）。
describe('buildProxyOutbound — server 恒用域名（issue #147 删烧 IP）', () => {
  const DOMAIN = 'node.example.com';
  const idMap = new Map<string, string>();
  const srv = (over: Partial<ServerConfig>): ServerConfig =>
    ({ id: 'x', name: 'X', address: DOMAIN, port: 443, ...over }) as unknown as ServerConfig;

  it('vless+tls 显式 SNI：server=域名，server_name 保留', () => {
    const ob = buildProxyOutbound(
      srv({
        protocol: 'vless',
        uuid: 'u',
        security: 'tls',
        tlsSettings: { serverName: 'sni.example.net' },
      }),
      idMap,
      'dns-bootstrap'
    );
    expect(ob.server).toBe(DOMAIN);
    expect(ob.tls?.server_name).toBe('sni.example.net');
    expect(ob.domain_resolver).toBe('dns-bootstrap');
  });

  it('无显式 SNI：server=域名，tls.server_name 回退原域名', () => {
    const ob = buildProxyOutbound(
      srv({ protocol: 'trojan', password: 'pw', security: 'tls' }),
      idMap,
      'dns-bootstrap'
    );
    expect(ob.server).toBe(DOMAIN);
    expect(ob.tls?.server_name).toBe(DOMAIN);
  });

  it('IP 字面量节点：server 原样 IP（内核直拨、无需解析）', () => {
    const ob = buildProxyOutbound(
      srv({ address: '198.51.100.9', protocol: 'trojan', password: 'pw', security: 'tls' }),
      idMap,
      'dns-bootstrap'
    );
    expect(ob.server).toBe('198.51.100.9');
  });
});

// trojan + REALITY（trojan 表单 / 分享链产出形态）：sing-box 1.14 原生承载（`sing-box check` 实证），tls 块整体换成
// REALITY 形态——不带 trojan 的默认 ALPN，指纹 'none'（trojan TLS 缺省）归一为 chrome（none 会让 sing-box FATAL）。
describe('buildProxyOutbound — trojan + REALITY', () => {
  const tags = new Map<string, string>();
  const trojanReality = (over: Partial<ServerConfig> = {}): ServerConfig =>
    ({
      id: 'tr',
      name: 'TR',
      protocol: 'trojan',
      address: 'node.example.com',
      port: 443,
      password: 'pw',
      security: 'reality',
      tlsSettings: { serverName: 'www.microsoft.com', allowInsecure: false, fingerprint: 'ios' },
      realitySettings: { publicKey: 'PBK', shortId: 'ab', spiderX: '/s' },
      ...over,
    }) as unknown as ServerConfig;

  it('tls → REALITY 块（toEqual 精确形状；spiderX 为 Xray 独有不下发）', () => {
    const ob = buildProxyOutbound(trojanReality(), tags, DR_V6_ON);
    expect(ob.type).toBe('trojan');
    expect(ob.password).toBe('pw');
    expect(ob.tls).toEqual({
      enabled: true,
      server_name: 'www.microsoft.com',
      insecure: false,
      utls: { enabled: true, fingerprint: 'ios' },
      reality: { enabled: true, public_key: 'PBK', short_id: 'ab' },
    });
  });

  it("指纹 'none' / 缺省 → chrome（sing-box: unknown uTLS fingerprint: none）；gRPC 传输照常", () => {
    for (const fingerprint of ['none', undefined]) {
      const ob = buildProxyOutbound(
        trojanReality({
          network: 'grpc',
          grpcSettings: { serviceName: 'svc' },
          tlsSettings: { serverName: 'www.microsoft.com', fingerprint },
        }),
        tags,
        DR_SPEEDTEST
      );
      expect(ob.tls?.utls).toEqual({ enabled: true, fingerprint: 'chrome' });
      expect(ob.transport).toEqual({ type: 'grpc', service_name: 'svc' });
    }
  });
});

// B 组：节点表单新增的可选协议设置经 buildProxyOutbound 正确下发为 sing-box 字段。
// （tailscale exitNodeAllowLanAccess 属 endpoint 构造、依赖 electron stateDir，不在此单测，由类型检查 + 集成覆盖。）
describe('buildProxyOutbound — 可选协议设置下发（B 组编辑项）', () => {
  const tags = new Map<string, string>();
  const node = (over: Partial<ServerConfig>): ServerConfig =>
    ({
      id: 'n',
      name: 'N',
      address: 'node.example.com',
      port: 443,
      ...over,
    }) as unknown as ServerConfig;

  it('tuic：zeroRttHandshake/heartbeat → zero_rtt_handshake/heartbeat', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'tuic',
        uuid: 'u',
        password: 'p',
        tuicSettings: { udpRelayMode: 'native', zeroRttHandshake: true, heartbeat: '12s' },
      }),
      tags,
      DR_V6_OFF
    ) as any;
    expect(ob.zero_rtt_handshake).toBe(true);
    expect(ob.heartbeat).toBe('12s');
  });

  it('tuic：zeroRttHandshake=false 显式下发；heartbeat 空则省略', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'tuic',
        uuid: 'u',
        password: 'p',
        tuicSettings: { zeroRttHandshake: false },
      }),
      tags,
      DR_V6_ON
    ) as any;
    expect(ob.zero_rtt_handshake).toBe(false);
    expect(ob.heartbeat).toBeUndefined();
  });

  it('anytls：idle 三参数 → idle_session_*/min_idle_session（min=0 也下发）', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'anytls',
        password: 'p',
        security: 'tls',
        anyTlsSettings: {
          idleSessionCheckInterval: '30s',
          idleSessionTimeout: '60s',
          minIdleSession: 0,
        },
      }),
      tags,
      DR_SPEEDTEST
    ) as any;
    expect(ob.idle_session_check_interval).toBe('30s');
    expect(ob.idle_session_timeout).toBe('60s');
    expect(ob.min_idle_session).toBe(0);
  });

  // #86-122 复审硬化 #1：表单/导入可能录入裸毫秒整数（数字或纯数字串），原样下发会触发 sing-box
  // ParseDuration "missing unit" → 整代理 FATAL。经 normalizeDuration 补 ms 单位，证明裸整数不再致 FATAL。
  it('anytls：裸整数 idle（数字 5000 / 字符串 "8000"）→ 归一化补 ms 单位（防 ParseDuration FATAL）', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'anytls',
        password: 'p',
        security: 'tls',
        anyTlsSettings: {
          idleSessionCheckInterval: 5000 as unknown as string, // 表单裸数字
          idleSessionTimeout: '8000', // 纯数字串
        },
      }),
      tags,
      DR_V6_OFF
    ) as any;
    expect(ob.idle_session_check_interval).toBe('5000ms');
    expect(ob.idle_session_timeout).toBe('8000ms');
  });

  it('tuic：裸整数 heartbeat（数字 10000）→ 归一化为 "10000ms"（防 ParseDuration FATAL）', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'tuic',
        uuid: 'u',
        password: 'p',
        tuicSettings: { heartbeat: 10000 as unknown as string },
      }),
      tags,
      DR_V6_ON
    ) as any;
    expect(ob.heartbeat).toBe('10000ms');
  });

  it('ssh：hostKeyAlgorithms/clientVersion → host_key_algorithms/client_version', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'ssh',
        port: 22,
        sshSettings: {
          user: 'root',
          hostKeyAlgorithms: ['ssh-ed25519', 'rsa-sha2-256'],
          clientVersion: 'SSH-2.0-OpenSSH_9.0',
        },
      }),
      tags,
      DR_SPEEDTEST
    ) as any;
    expect(ob.host_key_algorithms).toEqual(['ssh-ed25519', 'rsa-sha2-256']);
    expect(ob.client_version).toBe('SSH-2.0-OpenSSH_9.0');
  });

  // P3d：SSH cipher/mac/kex_algorithm。字段名以 sing-box check 实证为准（cipher/mac/kex_algorithm，
  // 非 ciphers/macs/key_exchange——后两者 sing-box decode FATAL "unknown field"）。
  it('ssh：cipher/mac/kexAlgorithm → cipher/mac/kex_algorithm（sing-box 实证字段名）', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'ssh',
        port: 22,
        sshSettings: {
          user: 'root',
          cipher: ['aes128-gcm@openssh.com', 'chacha20-poly1305@openssh.com'],
          mac: ['hmac-sha2-256'],
          kexAlgorithm: ['curve25519-sha256'],
        },
      }),
      tags,
      DR_V6_OFF
    ) as any;
    expect(ob.cipher).toEqual(['aes128-gcm@openssh.com', 'chacha20-poly1305@openssh.com']);
    expect(ob.mac).toEqual(['hmac-sha2-256']);
    expect(ob.kex_algorithm).toEqual(['curve25519-sha256']);
  });

  it('ssh：cipher/mac/kexAlgorithm 空数组不下发（向后兼容）', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'ssh',
        port: 22,
        sshSettings: { user: 'root', cipher: [], mac: [], kexAlgorithm: [] },
      }),
      tags,
      DR_V6_ON
    ) as any;
    expect(ob.cipher).toBeUndefined();
    expect(ob.mac).toBeUndefined();
    expect(ob.kex_algorithm).toBeUndefined();
  });

  // Snell（sing-box 1.14.0-alpha.38+ 官方 outbound）：version 主开关，obfs_*（v4）/mode（v6）互斥条件下发；
  // psk 复用 password；不走 TLS 块（不在 tlsProtocols）。
  it('snell v4 + obfs http：下发 obfs_mode/obfs_host（host 空回落 bing.com），不下发 mode/tls', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'snell',
        password: 'psk-secret',
        snellSettings: { version: 4, obfsMode: 'http' },
      }),
      tags,
      DR_SPEEDTEST
    ) as any;
    expect(ob.type).toBe('snell');
    expect(ob.version).toBe(4);
    expect(ob.psk).toBe('psk-secret');
    expect(ob.obfs_mode).toBe('http');
    expect(ob.obfs_host).toBe('bing.com');
    expect(ob.mode).toBeUndefined();
    expect(ob.tls).toBeUndefined();
  });

  it('snell v4 + obfs http + 显式 host → obfs_host 原样下发', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'snell',
        password: 'p',
        snellSettings: { version: 4, obfsMode: 'http', obfsHost: 'cdn.example.com' },
      }),
      tags,
      DR_V6_OFF
    ) as any;
    expect(ob.obfs_host).toBe('cdn.example.com');
  });

  it('snell v4 + obfs none/缺省 → 不下发 obfs_*', () => {
    const ob = buildProxyOutbound(
      node({ protocol: 'snell', password: 'p', snellSettings: { version: 4, obfsMode: 'none' } }),
      tags,
      DR_V6_ON
    ) as any;
    expect(ob.obfs_mode).toBeUndefined();
    expect(ob.obfs_host).toBeUndefined();
    const ob2 = buildProxyOutbound(
      node({ protocol: 'snell', password: 'p', snellSettings: { version: 4 } }),
      tags,
      DR_SPEEDTEST
    ) as any;
    expect(ob2.obfs_mode).toBeUndefined();
  });

  it('snell v6 default/缺省 → 不下发 mode；unsafe-raw → 下发；v6 忽略 obfs_*（脏字段防线）', () => {
    const ob = buildProxyOutbound(
      node({ protocol: 'snell', password: 'p', snellSettings: { version: 6, mode: 'default' } }),
      tags,
      DR_V6_OFF
    ) as any;
    expect(ob.version).toBe(6);
    expect(ob.mode).toBeUndefined();
    const raw = buildProxyOutbound(
      node({ protocol: 'snell', password: 'p', snellSettings: { version: 6, mode: 'unsafe-raw' } }),
      tags,
      DR_V6_ON
    ) as any;
    expect(raw.mode).toBe('unsafe-raw');
    // 脏数据（v6 却带 obfs 字段，手改/导入残留）→ 构建侧不下发 obfs_*
    const dirty = buildProxyOutbound(
      node({
        protocol: 'snell',
        password: 'p',
        snellSettings: { version: 6, obfsMode: 'http', obfsHost: 'x.com' } as any,
      }),
      tags,
      DR_SPEEDTEST
    ) as any;
    expect(dirty.obfs_mode).toBeUndefined();
    expect(dirty.obfs_host).toBeUndefined();
  });

  it('snell：reuse/network/userkey 条件下发（false/both/空 = 省略）', () => {
    const minimal = buildProxyOutbound(
      node({ protocol: 'snell', password: 'p', snellSettings: { version: 4 } }),
      tags,
      DR_V6_OFF
    ) as any;
    expect(minimal.reuse).toBeUndefined();
    expect(minimal.network).toBeUndefined();
    expect(minimal.userkey).toBeUndefined();
    const full = buildProxyOutbound(
      node({
        protocol: 'snell',
        password: 'p',
        snellSettings: { version: 4, reuse: true, network: 'tcp', userkey: 'uk' },
      }),
      tags,
      DR_V6_ON
    ) as any;
    expect(full.reuse).toBe(true);
    expect(full.network).toBe('tcp');
    expect(full.userkey).toBe('uk');
  });

  // P3b：Hysteria2 obfs（salamander/gecko）+ min/max_packet_size（仅 gecko）+ bbr_profile。
  it('hysteria2：salamander obfs → obfs.type=salamander，不下发 min/max_packet_size', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'hysteria2',
        password: 'pw',
        security: 'tls',
        hysteria2Settings: {
          obfs: { type: 'salamander', password: 'o', minPacketSize: 100, maxPacketSize: 1200 },
        },
      }),
      tags,
      DR_SPEEDTEST
    ) as any;
    expect(ob.obfs.type).toBe('salamander');
    expect(ob.obfs.password).toBe('o');
    // salamander 忽略包长字段：即便表单残留也不下发（避免无效字段）
    expect(ob.obfs.min_packet_size).toBeUndefined();
    expect(ob.obfs.max_packet_size).toBeUndefined();
  });

  it('hysteria2：gecko obfs → obfs.type=gecko + min/max_packet_size 下发', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'hysteria2',
        password: 'pw',
        security: 'tls',
        hysteria2Settings: {
          obfs: { type: 'gecko', password: 'o', minPacketSize: 100, maxPacketSize: 1200 },
        },
      }),
      tags,
      DR_V6_OFF
    ) as any;
    expect(ob.obfs.type).toBe('gecko');
    expect(ob.obfs.min_packet_size).toBe(100);
    expect(ob.obfs.max_packet_size).toBe(1200);
  });

  it('hysteria2：obfs 缺 password → 不下发整个 obfs（sing-box: missing obfs password）', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'hysteria2',
        password: 'pw',
        security: 'tls',
        hysteria2Settings: { obfs: { type: 'gecko' } },
      }),
      tags,
      DR_V6_ON
    ) as any;
    expect(ob.obfs).toBeUndefined();
  });

  it('hysteria2：bbrProfile → bbr_profile（standard/aggressive/conservative）', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'hysteria2',
        password: 'pw',
        security: 'tls',
        hysteria2Settings: { bbrProfile: 'aggressive' },
      }),
      tags,
      DR_SPEEDTEST
    ) as any;
    expect(ob.bbr_profile).toBe('aggressive');
  });

  it('hysteria2：未设 obfs/bbrProfile → 均不下发（向后兼容）', () => {
    const ob = buildProxyOutbound(
      node({ protocol: 'hysteria2', password: 'pw', security: 'tls', hysteria2Settings: {} }),
      tags,
      DR_V6_OFF
    ) as any;
    expect(ob.obfs).toBeUndefined();
    expect(ob.bbr_profile).toBeUndefined();
  });

  /**
   * disable_chrome_parrot（sing-box 1.14）：上游默认 false = Chrome QUIC 指纹拟态**开启**。
   * 三态必须分清——「显式 false」与「缺省」都应**省略**该键而非下发 `false`：
   * 省略即跟随上游默认，抗指纹白拿；写死 false 会在上游改默认/改语义时把 FlowZ 钉在旧行为上。
   * 只有显式 true（用户为 Ed25519 证书服务端开的逃生门）才下发。
   */
  it('hysteria2：disableChromeParrot=true → 下发 disable_chrome_parrot（Ed25519 证书逃生门）', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'hysteria2',
        password: 'pw',
        security: 'tls',
        hysteria2Settings: { disableChromeParrot: true },
      }),
      tags,
      DR_SPEEDTEST
    ) as any;
    expect(ob.disable_chrome_parrot).toBe(true);
  });

  it('hysteria2：disableChromeParrot 显式 false / 缺省 → 均省略该键（跟随上游默认，不写死）', () => {
    for (const settings of [{ disableChromeParrot: false }, {}] as const) {
      const ob = buildProxyOutbound(
        node({
          protocol: 'hysteria2',
          password: 'pw',
          security: 'tls',
          hysteria2Settings: settings,
        }),
        tags,
        DR_V6_OFF
      ) as any;
      expect(ob).not.toHaveProperty('disable_chrome_parrot');
    }
  });

  // P3c：TLS engine。仅对 TCP-TLS 协议下发；'go'/空省略；Hy2/TUIC（QUIC）即便设了也不下发。
  it('tls engine：trojan engine=windows 在 win32 → tls.engine=windows；非 win32 → 降级省略', () => {
    const orig = process.platform;
    const make = () =>
      buildProxyOutbound(
        node({
          protocol: 'trojan',
          password: 'pw',
          security: 'tls',
          tlsSettings: { serverName: 'a.com', engine: 'windows' },
        }),
        tags,
        DR_V6_ON
      ) as any;
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      expect(make().tls.engine).toBe('windows');
      // 跨平台导入降级：windows 引擎带到 linux/darwin → 落核心默认 Go 栈（不下发），免核 FATAL
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      expect(make().tls.engine).toBeUndefined();
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true });
    }
  });

  it('tls engine：engine=go 或未设 → 省略（用核心默认 Go TLS）', () => {
    const goOb = buildProxyOutbound(
      node({
        protocol: 'trojan',
        password: 'pw',
        security: 'tls',
        tlsSettings: { serverName: 'a.com', engine: 'go' },
      }),
      tags,
      DR_SPEEDTEST
    ) as any;
    expect(goOb.tls.engine).toBeUndefined();
    const noneOb = buildProxyOutbound(
      node({
        protocol: 'trojan',
        password: 'pw',
        security: 'tls',
        tlsSettings: { serverName: 'a.com' },
      }),
      tags,
      DR_V6_OFF
    ) as any;
    expect(noneOb.tls.engine).toBeUndefined();
  });

  it('tls engine：hysteria2(QUIC) 即便设 engine 也不下发（QUIC 自带 TLS1.3）', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'hysteria2',
        password: 'pw',
        security: 'tls',
        tlsSettings: { serverName: 'a.com', engine: 'apple' },
      }),
      tags,
      DR_V6_ON
    ) as any;
    expect(ob.tls?.engine).toBeUndefined();
  });

  it('未设置这些可选项 → 不下发（向后兼容）', () => {
    const tuic = buildProxyOutbound(
      node({ protocol: 'tuic', uuid: 'u', password: 'p', tuicSettings: {} }),
      tags,
      DR_SPEEDTEST
    ) as any;
    expect(tuic.zero_rtt_handshake).toBeUndefined();
    expect(tuic.heartbeat).toBeUndefined();
    const ssh = buildProxyOutbound(
      node({ protocol: 'ssh', port: 22, sshSettings: { user: 'root' } }),
      tags,
      DR_V6_OFF
    ) as any;
    expect(ssh.host_key_algorithms).toBeUndefined();
    expect(ssh.client_version).toBeUndefined();
    const anytls = buildProxyOutbound(
      node({ protocol: 'anytls', password: 'p', security: 'tls', anyTlsSettings: {} }),
      tags,
      DR_V6_ON
    ) as any;
    expect(anytls.idle_session_check_interval).toBeUndefined();
    expect(anytls.min_idle_session).toBeUndefined();
  });
});

// H2(http)/gRPC 传输：generateTransportConfig 之前漏 http 分支 → network=http 静默降级裸 TCP（表单 + 导入两路皆坏）。
// 此处锁 http 分支生成真 http 传输、grpc 照常、tcp 无 transport。
describe('buildProxyOutbound — http(H2)/gRPC 传输生成', () => {
  const tags = new Map<string, string>();
  const node = (over: Partial<ServerConfig>): ServerConfig =>
    ({
      id: 'n',
      name: 'N',
      address: 'node.example.com',
      port: 443,
      ...over,
    }) as unknown as ServerConfig;

  it('http(H2)：httpSettings → transport {type:http, host[], path}', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'vless',
        uuid: 'u',
        security: 'tls',
        network: 'http',
        httpSettings: { path: '/h2', host: ['a.com', 'b.com'] },
      }),
      tags,
      DR_SPEEDTEST
    );
    expect(ob.transport).toEqual({ type: 'http', host: ['a.com', 'b.com'], path: '/h2' });
  });

  it('http 无 httpSettings：仍生成 http 传输（path 默认 /），不回退裸 TCP', () => {
    const ob = buildProxyOutbound(
      node({ protocol: 'vless', uuid: 'u', security: 'tls', network: 'http' }),
      tags,
      DR_V6_OFF
    );
    expect(ob.transport?.type).toBe('http');
    expect(ob.transport?.path).toBe('/');
  });

  it('grpc：grpcSettings → transport {type:grpc, service_name}', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'trojan',
        password: 'p',
        security: 'tls',
        network: 'grpc',
        grpcSettings: { serviceName: 'GunSvc' },
      }),
      tags,
      DR_V6_ON
    );
    expect(ob.transport).toEqual({ type: 'grpc', service_name: 'GunSvc' });
  });

  it('network=tcp：无 transport', () => {
    const ob = buildProxyOutbound(
      node({ protocol: 'vless', uuid: 'u', security: 'tls', network: 'tcp' }),
      tags,
      DR_SPEEDTEST
    );
    expect(ob.transport).toBeUndefined();
  });

  it("legacy 'h2'（旧表单遗留 network 值）→ 兼容生成 http 传输（非裸 TCP）", () => {
    const ob = buildProxyOutbound(
      {
        id: 'n',
        name: 'N',
        address: 'node.example.com',
        port: 443,
        protocol: 'vless',
        uuid: 'u',
        security: 'tls',
        network: 'h2',
      } as unknown as ServerConfig,
      tags,
      DR_V6_OFF
    );
    expect(ob.transport?.type).toBe('http');
  });
});

// buildTailscaleEndpoint — P4a 新字段（advertise_tags / ssh_server / relay_server_port）。
// schema 经 resources/linux/sing-box check（1.14-alpha.32）实证：
//  advertise_tags=Listable[string]；ssh_server=badoption(bool|{enabled})，FlowZ 以 bool 下发；
//  relay_server_port=int（唯一 relay_server_* 字段，无 relay_server 开关）。
const tsServer = (over: Partial<ServerConfig> = {}): ServerConfig =>
  ({
    id: 'ts1',
    name: 'TS',
    protocol: 'tailscale',
    tailscaleSettings: {},
    ...over,
  }) as unknown as ServerConfig;

describe('buildTailscaleEndpoint — P4a 新字段', () => {
  it('基础 endpoint：type/tag/state_directory，无可选字段时不下发 P4a 字段', () => {
    const ep = buildTailscaleEndpoint(tsServer(), 'TS');
    expect(ep.type).toBe('tailscale');
    expect(ep.tag).toBe('TS');
    expect(ep.state_directory).toContain('ts1');
    expect(ep.advertise_tags).toBeUndefined();
    expect(ep.ssh_server).toBeUndefined();
    expect(ep.relay_server_port).toBeUndefined();
  });

  it('advertise_tags：过滤空白后下发数组；全空 → 不下发', () => {
    const ep = buildTailscaleEndpoint(
      tsServer({ tailscaleSettings: { advertiseTags: [' tag:server ', '', 'tag:exit'] } }),
      'TS'
    );
    expect(ep.advertise_tags).toEqual(['tag:server', 'tag:exit']);

    const empty = buildTailscaleEndpoint(
      tsServer({ tailscaleSettings: { advertiseTags: ['', '  '] } }),
      'TS'
    );
    expect(empty.advertise_tags).toBeUndefined();
  });

  it('ssh_server：true → ssh_server:true（bool 形式）；false/缺省 → 不下发', () => {
    expect(
      buildTailscaleEndpoint(tsServer({ tailscaleSettings: { sshServer: true } }), 'TS').ssh_server
    ).toBe(true);
    expect(
      buildTailscaleEndpoint(tsServer({ tailscaleSettings: { sshServer: false } }), 'TS').ssh_server
    ).toBeUndefined();
  });

  it('relay_server_port：正整数下发；0 / 负数 / 非数字 → 不下发', () => {
    expect(
      buildTailscaleEndpoint(tsServer({ tailscaleSettings: { relayServerPort: 8080 } }), 'TS')
        .relay_server_port
    ).toBe(8080);
    expect(
      buildTailscaleEndpoint(tsServer({ tailscaleSettings: { relayServerPort: 0 } }), 'TS')
        .relay_server_port
    ).toBeUndefined();
    expect(
      buildTailscaleEndpoint(tsServer({ tailscaleSettings: { relayServerPort: -1 } }), 'TS')
        .relay_server_port
    ).toBeUndefined();
  });
});

// P3a：outbound TLS spoof（sing-box 1.14 tls.spoof/spoof_method，抗审查）。
// spoofMethod + spoofSni（诱饵 SNI，须不同于真 server_name）成对启用 → tls.spoof=spoofSni + tls.spoof_method。
// 五重门控：arch(非 ARM64) + 协议(TCP-TLS) + 诱饵 SNI 非空 + 非 IP 字面量 + 不同于真 server_name + 方法合法。
// 本机 process.arch=x64（支持），ARM64 路径单独 mock process.arch 验证。
describe('buildProxyOutbound — TLS spoof（P3a 抗审查）', () => {
  // CI 修复：spoof 门控读 process.arch（ARM64 不支持，内核仅 amd64 实现）。正向用例统一 mock x64，使其与 CI runner
  // 实际 arch 无关（macOS runner = arm64，否则正向用例误判失败）；下方 ARM64 负向用例在体内自 mock arm64 再还原。
  const REAL_ARCH = process.arch;
  beforeAll(() => Object.defineProperty(process, 'arch', { value: 'x64', configurable: true }));
  afterAll(() => Object.defineProperty(process, 'arch', { value: REAL_ARCH, configurable: true }));
  const tags = new Map<string, string>();
  const node = (over: Partial<ServerConfig>): ServerConfig =>
    ({ id: 'n', name: 'N', address: 'node.example.com', port: 443, ...over }) as ServerConfig;

  it('诱饵 SNI（不同于真 SNI）+ 合法方法 → tls.spoof=诱饵 + tls.spoof_method（trojan）', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'trojan',
        password: 'pw',
        security: 'tls',
        tlsSettings: {
          serverName: 'real.example.com',
          spoofSni: 'decoy.microsoft.com',
          spoofMethod: 'wrong-ack',
        },
      }),
      tags,
      DR_V6_ON
    ) as any;
    expect(ob.tls.server_name).toBe('real.example.com');
    expect(ob.tls.spoof).toBe('decoy.microsoft.com'); // 诱饵，非真 SNI
    expect(ob.tls.spoof_method).toBe('wrong-ack');
  });

  it('诱饵 SNI == 真 server_name → 不下发（内核 FATAL `spoof must differ from server_name`）', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'vless',
        uuid: 'u',
        security: 'tls',
        tlsSettings: {
          serverName: 'same.example.com',
          spoofSni: 'same.example.com',
          spoofMethod: 'wrong-timestamp',
        },
      }),
      tags,
      DR_SPEEDTEST
    ) as any;
    expect(ob.tls.spoof).toBeUndefined();
    expect(ob.tls.spoof_method).toBeUndefined();
  });

  it('诱饵 SNI 为 IP 字面量 → 不下发（内核拒 `spoof requires TLS ClientHello with SNI`）', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'trojan',
        password: 'pw',
        security: 'tls',
        tlsSettings: {
          serverName: 'real.example.com',
          spoofSni: '203.0.113.9',
          spoofMethod: 'wrong-ack',
        },
      }),
      tags,
      DR_V6_OFF
    ) as any;
    expect(ob.tls.spoof).toBeUndefined();
    expect(ob.tls.spoof_method).toBeUndefined();
  });

  it('真 server_name 为 IP 字面量（address=IP 且未填 serverName）→ 不下发（内核 init FATAL `spoof requires TLS ClientHello with SNI`）', () => {
    const ob = buildProxyOutbound(
      node({
        address: '198.51.100.7', // IP 节点 + 未填 serverName → server_name 回退为 IP
        protocol: 'trojan',
        password: 'pw',
        security: 'tls',
        tlsSettings: {
          spoofSni: 'decoy.microsoft.com', // 诱饵合法（域名、非空、异于真 SNI）
          spoofMethod: 'wrong-ack',
        },
      }),
      tags,
      DR_V6_ON
    ) as any;
    expect(ob.tls.server_name).toBe('198.51.100.7'); // 回退为 IP 字面量
    expect(ob.tls.spoof).toBeUndefined();
    expect(ob.tls.spoof_method).toBeUndefined();
  });

  it('IP 节点但显式填了域名 serverName → 真 server_name 是域名 → 正常下发 spoof', () => {
    const ob = buildProxyOutbound(
      node({
        address: '198.51.100.7',
        protocol: 'trojan',
        password: 'pw',
        security: 'tls',
        tlsSettings: {
          serverName: 'real.example.com', // 显式域名 → 真握手有 SNI
          spoofSni: 'decoy.microsoft.com',
          spoofMethod: 'wrong-ack',
        },
      }),
      tags,
      DR_SPEEDTEST
    ) as any;
    expect(ob.tls.server_name).toBe('real.example.com');
    expect(ob.tls.spoof).toBe('decoy.microsoft.com');
    expect(ob.tls.spoof_method).toBe('wrong-ack');
  });

  it('有方法但诱饵 SNI 留空 → 不下发（成对才生效）', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'trojan',
        password: 'pw',
        security: 'tls',
        tlsSettings: { serverName: 'real.example.com', spoofMethod: 'wrong-ack' },
      }),
      tags,
      DR_V6_OFF
    ) as any;
    expect(ob.tls.spoof).toBeUndefined();
    expect(ob.tls.spoof_method).toBeUndefined();
  });

  it('hysteria2(QUIC) 即便成对设置也不下发（无 TCP ClientHello）', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'hysteria2',
        password: 'pw',
        security: 'tls',
        tlsSettings: {
          serverName: 'a.com',
          spoofSni: 'decoy.microsoft.com',
          spoofMethod: 'wrong-ack',
        },
      }),
      tags,
      DR_V6_ON
    ) as any;
    expect(ob.tls?.spoof).toBeUndefined();
    expect(ob.tls?.spoof_method).toBeUndefined();
  });

  it('未设 spoofMethod → 不下发（向后兼容）', () => {
    const ob = buildProxyOutbound(
      node({
        protocol: 'trojan',
        password: 'pw',
        security: 'tls',
        tlsSettings: { serverName: 'a.com' },
      }),
      tags,
      DR_SPEEDTEST
    ) as any;
    expect(ob.tls.spoof).toBeUndefined();
    expect(ob.tls.spoof_method).toBeUndefined();
  });

  it('ARM64（mock process.arch=arm64）→ 不下发 spoof（内核仅 amd64 实现）', () => {
    const orig = process.arch;
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
    try {
      const ob = buildProxyOutbound(
        node({
          protocol: 'trojan',
          password: 'pw',
          security: 'tls',
          tlsSettings: {
            serverName: 'real.example.com',
            spoofSni: 'decoy.microsoft.com',
            spoofMethod: 'wrong-ack',
          },
        }),
        tags,
        DR_V6_OFF
      ) as any;
      expect(ob.tls.spoof).toBeUndefined();
      expect(ob.tls.spoof_method).toBeUndefined();
    } finally {
      Object.defineProperty(process, 'arch', { value: orig, configurable: true });
    }
  });
});

describe('shouldEmitTlsEngine — TLS 引擎平台门控（跨平台导入降级）', () => {
  const platforms: NodeJS.Platform[] = ['win32', 'darwin', 'linux'];

  it('windows(Schannel) 仅 win32 下发', () => {
    expect(shouldEmitTlsEngine('windows', 'win32')).toBe(true);
    expect(shouldEmitTlsEngine('windows', 'darwin')).toBe(false);
    expect(shouldEmitTlsEngine('windows', 'linux')).toBe(false);
  });

  it('apple(Network.framework) 仅 darwin 下发', () => {
    expect(shouldEmitTlsEngine('apple', 'darwin')).toBe(true);
    expect(shouldEmitTlsEngine('apple', 'win32')).toBe(false);
    expect(shouldEmitTlsEngine('apple', 'linux')).toBe(false);
  });

  it('go / 空 / undefined / 未知引擎一律不下发（落核心默认 Go 栈）', () => {
    for (const p of platforms) {
      expect(shouldEmitTlsEngine('go', p)).toBe(false);
      expect(shouldEmitTlsEngine('', p)).toBe(false);
      expect(shouldEmitTlsEngine(undefined, p)).toBe(false);
      expect(shouldEmitTlsEngine('bogus', p)).toBe(false);
    }
  });

  it('跨平台导入降级回归点：apple 导入非 darwin、windows 导入非 win32 均不下发（免核 FATAL）', () => {
    expect(shouldEmitTlsEngine('apple', 'win32')).toBe(false);
    expect(shouldEmitTlsEngine('apple', 'linux')).toBe(false);
    expect(shouldEmitTlsEngine('windows', 'darwin')).toBe(false);
    expect(shouldEmitTlsEngine('windows', 'linux')).toBe(false);
  });
});
