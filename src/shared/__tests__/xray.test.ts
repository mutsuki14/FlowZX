/**
 * shared/xray.ts —— 「节点走哪个内核」的单一真值。路由错判的两种代价都很高：
 *  - 该走 Xray 却走了 sing-box → sing-box check FATAL（xhttp 等未知字段）或静默连不上；
 *  - 不该走 Xray 却走了 → 平白多一跳、且 sing-box 独有特性（Shadow-TLS、SS 插件、h2）在 Xray 侧无法映射。
 */
import type { ServerConfig } from '../types';
import {
  xrayRequirement,
  requiresXrayCore,
  canUseXrayCore,
  isVlessEncryptionEnabled,
  isValidXrayOutbound,
  xrayOutboundDisplayAddress,
  isXhttpNetwork,
} from '../xray';

const node = (over: Partial<ServerConfig>): ServerConfig =>
  ({
    id: 'n',
    name: 'n',
    protocol: 'vless',
    address: 'a.com',
    port: 443,
    uuid: 'u',
    ...over,
  }) as ServerConfig;

describe('xrayRequirement', () => {
  it('普通 VLESS-Reality-Vision → sing-box（null）', () => {
    expect(
      xrayRequirement(
        node({
          security: 'reality',
          flow: 'xtls-rprx-vision',
          realitySettings: { publicKey: 'k' },
        })
      )
    ).toBeNull();
  });

  it('XHTTP（含旧名 splithttp）→ xhttp', () => {
    expect(xrayRequirement(node({ network: 'xhttp' }))).toBe('xhttp');
    expect(xrayRequirement(node({ network: 'splithttp' as never }))).toBe('xhttp');
    expect(xrayRequirement(node({ protocol: 'trojan', network: 'xhttp', password: 'p' }))).toBe(
      'xhttp'
    );
    expect(xrayRequirement(node({ protocol: 'vmess', network: 'xhttp' }))).toBe('xhttp');
  });

  it('VLESS Encryption（encryption≠none）→ vless-encryption；none / 空 → null', () => {
    expect(xrayRequirement(node({ encryption: 'mlkem768x25519plus.native.0rtt.abc' }))).toBe(
      'vless-encryption'
    );
    expect(xrayRequirement(node({ encryption: 'none' }))).toBeNull();
    expect(xrayRequirement(node({ encryption: '' }))).toBeNull();
    expect(xrayRequirement(node({ encryption: 'NONE' }))).toBeNull();
  });

  it('VLESS encryption 杂值（auto / None / zero）不视为 VLESS Encryption：仍走 sing-box（其忽略该字段）', () => {
    expect(xrayRequirement(node({ encryption: 'auto' }))).toBeNull();
    expect(xrayRequirement(node({ encryption: 'None' }))).toBeNull();
    expect(xrayRequirement(node({ encryption: 'zero' }))).toBeNull();
    expect(
      xrayRequirement(node({ network: 'ws', security: 'tls', encryption: 'auto' }))
    ).toBeNull();
  });

  it('vision-udp443 / Reality ML-DSA-65 → Xray', () => {
    expect(xrayRequirement(node({ flow: 'xtls-rprx-vision-udp443' }))).toBe('vision-udp443');
    expect(
      xrayRequirement(
        node({ security: 'reality', realitySettings: { publicKey: 'k', mldsa65Verify: 'pq' } })
      )
    ).toBe('reality-pqv');
  });

  it('TLS 证书钉扎（pinnedPeerCertSha256 / pcs）→ tls-pinned-cert：sing-box 无整证书钉扎', () => {
    const pin = { pinnedPeerCertSha256: 'e3b0c442' };
    expect(xrayRequirement(node({ security: 'tls', tlsSettings: pin }))).toBe('tls-pinned-cert');
    // trojan 恒 TLS / vmess+ws：同一 TLS 判据
    expect(
      xrayRequirement(node({ protocol: 'trojan', password: 'p', network: 'tcp', tlsSettings: pin }))
    ).toBe('tls-pinned-cert');
    expect(
      xrayRequirement(node({ protocol: 'vmess', security: 'tls', network: 'ws', tlsSettings: pin }))
    ).toBe('tls-pinned-cert');
    // 钉扎优先于手动勾选（开关置灰显示原因）；更高优先级的特性项照旧
    expect(xrayRequirement(node({ security: 'tls', tlsSettings: pin, useXrayCore: true }))).toBe(
      'tls-pinned-cert'
    );
    expect(xrayRequirement(node({ network: 'xhttp', security: 'tls', tlsSettings: pin }))).toBe(
      'xhttp'
    );
  });

  it('证书钉扎不触发：空白值 / Reality / 切不到 Xray 的节点（h2、Shadow-TLS、非结构化协议）', () => {
    const pin = { pinnedPeerCertSha256: 'e3b0c442' };
    expect(
      xrayRequirement(node({ security: 'tls', tlsSettings: { pinnedPeerCertSha256: '  ' } }))
    ).toBeNull();
    expect(
      xrayRequirement(
        node({ security: 'reality', realitySettings: { publicKey: 'k' }, tlsSettings: pin })
      )
    ).toBeNull();
    expect(
      xrayRequirement(node({ security: 'tls', network: 'http', tlsSettings: pin }))
    ).toBeNull();
    expect(
      xrayRequirement(
        node({ security: 'tls', tlsSettings: pin, shadowTlsSettings: { password: 'p', sni: 's' } })
      )
    ).toBeNull();
    expect(
      xrayRequirement(node({ protocol: 'hysteria2', password: 'p', tlsSettings: pin }))
    ).toBeNull();
  });

  it('XHTTP + Reality + ENC 组合：特性项优先于手动勾选', () => {
    expect(
      xrayRequirement(
        node({
          network: 'xhttp',
          security: 'reality',
          encryption: 'mlkem768x25519plus.native.0rtt.abc',
          useXrayCore: true,
        })
      )
    ).toBe('xhttp');
  });

  it('手动勾选 useXrayCore：仅结构化协议且无 sing-box 独有附加层时生效', () => {
    expect(xrayRequirement(node({ useXrayCore: true }))).toBe('forced');
    expect(
      xrayRequirement(
        node({
          protocol: 'shadowsocks',
          useXrayCore: true,
          shadowsocksSettings: { method: 'aes-128-gcm', password: 'p', plugin: 'obfs-local' },
        })
      )
    ).toBeNull();
    expect(
      xrayRequirement(node({ useXrayCore: true, shadowTlsSettings: { password: 'p', sni: 's' } }))
    ).toBeNull();
    expect(xrayRequirement(node({ useXrayCore: true, network: 'http' }))).toBeNull();
    expect(xrayRequirement(node({ protocol: 'hysteria2', useXrayCore: true }))).toBeNull();
  });

  it('自定义协议：engine=xray → custom-xray；sing-box 自定义 → null', () => {
    expect(
      xrayRequirement(
        node({
          protocol: 'custom',
          customSettings: { outbound: { protocol: 'vless' }, engine: 'xray' },
        })
      )
    ).toBe('custom-xray');
    expect(
      xrayRequirement(node({ protocol: 'custom', customSettings: { outbound: { type: 'snell' } } }))
    ).toBeNull();
  });

  it('requiresXrayCore 与 xrayRequirement 同口径', () => {
    expect(requiresXrayCore(node({ network: 'xhttp' }))).toBe(true);
    expect(requiresXrayCore(node({}))).toBe(false);
  });
});

describe('辅助谓词', () => {
  it('isVlessEncryptionEnabled / isXhttpNetwork', () => {
    expect(isVlessEncryptionEnabled(undefined)).toBe(false);
    expect(isVlessEncryptionEnabled(' none ')).toBe(false);
    expect(isVlessEncryptionEnabled('mlkem768x25519plus.xorpub.1rtt.k')).toBe(true);
    expect(isVlessEncryptionEnabled(' MLKEM768X25519PLUS.native.0rtt.k ')).toBe(true);
    expect(isVlessEncryptionEnabled('auto')).toBe(false);
    expect(isVlessEncryptionEnabled('mlkem768x25519plus')).toBe(false);
    expect(isXhttpNetwork('XHTTP')).toBe(true);
    expect(isXhttpNetwork('ws')).toBe(false);
  });

  it('canUseXrayCore：vless/vmess/trojan/ss 可；hy2/tuic/custom 不可', () => {
    expect(canUseXrayCore(node({}))).toBe(true);
    expect(canUseXrayCore(node({ protocol: 'tuic' }))).toBe(false);
    expect(canUseXrayCore(node({ protocol: 'custom' }))).toBe(false);
  });

  it('isValidXrayOutbound 要求非空字符串 protocol', () => {
    expect(isValidXrayOutbound({ protocol: 'vless' })).toBe(true);
    expect(isValidXrayOutbound({ type: 'vless' })).toBe(false);
    expect(isValidXrayOutbound({ protocol: ' ' })).toBe(false);
    expect(isValidXrayOutbound([])).toBe(false);
  });

  it('xrayOutboundDisplayAddress 覆盖 vnext / servers / 扁平 / wireguard peers', () => {
    expect(
      xrayOutboundDisplayAddress({
        protocol: 'vless',
        settings: { vnext: [{ address: 'v.com', port: 443 }] },
      })
    ).toEqual({ address: 'v.com', port: 443 });
    expect(
      xrayOutboundDisplayAddress({
        protocol: 'trojan',
        settings: { servers: [{ address: 't.com', port: '8443' }] },
      })
    ).toEqual({ address: 't.com', port: 8443 });
    expect(
      xrayOutboundDisplayAddress({ protocol: 'vless', settings: { address: 'f.com', port: 1 } })
    ).toEqual({ address: 'f.com', port: 1 });
    expect(
      xrayOutboundDisplayAddress({
        protocol: 'wireguard',
        settings: { peers: [{ endpoint: '[2001:db8::1]:51820' }] },
      })
    ).toEqual({ address: '2001:db8::1', port: 51820 });
    expect(xrayOutboundDisplayAddress({ protocol: 'freedom' })).toEqual({ address: '', port: 0 });
  });
});
