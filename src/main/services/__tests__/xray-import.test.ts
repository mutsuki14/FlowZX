/**
 * xray-import 单测（node env，零 electron）。覆盖 vmess/vless/trojan/shadowsocks 映射 +
 * streamSettings(tls/reality/ws/grpc) + 不支持协议跳过 + 内部协议忽略 + 缺字段失败。
 */
import { parseXrayOutbounds } from '../xray-import';

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
    const ss = r.servers.find((s) => s.protocol === 'shadowsocks')!;
    expect(ss.shadowsocksSettings?.method).toBe('aes-256-gcm');
    expect(ss.shadowsocksSettings?.password).toBe('sspw');
  });

  it('非结构化协议原样透传为自定义 Xray 节点；内部协议(freedom/blackhole) 忽略不计', () => {
    const r = parseXrayOutbounds(
      [
        { protocol: 'socks', tag: 's', settings: { servers: [{ address: 'x', port: 1 }] } },
        { protocol: 'freedom', tag: 'direct' },
        { protocol: 'blackhole', tag: 'block' },
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
