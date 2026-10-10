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
  validateShadowsocks2022Password,
  validateVlessEncryption,
  xrayInboundTag,
  xrayOutboundTag,
} from '../xray-config-builder';

const UUID = '8a502aeb-b677-4fc6-bdbf-0b11435a99ec';
const ENC = 'mlkem768x25519plus.native.0rtt.QxKoobAnmyilC09GlvGiUCWXF1PrxmC7l2lR72ThGSE';
const PBK = 'e5pKf8zQy_I1P-H_GcWVubf9EYtWT6gX_6Q5exYFvi0';
const SS16 = Buffer.alloc(16, 1).toString('base64'); // 2022-blake3-aes-128-gcm 合法密钥
const SS32 = Buffer.alloc(32, 2).toString('base64');

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
        sockopt: { dialerProxy: 'flowz-dialer', penetrate: true },
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

  it('trojan + REALITY（表单 / 分享链产出形态）：realitySettings 全映射，不带 TLS 的默认 ALPN', () => {
    const ob = buildXrayOutbound(
      {
        id: 't',
        name: 't',
        protocol: 'trojan',
        address: 'a',
        port: 443,
        password: 'p',
        network: 'grpc',
        grpcSettings: { serviceName: 'svc' },
        security: 'reality',
        tlsSettings: { serverName: 'www.microsoft.com', allowInsecure: false, fingerprint: 'ios' },
        realitySettings: { publicKey: PBK, shortId: 'ab', spiderX: '/s', mldsa65Verify: 'pq' },
        useXrayCore: true,
      } as ServerConfig,
      'x'
    );
    expect(ob.settings).toEqual({ servers: [{ address: 'a', port: 443, password: 'p' }] });
    expect(ob.streamSettings).toEqual({
      network: 'grpc',
      grpcSettings: { serviceName: 'svc' },
      security: 'reality',
      realitySettings: {
        serverName: 'www.microsoft.com',
        fingerprint: 'ios',
        publicKey: PBK,
        shortId: 'ab',
        spiderX: '/s',
        mldsa65Verify: 'pq',
      },
    });
  });

  it("REALITY 指纹 'none'（trojan 的 TLS 缺省）→ chrome：Xray 拒收 'unsafe'（真核实证）", () => {
    for (const protocol of ['trojan', 'vless'] as const) {
      const ob = buildXrayOutbound(
        {
          id: 't',
          name: 't',
          protocol,
          address: 'a',
          port: 443,
          password: 'p',
          uuid: UUID,
          security: 'reality',
          tlsSettings: { serverName: 'www.microsoft.com', fingerprint: 'none' },
          realitySettings: { publicKey: PBK },
        } as ServerConfig,
        'x'
      );
      expect((ob.streamSettings as any).realitySettings.fingerprint).toBe('chrome');
    }
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
        shadowsocksSettings: { method: '2022-blake3-aes-128-gcm', password: SS16, plugin },
      }) as ServerConfig;
    expect(buildXrayOutbound(ss(), 't').settings).toEqual({
      servers: [{ address: 'a', port: 1, method: '2022-blake3-aes-128-gcm', password: SS16 }],
    });
    expect(() => buildXrayOutbound(ss('obfs-local'), 't')).toThrow(/插件/);
  });

  it('SS AEAD（表单「使用 Xray 内核」）：method / password 原样，无安全层（raw + none）', () => {
    const ob = buildXrayOutbound(
      {
        id: 's',
        name: 's',
        protocol: 'shadowsocks',
        address: 'a',
        port: 8388,
        useXrayCore: true,
        shadowsocksSettings: { method: 'aes-256-gcm', password: 'pw' },
      } as ServerConfig,
      't'
    );
    expect(ob).toEqual({
      tag: 't',
      protocol: 'shadowsocks',
      settings: {
        servers: [{ address: 'a', port: 8388, method: 'aes-256-gcm', password: 'pw' }],
      },
      streamSettings: { network: 'raw', security: 'none' },
    });
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
        sockopt: { dialerProxy: 'flowz-dialer', tcpFastOpen: true, penetrate: true },
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

describe('buildXrayOutbound — dialer 接管覆盖 XHTTP 下行腿 / ECH 查询（不旁路直拨）', () => {
  const custom = (outbound: Record<string, unknown>): ServerConfig =>
    ({
      id: 'c',
      name: 'c',
      protocol: 'custom',
      address: '',
      port: 0,
      customSettings: { outbound, engine: 'xray' },
    }) as ServerConfig;
  const down = (over: Record<string, unknown> = {}): Record<string, any> => ({
    address: 'down.example.com',
    port: 443,
    network: 'xhttp',
    ...over,
  });

  it('有 dialer：sockopt.penetrate=true（下行腿继承主 sockopt）；echConfigList → echSockopt.dialerProxy（含下行腿）', () => {
    const extra = {
      downloadSettings: down({
        security: 'tls',
        tlsSettings: { serverName: 'down.example.com', echConfigList: 'https://1.1.1.1/dns-query' },
      }),
    };
    const ob = buildXrayOutbound(
      vless({
        network: 'xhttp',
        security: 'tls',
        xhttpSettings: { path: '/x', extra },
        tlsSettings: { serverName: 's.com', ech: true, echConfig: 'https://1.1.1.1/dns-query' },
      }),
      't',
      { dialerTag: 'flowz-dialer-via-0' }
    );
    const ss = ob.streamSettings as any;
    expect(ss.sockopt).toEqual({ dialerProxy: 'flowz-dialer-via-0', penetrate: true });
    expect(ss.tlsSettings).toEqual({
      serverName: 's.com',
      echConfigList: 'https://1.1.1.1/dns-query',
      echSockopt: { dialerProxy: 'flowz-dialer-via-0' },
    });
    expect(ss.xhttpSettings.extra.downloadSettings.tlsSettings.echSockopt).toEqual({
      dialerProxy: 'flowz-dialer-via-0',
    });
    // 不污染用户配置对象（结构化 extra 是引用）
    expect(extra.downloadSettings.tlsSettings.echSockopt).toBeUndefined();
  });

  it('无 ECH → 不生成 echSockopt；自定义 JSON 的既有 echSockopt 字段保留、dialerProxy 被接管', () => {
    const plain = buildXrayOutbound(
      vless({ network: 'xhttp', security: 'tls', tlsSettings: { serverName: 's.com' } }),
      't',
      { dialerTag: 'flowz-dialer' }
    );
    expect((plain.streamSettings as any).tlsSettings).toEqual({ serverName: 's.com' });

    const ob = buildXrayOutbound(
      custom({
        protocol: 'vless',
        streamSettings: {
          network: 'xhttp',
          security: 'tls',
          tlsSettings: {
            echConfigList: 'udp://1.1.1.1',
            echSockopt: { dialerProxy: 'user-chain', mark: 7 },
          },
          sockopt: { penetrate: false, mark: 3 },
        },
      }),
      't',
      { dialerTag: 'flowz-dialer' }
    );
    expect(ob.streamSettings).toEqual({
      network: 'xhttp',
      security: 'tls',
      tlsSettings: {
        echConfigList: 'udp://1.1.1.1',
        echSockopt: { dialerProxy: 'flowz-dialer', mark: 7 },
      },
      sockopt: { penetrate: true, mark: 3, dialerProxy: 'flowz-dialer' },
    });
  });

  it('无 dialer（临时测速直拨）：主 sockopt / echSockopt / 两处 downloadSettings.sockopt 的 dialerProxy 全部剥离', () => {
    const raw = {
      protocol: 'vless',
      streamSettings: {
        network: 'xhttp',
        security: 'tls',
        tlsSettings: { echConfigList: 'udp://1.1.1.1', echSockopt: { dialerProxy: 'x', mark: 1 } },
        sockopt: { dialerProxy: 'x' },
        xhttpSettings: {
          downloadSettings: down({ sockopt: { dialerProxy: 'y', tcpFastOpen: true } }),
          extra: { downloadSettings: down({ sockopt: { dialerProxy: 'z' } }) },
        },
      },
    };
    const snapshot = JSON.parse(JSON.stringify(raw));
    const ss = buildXrayOutbound(custom(raw), 't').streamSettings as any;
    expect(ss.sockopt).toEqual({});
    expect(ss.tlsSettings.echSockopt).toEqual({ mark: 1 });
    expect(ss.xhttpSettings.downloadSettings.sockopt).toEqual({ tcpFastOpen: true });
    expect(ss.xhttpSettings.extra.downloadSettings.sockopt).toEqual({});
    expect(raw).toEqual(snapshot);

    // 结构化节点：extra 原对象不被剥离改写
    const extra = { downloadSettings: down({ sockopt: { dialerProxy: 'q' } }) };
    const ob = buildXrayOutbound(vless({ network: 'xhttp', xhttpSettings: { extra } }), 't');
    expect((ob.streamSettings as any).xhttpSettings.extra.downloadSettings.sockopt).toEqual({});
    expect(extra.downloadSettings.sockopt).toEqual({ dialerProxy: 'q' });
  });
});

describe('buildXrayOutbound — XHTTP downloadSettings 结构预检（缺 address/port 会让 Xray 首次拨号 panic）', () => {
  const xh = (extra: Record<string, unknown>) =>
    vless({ network: 'xhttp', xhttpSettings: { path: '/', extra } });
  const custom = (xhttpSettings: Record<string, unknown>): ServerConfig =>
    ({
      id: 'c',
      name: 'c',
      protocol: 'custom',
      address: '',
      port: 0,
      customSettings: {
        engine: 'xray',
        outbound: { protocol: 'vless', streamSettings: { network: 'xhttp', xhttpSettings } },
      },
    }) as ServerConfig;

  it.each([
    ['空对象', {}],
    ['缺 address', { port: 443, network: 'xhttp' }],
    ['空 address', { address: ' ', port: 443 }],
    ['缺 port', { address: 'd.com', network: 'xhttp', xhttpSettings: { path: '/d' } }],
    ['port 为字符串', { address: 'd.com', port: '443' }],
    ['port 越界 0', { address: 'd.com', port: 0 }],
    ['port 越界 65536', { address: 'd.com', port: 65536 }],
    ['port 非整数', { address: 'd.com', port: 1.5 }],
    ['缺 network（下行腿按 tcp 建、首拨类型断言 panic）', { address: 'd.com', port: 443 }],
    ['network 非 XHTTP', { address: 'd.com', port: 443, network: 'raw' }],
    ['非对象', 'down.example.com'],
  ])(
    '%s → throw（结构化 extra / 自定义 extra / 自定义 xhttpSettings.downloadSettings）',
    (_n, ds) => {
      expect(() => buildXrayOutbound(xh({ downloadSettings: ds }), 't')).toThrow(
        /downloadSettings/
      );
      expect(() =>
        buildXrayOutbound(custom({ extra: { downloadSettings: ds } }), 't', { dialerTag: 'd' })
      ).toThrow(/downloadSettings/);
      expect(() => buildXrayOutbound(custom({ downloadSettings: ds }), 't')).toThrow(
        /downloadSettings/
      );
    }
  );

  it('合法 / 缺省 / null → 通过', () => {
    const ok = { address: 'd.com', port: 443, network: 'xhttp' };
    expect(() => buildXrayOutbound(xh({ downloadSettings: ok }), 't')).not.toThrow();
    expect(() => buildXrayOutbound(xh({ downloadSettings: null }), 't')).not.toThrow();
    expect(() => buildXrayOutbound(xh({ xmux: {} }), 't')).not.toThrow();
    expect(() =>
      buildXrayOutbound(
        custom({ downloadSettings: { address: '1.2.3.4', port: 65535, network: 'splithttp' } }),
        't'
      )
    ).not.toThrow();
  });

  it('旧名 splithttpSettings（无 xhttpSettings 时 Xray 照认）同样预检', () => {
    const legacy = (downloadSettings: unknown): ServerConfig =>
      ({
        id: 'c',
        name: 'c',
        protocol: 'custom',
        address: '',
        port: 0,
        customSettings: {
          engine: 'xray',
          outbound: {
            protocol: 'vless',
            streamSettings: { network: 'splithttp', splithttpSettings: { downloadSettings } },
          },
        },
      }) as ServerConfig;
    expect(() =>
      buildXrayOutbound(legacy({ network: 'xhttp', xhttpSettings: { path: '/' } }), 't')
    ).toThrow(/downloadSettings/);
    expect(() =>
      buildXrayOutbound(legacy({ address: 'd.com', port: 443, network: 'xhttp' }), 't')
    ).not.toThrow();
  });

  it('有 extra 时只校验 extra 里那条（Xray 以 extra 整体替换，外层 downloadSettings 被忽略）', () => {
    const ok = { address: 'd.com', port: 443, network: 'xhttp' };
    expect(() =>
      buildXrayOutbound(custom({ downloadSettings: {}, extra: { downloadSettings: ok } }), 't')
    ).not.toThrow();
    expect(() =>
      buildXrayOutbound(custom({ downloadSettings: ok, extra: { downloadSettings: {} } }), 't')
    ).toThrow(/downloadSettings/);
  });
});

describe('VLESS encryption 口径（仅 mlkem768x25519plus.* 视为 VLESS Encryption）', () => {
  const enc = (e: string | undefined, over: Partial<ServerConfig> = {}) =>
    (buildXrayOutbound(vless({ network: 'xhttp', encryption: e, ...over }), 't').settings as any)
      .vnext[0].users[0].encryption;

  it('杂值（auto / None / zero / 空）一律下发 none；真 ENC 串 trim 后原样下发', () => {
    expect(enc('auto')).toBe('none');
    expect(enc('None')).toBe('none');
    expect(enc('zero')).toBe('none');
    expect(enc(undefined)).toBe('none');
    expect(enc(`  ${ENC}  `)).toBe(ENC);
  });

  const KEY = 'QxKoobAnmyilC09GlvGiUCWXF1PrxmC7l2lR72ThGSE'; // 43 字符 = 32 字节
  const MLKEM_KEY = Buffer.alloc(1184, 7).toString('base64url');
  it.each(
    [
      `mlkem768x25519plus.native.0rtt.${KEY}`,
      `mlkem768x25519plus.xorpub.1rtt.${KEY}`,
      `mlkem768x25519plus.random.0rtt.${KEY}`,
      `mlkem768x25519plus.native.0rtt.100-111-1111.75-0-111.50-0-3333.${KEY}`,
      `mlkem768x25519plus.native.0rtt.${KEY}.${KEY}`,
      `mlkem768x25519plus.native.0rtt..${KEY}`, // 单个空 padding = 无 padding（Xray 接受）
      `mlkem768x25519plus.native.1rtt.${MLKEM_KEY}`,
    ].map((e) => [e.length > 120 ? `${e.slice(0, 60)}…(${e.length})` : e, e])
  )('合法串通过：%s', (_t, e) => {
    expect(() => validateVlessEncryption(e)).not.toThrow();
  });

  it.each([
    ['无公钥段（Xray -test 直接 panic）', 'mlkem768x25519plus.native.0rtt.'],
    ['短公钥（Xray -test 直接 panic）', 'mlkem768x25519plus.native.0rtt.abc'],
    ['仅 padding 无公钥（panic）', 'mlkem768x25519plus.native.0rtt.100-111-1111'],
    ['段数不足', 'mlkem768x25519plus.native.0rtt'],
    ['前缀大小写不符', `MLKEM768X25519PLUS.native.0rtt.${KEY}`],
    ['未知模式', `mlkem768x25519plus.Native.0rtt.${KEY}`],
    ['未知握手', `mlkem768x25519plus.native.600s.${KEY}`],
    ['公钥长度不对', `mlkem768x25519plus.native.0rtt.${KEY}x`],
    ['公钥截短', `mlkem768x25519plus.native.0rtt.${KEY.slice(0, 42)}`],
    ['公钥带 = 填充', `mlkem768x25519plus.native.0rtt.${KEY}=`],
    ['公钥含非 url 字符', `mlkem768x25519plus.native.0rtt.+${KEY.slice(1)}`],
    ['padding 在公钥之后', `mlkem768x25519plus.native.0rtt.${KEY}.100-111-1111`],
    ['padding 格式错', `mlkem768x25519plus.native.0rtt.abc.${KEY}`],
    ['首段 padding 过小', `mlkem768x25519plus.native.0rtt.50-10-10.${KEY}`],
    ['多个空 padding', `mlkem768x25519plus.native.0rtt...${KEY}`],
  ])('非法串 throw：%s', (_n, e) => {
    expect(() => validateVlessEncryption(e)).toThrow(/VLESS Encryption/);
  });

  it('构造期预校验：非法 ENC 节点 buildXrayOutbound throw（只 gate 本节点）', () => {
    expect(() => enc('mlkem768x25519plus.native.0rtt.abc')).toThrow(/VLESS Encryption/);
  });
});

describe('Shadowsocks 2022 密钥预校验', () => {
  it.each([
    ['2022-blake3-aes-128-gcm', SS16],
    ['2022-blake3-aes-128-gcm', SS32], // 更长的密钥被派生截断（sing-shadowsocks 同口径，Xray -test 通过）
    ['2022-blake3-aes-128-gcm', `${SS16}:${SS16}`],
    ['2022-blake3-aes-256-gcm', SS32],
    ['2022-blake3-aes-256-gcm', `${SS32}:${SS32}`],
    ['2022-blake3-chacha20-poly1305', SS32],
    ['aes-128-gcm', 'anything'], // 非 2022 方法不校验
  ])('%s %s → 通过', (m, p) => {
    expect(() => validateShadowsocks2022Password(m, p)).not.toThrow();
  });

  it.each([
    ['2022-blake3-aes-128-gcm', 'k'],
    ['2022-blake3-aes-128-gcm', SS16.replace(/=+$/, '')], // Go StdEncoding 要求填充
    ['2022-blake3-aes-128-gcm', Buffer.alloc(16, 0xfb).toString('base64url')],
    ['2022-blake3-aes-256-gcm', SS16], // 过短 → bad key
    ['2022-blake3-aes-128-gcm', `${SS16}:`],
    ['2022-blake3-chacha20-poly1305', `${SS32}:${SS32}`], // chacha20 不支持多段
    ['2022-blake3-aes-256-gcm', ` ${SS32}`],
  ])('%s %j → throw', (m, p) => {
    expect(() => validateShadowsocks2022Password(m, p)).toThrow(/Shadowsocks 2022/);
  });

  it('构造期预校验：坏密钥 SS2022 节点 buildXrayOutbound throw', () => {
    expect(() =>
      buildXrayOutbound(
        {
          id: 's',
          name: 's',
          protocol: 'shadowsocks',
          address: 'a',
          port: 1,
          useXrayCore: true,
          shadowsocksSettings: { method: '2022-blake3-aes-256-gcm', password: SS16 },
        } as ServerConfig,
        't'
      )
    ).toThrow(/Shadowsocks 2022/);
  });
});

describe('buildXrayOutbound — sing-box 独有 TLS 选项告警', () => {
  it('spoof / 非 go 引擎 → 告警（不下发）；go 引擎 / 无 TLS → 不告警', () => {
    const warns: string[] = [];
    const w = { warn: (m: string) => warns.push(m) };
    const ob = buildXrayOutbound(
      vless({
        network: 'xhttp',
        security: 'tls',
        tlsSettings: { serverName: 's.com', spoofSni: 'decoy.com', spoofMethod: 'wrong-ack' },
      }),
      't',
      w
    );
    expect((ob.streamSettings as any).tlsSettings).toEqual({ serverName: 's.com' });
    buildXrayOutbound(
      vless({ network: 'xhttp', security: 'tls', tlsSettings: { engine: 'apple' } }),
      't',
      w
    );
    expect(warns).toHaveLength(2);
    expect(warns.every((m) => /Xray 内核不支持/.test(m))).toBe(true);
    buildXrayOutbound(
      vless({ network: 'xhttp', security: 'tls', tlsSettings: { engine: 'go' } }),
      't',
      w
    );
    buildXrayOutbound(vless({ network: 'xhttp', security: 'none' }), 't', w);
    expect(warns).toHaveLength(2);
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
