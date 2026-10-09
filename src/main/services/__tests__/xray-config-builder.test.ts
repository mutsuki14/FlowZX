/**
 * xray-config-builder 形状锁（toEqual 精确深等）。`xray run -test` 对**键名**同样无牙（未知键静默忽略），
 * 故键名拼写由本文件把守；值域/引用完整性由 xray-check-gate（真 Xray 内核）把守。
 */
import type { ServerConfig } from '../../../shared/types';
import {
  buildXrayOutbound,
  buildXrayConfig,
  parseXrayFailedOutboundTag,
  toXrayEchConfigList,
  toXrayLogLevel,
  xrayInboundTag,
  xrayOutboundTag,
} from '../xray-config-builder';

const UUID = '8a502aeb-b677-4fc6-bdbf-0b11435a99ec';
const ENC = 'mlkem768x25519plus.native.0rtt.QxKoobAnmyilC09GlvGiUCWXF1PrxmC7l2lR72ThGSE';
const PBK = 'e5pKf8zQy_I1P-H_GcWVubf9EYtWT6gX_6Q5exYFvi0';

const vless = (over: Partial<ServerConfig> = {}): ServerConfig =>
  ({
    id: 's1',
    name: 'X',
    protocol: 'vless',
    address: 'x.example.com',
    port: 443,
    uuid: UUID,
    ...over,
  }) as ServerConfig;

describe('buildXrayOutbound — VLESS-XHTTP-REALITY-ENC', () => {
  it('完整映射 + dialerProxy 接管', () => {
    const ob = buildXrayOutbound(
      vless({
        encryption: ENC,
        network: 'xhttp',
        security: 'reality',
        xhttpSettings: {
          path: '/xh',
          host: 'cdn.example.com',
          mode: 'stream-one',
          extra: { xmux: { maxConcurrency: '16-32' } },
        },
        tlsSettings: { serverName: 'www.microsoft.com', fingerprint: 'firefox' },
        realitySettings: { publicKey: PBK, shortId: 'ab12', spiderX: '/s', mldsa65Verify: 'pq' },
      }),
      'n-s1',
      { dialerTag: 'flowz-dialer' }
    );
    expect(ob).toEqual({
      tag: 'n-s1',
      protocol: 'vless',
      settings: {
        vnext: [{ address: 'x.example.com', port: 443, users: [{ id: UUID, encryption: ENC }] }],
      },
      streamSettings: {
        network: 'xhttp',
        xhttpSettings: {
          host: 'cdn.example.com',
          path: '/xh',
          mode: 'stream-one',
          extra: { xmux: { maxConcurrency: '16-32' } },
        },
        security: 'reality',
        realitySettings: {
          serverName: 'www.microsoft.com',
          fingerprint: 'firefox',
          publicKey: PBK,
          shortId: 'ab12',
          spiderX: '/s',
          mldsa65Verify: 'pq',
        },
        sockopt: { dialerProxy: 'flowz-dialer' },
      },
    });
  });

  it('mode=auto 不下发（Xray 默认 auto）；path 缺省 /；Reality 指纹缺省 chrome', () => {
    const ob = buildXrayOutbound(
      vless({
        network: 'xhttp',
        security: 'reality',
        xhttpSettings: { mode: 'auto' },
        realitySettings: { publicKey: PBK },
      }),
      't'
    );
    expect(ob.streamSettings).toEqual({
      network: 'xhttp',
      xhttpSettings: { path: '/' },
      security: 'reality',
      realitySettings: { fingerprint: 'chrome', publicKey: PBK },
    });
  });

  it('RAW + Reality + Vision + ENC：flow 下发到 users[0]', () => {
    const ob = buildXrayOutbound(
      vless({
        encryption: ENC,
        flow: 'xtls-rprx-vision',
        security: 'reality',
        realitySettings: { publicKey: PBK, shortId: '0123abcd' },
        tlsSettings: { serverName: 'www.example.com' },
      }),
      't'
    );
    expect((ob.settings as any).vnext[0].users[0]).toEqual({
      id: UUID,
      encryption: ENC,
      flow: 'xtls-rprx-vision',
    });
    expect((ob.streamSettings as any).network).toBe('raw');
  });
});

describe('buildXrayOutbound — TLS 口径（Xray 26）', () => {
  it('allowInsecure 不下发（Xray 26 已移除，下发即 FATAL）+ 告警；pinnedPeerCertSha256 下发', () => {
    const warns: string[] = [];
    const ob = buildXrayOutbound(
      vless({
        network: 'xhttp',
        security: 'tls',
        tlsSettings: {
          serverName: 's.com',
          allowInsecure: true,
          alpn: ['h2'],
          fingerprint: 'chrome',
          pinnedPeerCertSha256: 'ab'.repeat(32),
        },
      }),
      't',
      { warn: (m) => warns.push(m) }
    );
    expect((ob.streamSettings as any).tlsSettings).toEqual({
      serverName: 's.com',
      alpn: ['h2'],
      fingerprint: 'chrome',
      pinnedPeerCertSha256: 'ab'.repeat(32),
    });
    expect(warns).toHaveLength(0); // 有指纹即无需告警

    buildXrayOutbound(
      vless({ security: 'tls', tlsSettings: { serverName: 's.com', allowInsecure: true } }),
      't',
      { warn: (m) => warns.push(m) }
    );
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/allowInsecure|不安全证书/);
  });

  it("指纹 'none' → Xray 'unsafe'（Go 原生 TLS）", () => {
    const ob = buildXrayOutbound(
      vless({ security: 'tls', tlsSettings: { fingerprint: 'none' } }),
      't'
    );
    expect((ob.streamSettings as any).tlsSettings.fingerprint).toBe('unsafe');
  });

  it('ECH：PEM → base64 体；DNS 地址原样；开启却无配置 → throw（不静默丢 ECH 泄露 SNI）', () => {
    expect(
      toXrayEchConfigList('-----BEGIN ECH CONFIGS-----\nAEX+DQBB\nAAA=\n-----END ECH CONFIGS-----')
    ).toBe('AEX+DQBBAAA=');
    expect(toXrayEchConfigList('https://1.1.1.1/dns-query')).toBe('https://1.1.1.1/dns-query');
    expect(toXrayEchConfigList('example.com+https://1.1.1.1/dns-query')).toBe(
      'example.com+https://1.1.1.1/dns-query'
    );
    expect(toXrayEchConfigList('  ')).toBeNull();
    expect(() =>
      buildXrayOutbound(vless({ security: 'tls', tlsSettings: { ech: true } }), 't')
    ).toThrow(/ECH/);
  });

  it('trojan 默认 TLS + http/1.1 ALPN（与 sing-box builder 一致），xhttp 时不强加', () => {
    const t = (over: Partial<ServerConfig>) =>
      buildXrayOutbound(
        {
          id: 't',
          name: 't',
          protocol: 'trojan',
          address: 'a',
          port: 1,
          password: 'p',
          useXrayCore: true,
          ...over,
        } as ServerConfig,
        'x'
      );
    expect((t({}).streamSettings as any).tlsSettings).toEqual({ alpn: ['http/1.1'] });
    expect((t({ network: 'xhttp' }).streamSettings as any).tlsSettings).toEqual({});
    expect(t({}).settings).toEqual({ servers: [{ address: 'a', port: 1, password: 'p' }] });
  });
});

describe('buildXrayOutbound — 其它传输 / 协议', () => {
  it('ws：Host header → host 字段，其余 header 保留，?ed= 原样（Xray 原生支持）', () => {
    const ob = buildXrayOutbound(
      vless({
        network: 'ws',
        wsSettings: { path: '/ws?ed=2048', headers: { Host: 'h.com', 'X-A': '1' } },
      }),
      't'
    );
    expect(ob.streamSettings).toEqual({
      network: 'ws',
      wsSettings: { path: '/ws?ed=2048', host: 'h.com', headers: { 'X-A': '1' } },
      security: 'none',
    });
  });

  it('grpc / httpupgrade', () => {
    expect(
      buildXrayOutbound(
        vless({ network: 'grpc', grpcSettings: { serviceName: 'svc', multiMode: true } }),
        't'
      ).streamSettings
    ).toEqual({
      network: 'grpc',
      grpcSettings: { serviceName: 'svc', multiMode: true },
      security: 'none',
    });
    expect(
      buildXrayOutbound(
        vless({ network: 'httpupgrade', wsSettings: { path: '/hu', headers: { Host: 'h' } } }),
        't'
      ).streamSettings
    ).toEqual({
      network: 'httpupgrade',
      httpupgradeSettings: { path: '/hu', host: 'h' },
      security: 'none',
    });
  });

  it('h2 传输 → throw（Xray 已移除）', () => {
    expect(() => buildXrayOutbound(vless({ network: 'http' }), 't')).toThrow(/HTTP\/2|XHTTP/);
  });

  it('vmess / shadowsocks 映射；SS 插件 → throw', () => {
    expect(
      buildXrayOutbound(
        {
          id: 'v',
          name: 'v',
          protocol: 'vmess',
          address: 'a',
          port: 1,
          uuid: UUID,
          vmessSecurity: 'aes-128-gcm',
        } as ServerConfig,
        't'
      ).settings
    ).toEqual({
      vnext: [{ address: 'a', port: 1, users: [{ id: UUID, security: 'aes-128-gcm' }] }],
    });
    const ss = (plugin?: string) =>
      ({
        id: 's',
        name: 's',
        protocol: 'shadowsocks',
        address: 'a',
        port: 1,
        shadowsocksSettings: { method: '2022-blake3-aes-128-gcm', password: 'k', plugin },
      }) as ServerConfig;
    expect(buildXrayOutbound(ss(), 't').settings).toEqual({
      servers: [{ address: 'a', port: 1, method: '2022-blake3-aes-128-gcm', password: 'k' }],
    });
    expect(() => buildXrayOutbound(ss('obfs-local'), 't')).toThrow(/插件/);
  });
});

describe('buildXrayOutbound — 自定义 Xray JSON 透传', () => {
  const custom = (outbound: Record<string, unknown>): ServerConfig =>
    ({
      id: 'c',
      name: 'c',
      protocol: 'custom',
      address: '',
      port: 0,
      customSettings: { outbound, engine: 'xray' },
    }) as ServerConfig;

  it('强制覆盖 tag、剥离 proxySettings、接管 dialerProxy（保留用户其余 sockopt）、不污染原对象', () => {
    const raw = {
      tag: 'user-tag',
      protocol: 'vless',
      settings: { vnext: [] },
      proxySettings: { tag: 'other' },
      streamSettings: { network: 'kcp', sockopt: { dialerProxy: 'user-chain', tcpFastOpen: true } },
      mux: { enabled: true, concurrency: 8 },
    };
    const snapshot = JSON.parse(JSON.stringify(raw));
    const ob = buildXrayOutbound(custom(raw), 'n-c', { dialerTag: 'flowz-dialer' });
    expect(ob).toEqual({
      tag: 'n-c',
      protocol: 'vless',
      settings: { vnext: [] },
      streamSettings: {
        network: 'kcp',
        sockopt: { dialerProxy: 'flowz-dialer', tcpFastOpen: true },
      },
      mux: { enabled: true, concurrency: 8 },
    });
    expect(raw).toEqual(snapshot);
  });

  it('无 dialer（临时测速直拨）：剥离用户残留 dialerProxy，避免引用不存在的 tag', () => {
    const ob = buildXrayOutbound(
      custom({ protocol: 'vless', streamSettings: { sockopt: { dialerProxy: 'x', mark: 1 } } }),
      't'
    );
    expect(ob.streamSettings).toEqual({ sockopt: { mark: 1 } });
  });

  it('非 Xray 自定义节点 → throw', () => {
    expect(() =>
      buildXrayOutbound(
        {
          id: 'c',
          name: 'c',
          protocol: 'custom',
          address: '',
          port: 0,
          customSettings: { outbound: { type: 'x' } },
        } as ServerConfig,
        't'
      )
    ).toThrow();
  });
});

describe('buildXrayConfig', () => {
  it('每节点独立 loopback socks 入站（密码 + UDP）→ inboundTag 路由；dialer 回环 socks；兜底 blackhole', () => {
    const s = vless({ network: 'xhttp', encryption: ENC });
    const cfg = buildXrayConfig({
      servers: new Map([[s.id, s]]),
      nodes: [
        {
          serverId: s.id,
          inboundTag: xrayInboundTag(s.id),
          outboundTag: xrayOutboundTag(s.id),
          port: 20001,
          user: 'flowz',
          pass: 'pw',
          dialerTag: 'flowz-dialer',
        },
      ],
      dialers: [{ tag: 'flowz-dialer', port: 20002, user: 'direct', pass: 'dp' }],
      logLevel: 'warning',
    });
    expect(cfg.log).toEqual({ loglevel: 'warning', access: 'none', dnsLog: false });
    expect(cfg.inbounds).toEqual([
      {
        tag: 'in-s1',
        listen: '127.0.0.1',
        port: 20001,
        protocol: 'socks',
        settings: {
          auth: 'password',
          accounts: [{ user: 'flowz', pass: 'pw' }],
          udp: true,
          ip: '127.0.0.1',
        },
      },
    ]);
    expect(cfg.outbounds.map((o) => o.tag)).toEqual(['n-s1', 'flowz-dialer', 'flowz-block']);
    expect(cfg.outbounds[1]).toEqual({
      tag: 'flowz-dialer',
      protocol: 'socks',
      settings: {
        servers: [{ address: '127.0.0.1', port: 20002, users: [{ user: 'direct', pass: 'dp' }] }],
      },
    });
    expect(cfg.routing).toEqual({
      domainStrategy: 'AsIs',
      rules: [
        { type: 'field', inboundTag: ['in-s1'], outboundTag: 'n-s1' },
        { type: 'field', network: 'tcp,udp', outboundTag: 'flowz-block' },
      ],
    });
  });
});

describe('杂项', () => {
  it('parseXrayFailedOutboundTag 从 `xray run -test` 报错提取 tag', () => {
    expect(
      parseXrayFailedOutboundTag(
        'Failed to start: main: failed to load config files: [x.json] > infra/conf: failed to build outbound config with tag n-abc > infra/conf: ...'
      )
    ).toBe('n-abc');
    expect(parseXrayFailedOutboundTag('Failed to start: something else')).toBeNull();
  });

  it('toXrayLogLevel', () => {
    expect(toXrayLogLevel('debug')).toBe('debug');
    expect(toXrayLogLevel('info')).toBe('warning'); // Xray info 级逐连接多行，避免淹没 FlowZ 日志
    expect(toXrayLogLevel('warn')).toBe('warning');
    expect(toXrayLogLevel('fatal')).toBe('error');
    expect(toXrayLogLevel(undefined)).toBe('warning');
  });
});
