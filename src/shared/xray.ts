/**
 * Xray 内核（sidecar）判定的单一真值——主进程（配置生成 / 进程编排 / 测速）与渲染端（徽标 / 表单）共用。
 *
 * 架构（详见 docs/XRAY.md）：sing-box 仍是主核（TUN / 路由 / DNS / 管理 API / 热切换全部不变），
 * 用到 Xray 独有特性的节点改由 Xray 子进程承载：
 *
 *   应用 ─▶ sing-box(proxy-selector) ─socks─▶ Xray(该节点入站) ─▶ 节点 outbound
 *                                                   │ sockopt.dialerProxy
 *                                                   ▼
 *                         sing-box(xray-dial-in) ─▶ xray-dial-direct / 前置代理(detour)
 *
 * Xray 的出网拨号经 dialerProxy 回到 sing-box 回环入站：loopback 不进 TUN（零回环）、节点域名由 sing-box 的
 * 节点解析器解析、前置代理链/物理网卡绑定沿用 sing-box 既有机制。
 *
 * 纯模块：不 import electron/node，可在渲染端直接使用。
 */
import type { ServerConfig } from './types';

/** Xray 内核结构化承载的协议（表单可编辑字段 → Xray outbound 的映射见 main/services/xray-config-builder）。 */
export const XRAY_STRUCTURED_PROTOCOLS: readonly string[] = [
  'vless',
  'vmess',
  'trojan',
  'shadowsocks',
];

/**
 * 节点需要 Xray 内核的原因（null = 走 sing-box）。
 *  - custom-xray     ：自定义协议且 engine='xray'（Xray outbound JSON 透传）
 *  - xhttp           ：XHTTP 传输（含旧名 splithttp）
 *  - vless-encryption：VLESS Encryption（encryption 为 mlkem768x25519plus.* 串；none / 杂值不算）
 *  - vision-udp443   ：flow=xtls-rprx-vision-udp443（sing-box 仅支持 xtls-rprx-vision）
 *  - reality-pqv     ：Reality 启用 ML-DSA-65 验证（mldsa65Verify / 分享链 pqv；仅 RAW / XHTTP / gRPC 等能切 Xray 的传输）
 *  - tls-pinned-cert ：TLS 证书 SHA-256 钉扎（pinnedPeerCertSha256 / 分享链 pcs；sing-box 无整证书钉扎，
 *                      走 sing-box 会按 CA 校验——自签证书连不上、CA 证书则钉扎静默失效）
 *  - forced          ：用户在节点上手动勾选「使用 Xray 内核」
 */
export type XrayRequirement =
  | 'custom-xray'
  | 'xhttp'
  | 'vless-encryption'
  | 'vision-udp443'
  | 'reality-pqv'
  | 'tls-pinned-cert'
  | 'forced';

/** network 值是否为 XHTTP（兼容 Xray 旧名 splithttp）。 */
export function isXhttpNetwork(network: string | undefined): boolean {
  const n = (network || '').toLowerCase();
  return n === 'xhttp' || n === 'splithttp';
}

/**
 * VLESS encryption 是否启用了 VLESS Encryption：仅认 Xray 的 `mlkem768x25519plus.*` 语法。空 / none / 其它杂值
 *（如分享链里的 `encryption=auto`）一律视为未启用——sing-box 忽略该字段、Xray 侧按 none 下发，不因杂值把节点改走 Xray。
 */
export function isVlessEncryptionEnabled(encryption: string | undefined): boolean {
  return /^mlkem768x25519plus\./i.test((encryption || '').trim());
}

/**
 * Shadowsocks 加密方法 Xray 是否支持：仅 AEAD（aes-128/256-gcm、(x)chacha20(-ietf)-poly1305）、SS2022（显式三种：
 * 2022-blake3-aes-128-gcm / -aes-256-gcm / -chacha20-poly1305）与 none/plain（大小写不敏感：Xray 自身只对 AEAD 名
 * 归一大小写、2022-blake3-* 按原样匹配，故 xray-config-builder 统一小写下发）。流加密（aes-*-cfb/ctr、rc4-md5、
 * chacha20-ietf…）已被 Xray 移除，`xray run -test` 报「unknown cipher method」——这类节点只能留在 sing-box。
 * 2022-blake3-chacha8-poly1305 Xray 26 同样报 unknown cipher method（sing-box 1.14 亦不认）：不按 `2022-blake3-*`
 * 前缀放行，免得给出一个开了就被 Xray 门剔除的「使用 Xray 内核」开关。
 */
export function isXrayShadowsocksMethod(method: string | undefined): boolean {
  const m = (method || '').trim().toLowerCase();
  return (
    m === 'aes-128-gcm' ||
    m === 'aes-256-gcm' ||
    /^x?chacha20(-ietf)?-poly1305$/.test(m) ||
    m === '2022-blake3-aes-128-gcm' ||
    m === '2022-blake3-aes-256-gcm' ||
    m === '2022-blake3-chacha20-poly1305' ||
    m === 'none' ||
    m === 'plain'
  );
}

/** 自定义协议节点是否为 Xray outbound JSON（engine='xray'）。 */
export function isXrayCustomNode(
  server: Pick<ServerConfig, 'protocol' | 'customSettings'>
): boolean {
  return server.protocol?.toLowerCase() === 'custom' && server.customSettings?.engine === 'xray';
}

/**
 * 节点能否「手动切到 Xray 内核」（表单开关可用性）：结构化协议，且未用 sing-box 独有的附加层
 *（Shadow-TLS 外层 / SS 插件——Xray 无对应实现），SS 加密方法须为 Xray 支持的 AEAD / 2022。
 */
export function canUseXrayCore(server: ServerConfig): boolean {
  const p = server.protocol?.toLowerCase();
  if (!XRAY_STRUCTURED_PROTOCOLS.includes(p)) return false;
  if (server.shadowTlsSettings) return false;
  if (p === 'shadowsocks' && server.shadowsocksSettings?.plugin) return false;
  if (p === 'shadowsocks' && !isXrayShadowsocksMethod(server.shadowsocksSettings?.method)) {
    return false;
  }
  // HTTP/2(h2) 传输已被 Xray 移除（官方建议迁 XHTTP）→ 强制 Xray 会产出 Xray 拒收的配置。
  const n = (server.network || 'tcp').toLowerCase();
  if (n === 'http' || n === 'h2') return false;
  // Xray 的 REALITY 只支持 RAW / XHTTP / gRPC（`xray run -test`：「REALITY only supports RAW, XHTTP and gRPC
  // for now」）；sing-box 不限传输 → ws / httpupgrade + REALITY 只能留在 sing-box。
  if ((server.security || '').toLowerCase() === 'reality' && (n === 'ws' || n === 'httpupgrade')) {
    return false;
  }
  return true;
}

/**
 * 判定节点是否需要 Xray 内核及原因（单一真值）。顺序 = 优先级：特性强制项先于「手动勾选」。
 * 非结构化协议（hy2/tuic/naive/wg/ts/sing-box 自定义…）恒返回 null（sing-box 承载）。
 */
export function xrayRequirement(server: ServerConfig): XrayRequirement | null {
  const p = server.protocol?.toLowerCase();
  if (p === 'custom') return isXrayCustomNode(server) ? 'custom-xray' : null;
  if (!XRAY_STRUCTURED_PROTOCOLS.includes(p)) return null;
  if (isXhttpNetwork(server.network)) return 'xhttp';
  if (p === 'vless' && isVlessEncryptionEnabled(server.encryption)) return 'vless-encryption';
  if ((server.flow || '').toLowerCase() === 'xtls-rprx-vision-udp443') return 'vision-udp443';
  // pqv 只有 Xray 消费，但 Xray 的 REALITY 仅 RAW / XHTTP / gRPC：ws / httpupgrade / h2 上 pqv 无从生效 → 归 sing-box
  //（其不限传输、忽略 pqv），与表单 realityXrayExtrasSupported 同口径（分享链 type=ws&security=reality&pqv=… 亦然）。
  if (
    (server.security || '').toLowerCase() === 'reality' &&
    !!server.realitySettings?.mldsa65Verify?.trim() &&
    canUseXrayCore(server)
  ) {
    return 'reality-pqv';
  }
  // 证书钉扎只有 Xray 消费（sing-box 无整证书钉扎）。钉扎存于 tlsSettings → 按两侧 builder 的 TLS 判据
  //（security=tls / 存在 tlsSettings / trojan）TLS 必开；Reality 不走证书链，钉扎无意义。
  // h2 / Shadow-TLS 等切不到 Xray 的节点仍归 sing-box（钉扎无从生效）。
  if (
    (server.security || '').toLowerCase() !== 'reality' &&
    !!server.tlsSettings?.pinnedPeerCertSha256?.trim() &&
    canUseXrayCore(server)
  ) {
    return 'tls-pinned-cert';
  }
  if (server.useXrayCore === true && canUseXrayCore(server)) return 'forced';
  return null;
}

/** 节点是否经 Xray 内核运行。 */
export function requiresXrayCore(server: ServerConfig): boolean {
  return xrayRequirement(server) !== null;
}

/** 自定义 Xray outbound 是否合法形态（对象且含非空字符串 protocol）。语义交 `xray run -test`。 */
export function isValidXrayOutbound(outbound: unknown): boolean {
  return (
    !!outbound &&
    typeof outbound === 'object' &&
    !Array.isArray(outbound) &&
    typeof (outbound as Record<string, unknown>).protocol === 'string' &&
    ((outbound as Record<string, unknown>).protocol as string).trim().length > 0
  );
}

/**
 * 从 Xray outbound JSON 提取「展示用」的 server/port（自定义 Xray 节点列表展示 / 导入用）。
 * 覆盖 vnext[0] / servers[0] / peers[0].endpoint 与 Xray 25+ 扁平 settings.address 四种形态；取不到返回空。
 */
export function xrayOutboundDisplayAddress(outbound: Record<string, unknown>): {
  address: string;
  port: number;
} {
  const settings = (outbound.settings as Record<string, unknown>) || {};
  const pick = (o: unknown): { address: string; port: number } | null => {
    if (!o || typeof o !== 'object') return null;
    const r = o as Record<string, unknown>;
    const address = typeof r.address === 'string' ? r.address : '';
    const port =
      typeof r.port === 'number'
        ? r.port
        : typeof r.port === 'string' && /^\d+$/.test(r.port)
          ? Number(r.port)
          : 0;
    return address ? { address, port } : null;
  };
  const first = (k: string): unknown =>
    Array.isArray(settings[k]) ? (settings[k] as unknown[])[0] : undefined;
  const flat = pick(settings);
  if (flat) return flat;
  const vnext = pick(first('vnext'));
  if (vnext) return vnext;
  const servers = pick(first('servers'));
  if (servers) return servers;
  const peer = first('peers') as Record<string, unknown> | undefined;
  if (peer && typeof peer.endpoint === 'string') {
    const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(peer.endpoint);
    if (m) return { address: m[1], port: Number(m[2]) };
  }
  return { address: '', port: 0 };
}
