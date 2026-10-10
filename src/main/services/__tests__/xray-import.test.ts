/**
 * xray-import 单测（node env，零 electron）。覆盖 vmess/vless/trojan/shadowsocks 映射 +
 * streamSettings(tls/reality/ws/grpc) + 不支持协议跳过 + 内部协议忽略 + 缺字段失败；
 * parseXrayJson 三形态（单份配置 / v2ray-json 配置数组 / 裸 outbound 数组）+ remarks 命名 + 链式作用域；
 * direct/block 协议别名按内部 outbound 忽略、TCP/RAW HTTP 伪装头透传、SS 套传输 / TLS 与无 TLS trojan 透传、
 * 无 remarks 配置数组按地址命名、混入 sing-box `type` 条目不判为 Xray；透传节点对账身份的传输名归一
 *（唯一一个对账用例隔离加载 SubscriptionService 并 mock electron，其余零 electron）。
 */
import {
  looksLikeXrayOutbounds,
  parseXrayJson,
  parseXrayOutbounds,
  xrayOutboundIdentity,
} from '../xray-import';

const NOW = '2026-06-30T00:00:00.000Z';

describe('parseXrayOutbounds', () => {
  it('vmess + ws + tls → ServerConfig', () => {
    const r = parseXrayOutbounds(
      [
        {
          protocol: 'vmess',
          tag: 'vm1',
          settings: {
            vnext: [
              {
                address: '1.2.3.4',
                port: 443,
                users: [{ id: 'uuid-1', alterId: 2, security: 'auto' }],
              },
            ],
          },
          streamSettings: {
            network: 'ws',
            security: 'tls',
            wsSettings: { path: '/p', headers: { Host: 'h.com' } },
            tlsSettings: { serverName: 'h.com', fingerprint: 'chrome' },
          },
        },
      ],
      NOW
    );
    expect(r.servers).toHaveLength(1);
    const s = r.servers[0];
    expect(s.protocol).toBe('vmess');
    expect(s.address).toBe('1.2.3.4');
    expect(s.port).toBe(443);
    expect(s.uuid).toBe('uuid-1');
    expect(s.alterId).toBe(2);
    expect(s.network).toBe('ws');
    expect(s.security).toBe('tls');
    expect(s.wsSettings?.path).toBe('/p');
    expect(s.wsSettings?.headers?.Host).toBe('h.com');
    expect(s.tlsSettings?.serverName).toBe('h.com');
  });

  it('vless + reality + grpc → flow + realitySettings + grpc', () => {
    const r = parseXrayOutbounds(
      [
        {
          protocol: 'vless',
          tag: 'vl1',
          settings: {
            vnext: [
              {
                address: '5.6.7.8',
                port: 8443,
                users: [{ id: 'uuid-2', flow: 'xtls-rprx-vision' }],
              },
            ],
          },
          streamSettings: {
            network: 'grpc',
            security: 'reality',
            grpcSettings: { serviceName: 'grpc-svc' },
            realitySettings: { publicKey: 'pk', shortId: 'sid', serverName: 'sni.com' },
          },
        },
      ],
      NOW
    );
    expect(r.servers).toHaveLength(1);
    const s = r.servers[0];
    expect(s.protocol).toBe('vless');
    expect(s.uuid).toBe('uuid-2');
    expect(s.flow).toBe('xtls-rprx-vision');
    expect(s.network).toBe('grpc');
    expect(s.grpcSettings?.serviceName).toBe('grpc-svc');
    expect(s.security).toBe('reality');
    expect(s.realitySettings?.publicKey).toBe('pk');
    expect(s.realitySettings?.shortId).toBe('sid');
  });

  it('trojan + shadowsocks 映射凭据', () => {
    const r = parseXrayOutbounds(
      [
        {
          protocol: 'trojan',
          tag: 't1',
          settings: { servers: [{ address: 'a.com', port: 443, password: 'pw' }] },
          streamSettings: { security: 'tls', tlsSettings: { serverName: 'a.com' } },
        },
        {
          protocol: 'shadowsocks',
          tag: 'ss1',
          settings: {
            servers: [{ address: 'b.com', port: 8388, method: 'aes-256-gcm', password: 'sspw' }],
          },
        },
      ],
      NOW
    );
    expect(r.servers).toHaveLength(2);
    const trojan = r.servers.find((s) => s.protocol === 'trojan')!;
    expect(trojan.password).toBe('pw');
    expect(trojan.security).toBe('tls');
    const ss = r.servers.find((s) => s.protocol === 'shadowsocks')!;
    expect(ss.shadowsocksSettings?.method).toBe('aes-256-gcm');
    expect(ss.shadowsocksSettings?.password).toBe('sspw');
  });

  it('sing-box 表达不了的 SS / trojan 组合 → 原样透传（SS 套 ws / grpc / tls、trojan 无 TLS）；SS 裸 TCP 与 trojan+TLS 仍结构化', () => {
    const ssOb = (stream?: Record<string, unknown>) => ({
      protocol: 'shadowsocks',
      settings: {
        servers: [{ address: 'ss.com', port: 8388, method: 'aes-256-gcm', password: 'p' }],
      },
      ...(stream ? { streamSettings: stream } : {}),
    });
    const trojanOb = (stream?: Record<string, unknown>) => ({
      protocol: 'trojan',
      settings: { servers: [{ address: 'tj.com', port: 80, password: 'p' }] },
      ...(stream ? { streamSettings: stream } : {}),
    });
    const ssWs = { network: 'ws', wsSettings: { path: '/ss', host: 'cdn.com' } };
    const ssGrpcTls = {
      network: 'grpc',
      security: 'tls',
      grpcSettings: { serviceName: 'svc' },
      tlsSettings: { serverName: 'ss.com' },
    };
    const ssTcpTls = { network: 'tcp', security: 'tls', tlsSettings: { serverName: 'ss.com' } };
    const trojanWsPlain = { network: 'ws', security: 'none', wsSettings: { path: '/tj' } };
    const r = parseXrayOutbounds(
      [
        ssOb(ssWs),
        ssOb(ssGrpcTls),
        ssOb(ssTcpTls),
        trojanOb(trojanWsPlain),
        trojanOb(), // 无 streamSettings = 明文 trojan（Xray 语义）
        ssOb(),
        ssOb({ network: 'raw', security: 'none' }),
        trojanOb({ network: 'ws', security: 'tls', wsSettings: { path: '/t' } }),
      ],
      NOW
    );
    expect(r.servers.map((s) => s.protocol)).toEqual([
      'custom',
      'custom',
      'custom',
      'custom',
      'custom',
      'shadowsocks',
      'shadowsocks',
      'trojan',
    ]);
    // 透传：streamSettings 原样保留，由 Xray 内核运行（不再落成 sing-box 拒收 / 被偷偷改成 TLS 的结构化节点）
    for (const [i, stream] of [ssWs, ssGrpcTls, ssTcpTls, trojanWsPlain].entries()) {
      expect(r.servers[i].customSettings?.engine).toBe('xray');
      expect(r.servers[i].customSettings?.outbound).toMatchObject({ streamSettings: stream });
    }
    expect(r.servers[4].customSettings?.outbound).not.toHaveProperty('streamSettings');
    expect(r.servers[0].name).toBe('shadowsocks ss.com:8388');
    expect(r.servers[3]).toMatchObject({ address: 'tj.com', port: 80 });
    expect(r.servers[6]).toMatchObject({ network: 'tcp', security: 'none' });
    expect(r.servers[7]).toMatchObject({ network: 'ws', security: 'tls' });
    expect(r.warnings).toContain(
      '5 个节点以「自定义 Xray JSON」原样导入，由 Xray 内核运行: SS ws(1), SS grpc+tls(1), SS tcp+tls(1), trojan 无 TLS(2)'
    );
  });

  it('非结构化协议原样透传为自定义 Xray 节点；内部协议(freedom/blackhole 及别名 direct/block) 忽略不计', () => {
    const r = parseXrayOutbounds(
      [
        { protocol: 'socks', tag: 's', settings: { servers: [{ address: 'x', port: 1 }] } },
        { protocol: 'freedom', tag: 'direct' },
        { protocol: 'blackhole', tag: 'block' },
        { protocol: 'direct', tag: 'direct2' },
        { protocol: 'Block', tag: 'block2' },
      ],
      NOW
    );
    expect(r.servers).toHaveLength(1);
    expect(r.skipped).toBe(0);
    const c = r.servers[0];
    expect(c.protocol).toBe('custom');
    expect(c.customSettings?.engine).toBe('xray');
    expect(c.customSettings?.outbound).toEqual({
      protocol: 'socks',
      settings: { servers: [{ address: 'x', port: 1 }] },
    });
    expect(c.address).toBe('x');
    expect(c.port).toBe(1);
    expect(r.warnings.join('')).toMatch(/自定义 Xray JSON/);
  });

  it('VLESS + XHTTP + REALITY + ENC → 结构化 xhttp 节点（encryption / spiderX / pqv / extra 全保留）', () => {
    const r = parseXrayOutbounds(
      [
        {
          protocol: 'vless',
          tag: 'xh',
          settings: {
            vnext: [
              {
                address: 'x.com',
                port: 443,
                users: [{ id: 'u', encryption: 'mlkem768x25519plus.native.0rtt.k' }],
              },
            ],
          },
          streamSettings: {
            network: 'xhttp',
            security: 'reality',
            xhttpSettings: {
              path: '/p',
              host: 'h',
              mode: 'stream-one',
              extra: { noGRPCHeader: true },
            },
            realitySettings: {
              serverName: 'sni',
              password: 'pbk',
              shortId: 'ab',
              spiderX: '/s',
              mldsa65Verify: 'pq',
            },
          },
        },
      ],
      NOW
    );
    const s = r.servers[0];
    expect(s.protocol).toBe('vless');
    expect(s.encryption).toBe('mlkem768x25519plus.native.0rtt.k');
    expect(s.network).toBe('xhttp');
    expect(s.xhttpSettings).toEqual({
      path: '/p',
      host: 'h',
      mode: 'stream-one',
      extra: { noGRPCHeader: true },
    });
    expect(s.realitySettings).toEqual({
      publicKey: 'pbk',
      shortId: 'ab',
      spiderX: '/s',
      mldsa65Verify: 'pq',
    });
  });

  it('mKCP / finalmask / mux / sockopt → 原样透传（结构化会丢语义）；仅 dialerProxy 的 sockopt 仍结构化', () => {
    const vless = (stream: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      protocol: 'vless',
      settings: { vnext: [{ address: 'a', port: 1, users: [{ id: 'u' }] }] },
      streamSettings: stream,
      ...extra,
    });
    const r = parseXrayOutbounds(
      [
        vless({ network: 'kcp' }),
        vless({ network: 'raw', finalmask: { udp: [] } }),
        vless({ network: 'raw' }, { mux: { enabled: true } }),
        vless({ network: 'raw', sockopt: { tcpFastOpen: true } }),
        vless({ network: 'raw', sockopt: { dialerProxy: 'chain' } }),
      ],
      NOW
    );
    expect(r.servers.map((s) => s.protocol)).toEqual([
      'custom',
      'custom',
      'custom',
      'custom',
      'vless',
    ]);
  });

  it('TCP/RAW HTTP 伪装头（tcpSettings / rawSettings.header.type=http）→ 原样透传，伪装头不丢；type=none 仍结构化', () => {
    const header = {
      type: 'http',
      request: { path: ['/'], headers: { Host: ['www.bing.com'] } },
    };
    const vmess = (stream: Record<string, unknown>) => ({
      tag: 'vm',
      protocol: 'vmess',
      settings: {
        vnext: [{ address: 'a.com', port: 80, users: [{ id: 'u', security: 'auto' }] }],
      },
      streamSettings: stream,
    });
    const r = parseXrayOutbounds(
      [
        vmess({ network: 'tcp', tcpSettings: { header } }),
        vmess({ network: 'raw', rawSettings: { header: { type: 'HTTP' } } }),
        vmess({ tcpSettings: { header }, sockopt: { dialerProxy: 'x' } }), // network 缺省 = tcp
        vmess({ network: 'tcp', tcpSettings: { header: { type: 'none' } } }),
        vmess({ network: 'raw', rawSettings: {} }),
      ],
      NOW
    );
    expect(r.servers.map((s) => s.protocol)).toEqual([
      'custom',
      'custom',
      'custom',
      'vmess',
      'vmess',
    ]);
    const c = r.servers[0];
    expect(c.customSettings?.engine).toBe('xray');
    expect(c.customSettings?.outbound).toMatchObject({
      protocol: 'vmess',
      streamSettings: { network: 'tcp', tcpSettings: { header } },
    });
    expect(JSON.stringify(c)).toContain('www.bing.com');
    expect(r.warnings).toContain(
      '3 个节点以「自定义 Xray JSON」原样导入，由 Xray 内核运行: TCP 伪装头 http(3)'
    );
  });

  it('XHTTP 顶层高级项（无 extra）→ 收进 extra，零语义丢失；path/host/mode 仍为结构化字段', () => {
    const xhttpSettings = {
      path: '/p',
      host: 'cdn.example.com',
      mode: 'auto',
      xPaddingBytes: '1000-2000',
      headers: { 'X-A': 'b' },
      xmux: { maxConcurrency: '16-32' },
      downloadSettings: {
        address: 'dl.example.com',
        port: 443,
        network: 'xhttp',
        xhttpSettings: { path: '/d' },
      },
    };
    const r = parseXrayOutbounds(
      [
        {
          protocol: 'vless',
          settings: { vnext: [{ address: 'a.com', port: 443, users: [{ id: 'u' }] }] },
          streamSettings: { network: 'xhttp', security: 'tls', xhttpSettings },
        },
      ],
      NOW
    );
    expect(r.servers[0].protocol).toBe('vless');
    expect(r.servers[0].xhttpSettings).toEqual({
      path: '/p',
      host: 'cdn.example.com',
      mode: 'auto',
      extra: {
        xPaddingBytes: '1000-2000',
        headers: { 'X-A': 'b' },
        xmux: { maxConcurrency: '16-32' },
        downloadSettings: xhttpSettings.downloadSettings,
      },
    });
  });

  it('XHTTP 有 extra → 以 extra 为准（Xray 语义：顶层其余键被忽略，不并入）', () => {
    const r = parseXrayOutbounds(
      [
        {
          protocol: 'vless',
          settings: { vnext: [{ address: 'a.com', port: 443, users: [{ id: 'u' }] }] },
          streamSettings: {
            network: 'xhttp',
            xhttpSettings: {
              path: '/p',
              xPaddingBytes: '1-2',
              extra: { xmux: { maxConcurrency: '4' } },
            },
          },
        },
      ],
      NOW
    );
    expect(r.servers[0].xhttpSettings?.extra).toEqual({ xmux: { maxConcurrency: '4' } });
  });

  it('链式代理（sockopt.dialerProxy / proxySettings.tag）→ detour 指向前置节点新 id（含前向引用、透传节点）', () => {
    const r = parseXrayOutbounds(
      [
        {
          protocol: 'vless',
          tag: 'exit',
          settings: { vnext: [{ address: 'e.com', port: 443, users: [{ id: 'u' }] }] },
          streamSettings: { network: 'raw', security: 'tls', sockopt: { dialerProxy: 'front' } },
        },
        {
          protocol: 'trojan',
          tag: 'exit2',
          settings: { servers: [{ address: 'e2.com', port: 443, password: 'p' }] },
          proxySettings: { tag: 'front' },
        },
        {
          protocol: 'wireguard',
          tag: 'warp',
          settings: {
            secretKey: 'k',
            peers: [{ publicKey: 'pk', endpoint: 'engage.example.com:2408' }],
          },
          streamSettings: { sockopt: { dialerProxy: 'front' } },
        },
        {
          protocol: 'shadowsocks',
          tag: 'front',
          settings: {
            servers: [{ address: 'f.com', port: 8388, method: 'aes-128-gcm', password: 'p' }],
          },
        },
      ],
      NOW
    );
    const byName = Object.fromEntries(r.servers.map((s) => [s.name, s]));
    const frontId = byName.front.id;
    expect(byName.exit.detour).toBe(frontId);
    expect(byName.exit2.detour).toBe(frontId);
    expect(byName.warp.protocol).toBe('custom');
    expect(byName.warp.detour).toBe(frontId);
    expect(byName.front.detour).toBeUndefined();
    expect(r.warnings.some((w) => w.includes('链式代理'))).toBe(false);
  });

  it('链式代理前置不可导入（freedom 分片 / 不存在 / 自引用）→ 不设 detour 并告警，不静默丢链', () => {
    const vless = (tag: string, dialerProxy: string) => ({
      protocol: 'vless',
      tag,
      settings: { vnext: [{ address: `${tag}.com`, port: 443, users: [{ id: 'u' }] }] },
      streamSettings: { network: 'raw', sockopt: { dialerProxy } },
    });
    const r = parseXrayOutbounds(
      [
        vless('a', 'fragment'),
        vless('b', 'missing'),
        vless('c', 'c'),
        { protocol: 'freedom', tag: 'fragment', settings: { fragment: { packets: 'tlshello' } } },
      ],
      NOW
    );
    expect(r.servers.map((s) => s.detour)).toEqual([undefined, undefined, undefined]);
    const chainWarnings = r.warnings.filter((w) => w.includes('链式代理'));
    expect(chainWarnings).toHaveLength(3);
    expect(chainWarnings[0]).toContain('「a」');
    expect(chainWarnings[0]).toContain('「fragment」');
    expect(chainWarnings[1]).toContain('「missing」');
  });

  it('Xray 25+ 扁平 settings（address/port/id 直接在 settings）', () => {
    const r = parseXrayOutbounds(
      [
        {
          protocol: 'vless',
          settings: { address: 'f.com', port: 8443, id: 'u', encryption: 'none' },
        },
      ],
      NOW
    );
    expect(r.servers[0]).toMatchObject({
      protocol: 'vless',
      address: 'f.com',
      port: 8443,
      uuid: 'u',
    });
  });

  it('缺必填字段 → failed，不产出节点', () => {
    const r = parseXrayOutbounds(
      [
        {
          protocol: 'vmess',
          tag: 'bad',
          settings: { vnext: [{ address: '1.1.1.1', port: 443, users: [{}] }] },
        },
      ],
      NOW
    );
    expect(r.servers).toHaveLength(0);
    expect(r.failed).toBe(1);
  });

  it('非数组 → 空结果', () => {
    const r = parseXrayOutbounds(undefined, NOW);
    expect(r.servers).toHaveLength(0);
    expect(r.skipped).toBe(0);
    expect(r.failed).toBe(0);
  });
});

// ── Xray JSON 文档（订阅 / 本地导入共用入口）：三形态 + remarks 命名 + 链式作用域 ──────────────────────────
describe('parseXrayJson', () => {
  const vless = (tag: string, host: string, extra: Record<string, unknown> = {}) => ({
    tag,
    protocol: 'vless',
    settings: { vnext: [{ address: host, port: 443, users: [{ id: `id-${host}` }] }] },
    streamSettings: { network: 'tcp', security: 'tls', tlsSettings: { serverName: host } },
    ...extra,
  });
  const internal = [
    { tag: 'direct', protocol: 'freedom' },
    { tag: 'block', protocol: 'blackhole' },
    { tag: 'dns-out', protocol: 'dns' },
  ];

  it('①单份配置 {outbounds}：等价 parseXrayOutbounds；顶层 remarks + 单节点 → 节点名 = remarks', () => {
    const r = parseXrayJson(
      { remarks: '东京 01', outbounds: [vless('proxy', 'a.com'), ...internal] },
      NOW
    )!;
    expect(r.shape).toBe('config');
    expect(r.configs).toBe(1);
    expect(r.servers).toHaveLength(1);
    expect(r.servers[0]).toMatchObject({ name: '东京 01', protocol: 'vless', address: 'a.com' });
    // 无 remarks → 沿用 tag 命名（与手动导入一致）
    const plain = parseXrayJson({ outbounds: [vless('proxy', 'a.com')] }, NOW)!;
    expect(plain.servers[0].name).toBe('proxy');
  });

  it('②配置数组（Marzban / 3x-ui v2ray-json）：每份一节点，名 = remarks；多节点配置 → "<remarks> · <tag>"', () => {
    const r = parseXrayJson(
      [
        {
          remarks: 'HK',
          log: {},
          inbounds: [],
          outbounds: [vless('proxy', 'hk.com'), ...internal],
        },
        { remarks: 'JP', outbounds: [vless('proxy', 'jp.com'), ...internal] },
        {
          remarks: 'US 中转',
          outbounds: [
            vless('proxy', 'us.com', { streamSettings: { sockopt: { dialerProxy: 'relay' } } }),
            vless('relay', 'relay.com'),
            ...internal,
          ],
        },
      ],
      NOW
    )!;
    expect(r.shape).toBe('config-list');
    expect(r.configs).toBe(3);
    expect(r.servers.map((s) => s.name)).toEqual([
      'HK',
      'JP',
      'US 中转 · proxy',
      'US 中转 · relay',
    ]);
    expect(r.skipped).toBe(0);
    expect(r.failed).toBe(0);
    expect(r.warnings).toEqual([]);
    const relay = r.servers[3];
    expect(r.servers[2].detour).toBe(relay.id);
  });

  it('②链式代理只在同一配置内解析：引用别的配置里的 tag → 不串链、告警', () => {
    const r = parseXrayJson(
      [
        { remarks: 'A', outbounds: [vless('front', 'front.com')] },
        {
          remarks: 'B',
          outbounds: [vless('exit', 'exit.com', { proxySettings: { tag: 'front' } })],
        },
        {
          remarks: 'C',
          outbounds: [
            vless('exit', 'c-exit.com', { proxySettings: { tag: 'front' } }),
            vless('front', 'c-front.com'),
          ],
        },
      ],
      NOW
    )!;
    const byName = Object.fromEntries(r.servers.map((s) => [s.name, s]));
    expect(byName.B.detour).toBeUndefined(); // A 的 front 不可见
    expect(byName['C · exit'].detour).toBe(byName['C · front'].id); // 同配置内同名 tag 正常解析
    expect(byName['C · exit'].detour).not.toBe(byName.A.id);
    expect(r.warnings).toEqual([
      '节点「B」的链式代理前置「front」不是已导入的节点，该链未保留（将直连服务器）',
    ]);
  });

  it('②多份配置共用同一断链前置（3x-ui fragment）→ 按前置聚合为一条告警；透传计数也只告警一次', () => {
    const cfg = (name: string) => ({
      remarks: name,
      outbounds: [
        vless('proxy', `${name}.com`, {
          streamSettings: {
            network: 'tcp',
            sockopt: { dialerProxy: 'fragment', tcpKeepAliveIdle: 100 },
          },
        }),
        { tag: 'fragment', protocol: 'freedom', settings: { fragment: { packets: 'tlshello' } } },
        ...internal,
      ],
    });
    const r = parseXrayJson(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'].map(cfg), NOW)!;
    expect(r.servers).toHaveLength(7);
    expect(r.servers.every((s) => s.protocol === 'custom' && !s.detour)).toBe(true);
    expect(r.servers.map((s) => s.name)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7']);
    const chain = r.warnings.filter((w) => w.includes('链式代理'));
    expect(chain).toHaveLength(1);
    expect(chain[0]).toContain('「fragment」');
    expect(chain[0]).toContain('等 7 个节点');
    const pass = r.warnings.filter((w) => w.includes('自定义 Xray JSON'));
    expect(pass).toEqual(['7 个节点以「自定义 Xray JSON」原样导入，由 Xray 内核运行: sockopt(7)']);
  });

  it('②内部 outbound 的协议别名 direct / block 忽略：单代理配置仍名 = remarks，无透传告警', () => {
    const r = parseXrayJson(
      [
        {
          remarks: 'DE-1',
          outbounds: [
            vless('proxy', 'de.com'),
            { tag: 'direct', protocol: 'direct' },
            { tag: 'block', protocol: 'block' },
          ],
        },
      ],
      NOW
    )!;
    expect(r.servers.map((s) => [s.name, s.protocol])).toEqual([['DE-1', 'vless']]);
    expect(r.warnings).toEqual([]);
  });

  it('②无 remarks 的配置数组：不按（各配置同名的）tag 命名，改按地址；同 host:port 仍撞名 → 追加 #配置序号', () => {
    const kcp = (id: string) => ({
      tag: 'proxy',
      protocol: 'vless',
      settings: { vnext: [{ address: 'kcp.com', port: 2053, users: [{ id }] }] },
      streamSettings: { network: 'kcp' },
    });
    const r = parseXrayJson(
      [
        { outbounds: [vless('proxy', 'a.com'), ...internal] },
        { remarks: '  ', outbounds: [vless('proxy', 'b.com'), ...internal] },
        {
          outbounds: [
            vless('proxy', 'c.com', { streamSettings: { sockopt: { dialerProxy: 'relay' } } }),
            vless('relay', 'relay.com'),
            vless('proxy2', 'd.com', { proxySettings: { tag: 'missing' } }),
          ],
        },
        { remarks: '有名', outbounds: [vless('proxy', 'e.com')] },
        { outbounds: [kcp('k1')] },
        { outbounds: [kcp('k2')] },
        { outbounds: [vless('proxy', 'a.com', { tag: 'proxy' })] }, // 与第 1 份同 host:port
      ],
      NOW
    )!;
    expect(r.shape).toBe('config-list');
    expect(r.servers.map((s) => s.name)).toEqual([
      'a.com:443 #1',
      'b.com:443',
      'c.com:443',
      'relay.com:443',
      'd.com:443',
      '有名',
      'vless kcp.com:2053 #5',
      'vless kcp.com:2053 #6',
      'a.com:443 #7',
    ]);
    expect(new Set(r.servers.map((s) => s.name)).size).toBe(r.servers.length);
    // 链式代理不受命名影响；告警引用定稿后的名字
    expect(r.servers[2].detour).toBe(r.servers[3].id);
    expect(r.warnings).toContain(
      '节点「d.com:443」的链式代理前置「missing」不是已导入的节点，该链未保留（将直连服务器）'
    );
  });

  it('②配置数组里的非配置条目（非对象 / 无 outbounds）计 skipped，不影响其它配置', () => {
    const r = parseXrayJson(
      [{ remarks: 'ok', outbounds: [vless('proxy', 'ok.com')] }, 'junk', null, { remarks: 'x' }],
      NOW
    )!;
    expect(r.servers.map((s) => s.name)).toEqual(['ok']);
    expect(r.skipped).toBe(3);
    expect(r.configs).toBe(1);
  });

  it('③裸 outbound 数组：整体视作一份配置（链在数组内解析，内部 outbound 忽略）', () => {
    const r = parseXrayJson(
      [
        vless('exit', 'exit.com', { streamSettings: { sockopt: { dialerProxy: 'hop' } } }),
        {
          tag: 'hop',
          protocol: 'trojan',
          settings: { servers: [{ address: 'hop.com', port: 443, password: 'pw' }] },
        },
        ...internal,
      ],
      NOW
    )!;
    expect(r.shape).toBe('outbound-list');
    expect(r.servers.map((s) => s.name)).toEqual(['exit', 'hop']);
    expect(r.servers[0].detour).toBe(r.servers[1].id);
  });

  it('非 Xray 形态 → null（sing-box type / Clash / 空数组 / 标量数组 / 原始类型），交调用方继续探测', () => {
    const singbox = {
      outbounds: [
        {
          type: 'vless',
          tag: 'v',
          server: 'a.com',
          server_port: 443,
          uuid: 'u',
          multiplex: { enabled: true, protocol: 'h2mux' },
        },
        { type: 'direct', tag: 'direct' },
      ],
    };
    expect(parseXrayJson(singbox, NOW)).toBeNull();
    expect(parseXrayJson(singbox.outbounds, NOW)).toBeNull();
    expect(parseXrayJson([singbox, singbox], NOW)).toBeNull();
    expect(parseXrayJson({ proxies: [{ name: 'x', type: 'vless' }] }, NOW)).toBeNull();
    expect(parseXrayJson({ outbounds: [] }, NOW)).toBeNull();
    expect(parseXrayJson([], NOW)).toBeNull();
    expect(parseXrayJson(['vless://x'], NOW)).toBeNull();
    expect(parseXrayJson('x', NOW)).toBeNull();
    expect(parseXrayJson(null, NOW)).toBeNull();
    // 同时带 type 与 protocol 的条目不算 Xray（与本地导入判据一致）
    expect(parseXrayJson({ outbounds: [{ type: 'vless', protocol: 'vless' }] }, NOW)).toBeNull();
  });

  it('looksLikeXrayOutbounds：protocol 无 type → true；任一条目带字符串 type（sing-box）→ false', () => {
    expect(looksLikeXrayOutbounds([{ protocol: 'freedom' }])).toBe(true);
    expect(looksLikeXrayOutbounds([{ protocol: 'vless' }, null, 'x', { tag: 't' }])).toBe(true);
    // 混入 sing-box `type` 条目 → 不是 Xray（防 sing-box 订阅里一条杂项 {protocol} 就整份被截走）
    expect(looksLikeXrayOutbounds([{ type: 'direct' }, { protocol: 'vless' }])).toBe(false);
    expect(looksLikeXrayOutbounds([{ type: 'vless' }])).toBe(false);
    expect(looksLikeXrayOutbounds({ protocol: 'vless' })).toBe(false);
    expect(
      parseXrayJson(
        {
          outbounds: [
            { type: 'vless', tag: 'n1', server: 'a.com', server_port: 443, uuid: 'u' },
            { type: 'direct' },
            { tag: 'weird', protocol: 'freedom' },
          ],
        },
        NOW
      )
    ).toBeNull();
  });
});

describe('xrayOutboundIdentity（透传节点对账身份）', () => {
  it('按落点取凭据 + 传输', () => {
    expect(
      xrayOutboundIdentity({
        protocol: 'VLESS',
        settings: { vnext: [{ address: 'a', port: 1, users: [{ id: 'u1' }] }] },
        streamSettings: { network: 'KCP' },
      })
    ).toEqual({ protocol: 'vless', cred: 'u1', network: 'kcp' });
    expect(
      xrayOutboundIdentity({
        protocol: 'trojan',
        settings: { servers: [{ address: 'a', port: 1, password: 'pw' }] },
      })
    ).toEqual({ protocol: 'trojan', cred: 'pw', network: 'tcp' });
    expect(
      xrayOutboundIdentity({
        protocol: 'socks',
        settings: { servers: [{ address: 'a', port: 1, users: [{ user: 'me', pass: 'pp' }] }] },
      }).cred
    ).toBe('pp');
    expect(
      xrayOutboundIdentity({ protocol: 'vless', settings: { address: 'a', port: 1, id: 'flat' } })
        .cred
    ).toBe('flat');
    expect(
      xrayOutboundIdentity({
        protocol: 'wireguard',
        settings: { secretKey: 'sk', peers: [{ publicKey: 'pk', endpoint: 'a:1' }] },
      }).cred
    ).toBe('pk');
    expect(
      xrayOutboundIdentity({
        protocol: 'hysteria',
        settings: { version: 2, address: 'a', port: 1 },
        streamSettings: { network: 'hysteria', hysteriaSettings: { auth: 'hy' } },
      })
    ).toEqual({ protocol: 'hysteria', cred: 'hy', network: 'hysteria' });
    expect(xrayOutboundIdentity(undefined)).toEqual({ protocol: '', cred: '', network: 'tcp' });
  });

  it('传输名与结构化导入同口径归一（raw→tcp、splithttp→xhttp、h2→http）：面板改拼写不改身份', () => {
    const id = (network: string) =>
      xrayOutboundIdentity({
        protocol: 'vless',
        settings: { vnext: [{ address: 'a', port: 1, users: [{ id: 'u' }] }] },
        streamSettings: { network },
      }).network;
    expect(id('raw')).toBe(id('tcp'));
    expect(id('RAW')).toBe('tcp');
    expect(id('splithttp')).toBe('xhttp');
    expect(id('h2')).toBe('http');
    expect(id('kcp')).toBe('kcp');
  });

  it('订阅对账：透传节点的 network 由 tcp 改名 raw → 沿用旧 id（不删旧增新），contentChanged 只反映内容差异', () => {
    // SubscriptionService 依赖 electron：仅本用例隔离加载（本文件其余用例保持零 electron）。
    let reconcile!: (typeof import('../SubscriptionService'))['SubscriptionService']['reconcileServers'];
    jest.isolateModules(() => {
      jest.doMock('electron', () => ({ app: {}, net: {}, session: {} }));
      reconcile = require('../SubscriptionService').SubscriptionService.reconcileServers;
    });
    // TCP + HTTP 伪装头（透传）：Xray 的 tcp→raw 更名后面板模板改发 raw + rawSettings。
    const cfg = (network: 'tcp' | 'raw') => ({
      remarks: 'HTTP 伪装',
      outbounds: [
        {
          tag: 'proxy',
          protocol: 'vless',
          settings: { vnext: [{ address: 'h.example.com', port: 443, users: [{ id: 'uuid-1' }] }] },
          streamSettings: {
            network,
            [network === 'tcp' ? 'tcpSettings' : 'rawSettings']: { header: { type: 'http' } },
          },
        },
      ],
    });
    const before = parseXrayJson(cfg('tcp'), NOW)!.servers;
    expect(before.map((s) => s.protocol)).toEqual(['custom']);
    const r = reconcile(before, parseXrayJson(cfg('raw'), NOW)!.servers, 'T1');
    expect({ added: r.added, deleted: r.deleted, updated: r.updated }).toEqual({
      added: 0,
      deleted: 0,
      updated: 1,
    });
    expect(r.servers[0].id).toBe(before[0].id);
    expect(r.contentChanged).toBe(true); // outbound JSON 确有变化（raw / rawSettings）
    // 同一份 raw 配置再刷新：id 不变、无内容变化 → 不打断
    const again = reconcile(r.servers, parseXrayJson(cfg('raw'), NOW)!.servers, 'T2');
    expect(again.servers[0].id).toBe(before[0].id);
    expect(again.contentChanged).toBe(false);
  });
});
