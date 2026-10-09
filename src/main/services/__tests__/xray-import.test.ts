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
