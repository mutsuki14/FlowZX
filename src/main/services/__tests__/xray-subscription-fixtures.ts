/**
 * Xray JSON 订阅语料（SubscriptionService.xray 单测 + xray-check-gate 真核门共用）。
 *
 * 形态仿 Marzban / 3x-ui 的「v2ray-json」订阅：JSON 数组，每个元素是一份**完整 Xray 客户端配置**
 *（log / inbounds / outbounds / routing + 顶层 remarks），主代理 outbound 普遍 tag="proxy"，另带 freedom/blackhole
 * 内部 outbound；各配置复用同名 tag，链式代理（dialerProxy）只在本配置内有效。
 * 取值均为 Xray 26 可接受的真实格式（UUID / REALITY 公钥 / VLESS Encryption 串），可直接 `xray run -test`。
 */

export const XRAY_SUB_UUID = {
  hk: '8a502aeb-b677-4fc6-bdbf-0b11435a99ec',
  jp: '2b6f1a5e-3c4d-4e8f-9a0b-1c2d3e4f5a6b',
  kcpA: '0f7e6d5c-4b3a-4291-8807-a6b5c4d3e2f1',
  kcpB: '9e8d7c6b-5a49-4382-b716-05f4e3d2c1b0',
  frag: '6c5b4a39-2817-4f6e-8d5c-4b3a29180716',
  xhttp: 'f1e2d3c4-b5a6-4978-8695-a4b3c2d1e0f9',
} as const;

/** REALITY 公钥（x25519，base64url 32 字节）与 VLESS Encryption 客户端串：取自 xray-check-gate 语料。 */
export const XRAY_SUB_PBK = 'e5pKf8zQy_I1P-H_GcWVubf9EYtWT6gX_6Q5exYFvi0';
export const XRAY_SUB_ENC =
  'mlkem768x25519plus.native.0rtt.QxKoobAnmyilC09GlvGiUCWXF1PrxmC7l2lR72ThGSE';

/** 一份 v2ray-json 客户端配置：proxies 在前，内部 outbound（freedom / blackhole）在后。 */
function clientConfig(
  remarks: string,
  proxies: Record<string, unknown>[]
): Record<string, unknown> {
  return {
    remarks,
    log: { loglevel: 'warning' },
    inbounds: [
      {
        tag: 'socks',
        listen: '127.0.0.1',
        port: 10808,
        protocol: 'socks',
        settings: { udp: true, auth: 'noauth' },
        sniffing: { enabled: true, destOverride: ['http', 'tls'] },
      },
    ],
    outbounds: [
      ...proxies,
      { tag: 'direct', protocol: 'freedom', settings: {} },
      { tag: 'block', protocol: 'blackhole', settings: {} },
    ],
    routing: {
      domainStrategy: 'AsIs',
      rules: [{ type: 'field', domain: ['full:direct.example.org'], outboundTag: 'direct' }],
    },
  };
}

const vlessKcp = (id: string): Record<string, unknown> => ({
  tag: 'proxy',
  protocol: 'vless',
  settings: {
    vnext: [{ address: 'kcp.example.com', port: 2053, users: [{ id, encryption: 'none' }] }],
  },
  streamSettings: { network: 'kcp', kcpSettings: { mtu: 1350, tti: 50 } },
});

/**
 * 7 份配置 → 8 个节点：
 *  - HK：VLESS + REALITY + Vision（结构化）；mux.enabled=false（Marzban 默认下发）不触发透传
 *  - JP：VMess + WS + TLS（结构化）
 *  - US：Trojan --dialerProxy--> SS 中转（同配置内的链，两个节点 → "<remarks> · <tag>" 命名）
 *  - KCP A / KCP B：同 host:port、不同 UUID 的 mKCP（透传自定义 Xray 节点，对账靠 xrayOutboundIdentity 区分）
 *  - 3x-ui 分片：sockopt{dialerProxy:fragment, tcpKeepAliveIdle…}（透传；fragment 为 freedom → 断链告警）
 *  - XHTTP：VLESS + XHTTP + REALITY + ENC（结构化，需 Xray 内核）
 */
export function v2rayJsonSubscription(): Record<string, unknown>[] {
  return [
    clientConfig('🇭🇰 HK Reality', [
      {
        tag: 'proxy',
        protocol: 'vless',
        settings: {
          vnext: [
            {
              address: 'hk.example.com',
              port: 443,
              users: [{ id: XRAY_SUB_UUID.hk, encryption: 'none', flow: 'xtls-rprx-vision' }],
            },
          ],
        },
        streamSettings: {
          network: 'tcp',
          security: 'reality',
          realitySettings: {
            serverName: 'www.microsoft.com',
            fingerprint: 'chrome',
            publicKey: XRAY_SUB_PBK,
            shortId: '0123abcd',
            spiderX: '/',
          },
        },
        mux: { enabled: false, concurrency: -1 },
      },
    ]),
    clientConfig('🇯🇵 JP VMess-WS', [
      {
        tag: 'proxy',
        protocol: 'vmess',
        settings: {
          vnext: [
            {
              address: 'jp.example.com',
              port: 443,
              users: [{ id: XRAY_SUB_UUID.jp, alterId: 0, security: 'auto' }],
            },
          ],
        },
        streamSettings: {
          network: 'ws',
          security: 'tls',
          wsSettings: { path: '/vm', headers: { Host: 'jp.example.com' } },
          tlsSettings: { serverName: 'jp.example.com', fingerprint: 'chrome', alpn: ['http/1.1'] },
        },
      },
    ]),
    clientConfig('🇺🇸 US', [
      {
        tag: 'proxy',
        protocol: 'trojan',
        settings: { servers: [{ address: 'us.example.com', port: 443, password: 'pw-us' }] },
        streamSettings: {
          network: 'tcp',
          security: 'tls',
          tlsSettings: { serverName: 'us.example.com' },
          sockopt: { dialerProxy: 'relay' },
        },
      },
      {
        tag: 'relay',
        protocol: 'shadowsocks',
        settings: {
          servers: [
            {
              address: 'relay.example.com',
              port: 8388,
              method: 'aes-128-gcm',
              password: 'pw-relay',
            },
          ],
        },
      },
    ]),
    clientConfig('KCP A', [vlessKcp(XRAY_SUB_UUID.kcpA)]),
    clientConfig('KCP B', [vlessKcp(XRAY_SUB_UUID.kcpB)]),
    clientConfig('3x-ui 分片', [
      {
        tag: 'proxy',
        protocol: 'vless',
        settings: {
          vnext: [
            {
              address: 'frag.example.com',
              port: 443,
              users: [{ id: XRAY_SUB_UUID.frag, encryption: 'none' }],
            },
          ],
        },
        streamSettings: {
          network: 'tcp',
          security: 'tls',
          tlsSettings: { serverName: 'frag.example.com', fingerprint: 'chrome' },
          sockopt: { dialerProxy: 'fragment', tcpKeepAliveIdle: 100, tcpNoDelay: true },
        },
      },
      {
        tag: 'fragment',
        protocol: 'freedom',
        settings: {
          domainStrategy: 'AsIs',
          fragment: { packets: 'tlshello', length: '100-200', interval: '10-20' },
        },
        streamSettings: { sockopt: { tcpKeepAliveIdle: 100, tcpNoDelay: true } },
      },
    ]),
    clientConfig('XHTTP ENC', [
      {
        tag: 'proxy',
        protocol: 'vless',
        settings: {
          vnext: [
            {
              address: 'xh.example.com',
              port: 443,
              users: [{ id: XRAY_SUB_UUID.xhttp, encryption: XRAY_SUB_ENC }],
            },
          ],
        },
        streamSettings: {
          network: 'xhttp',
          security: 'reality',
          xhttpSettings: { path: '/xh', mode: 'auto' },
          realitySettings: {
            serverName: 'www.microsoft.com',
            fingerprint: 'chrome',
            publicKey: XRAY_SUB_PBK,
            shortId: 'ab',
          },
        },
      },
    ]),
  ];
}

/** 该语料解析后的节点名（顺序即订阅顺序）。 */
export const V2RAY_JSON_NODE_NAMES = [
  '🇭🇰 HK Reality',
  '🇯🇵 JP VMess-WS',
  '🇺🇸 US · proxy',
  '🇺🇸 US · relay',
  'KCP A',
  'KCP B',
  '3x-ui 分片',
  'XHTTP ENC',
];
