/**
 * Xray 配置构造（纯函数簇，零实例状态、不 import electron，可直接 jest 单测）。
 *
 * 两层：
 *  - buildXrayOutbound：单个 ServerConfig → Xray outbound（结构化映射 vless/vmess/trojan/shadowsocks，
 *    或自定义 Xray JSON 透传），并把 sockopt.dialerProxy 接管到 FlowZ 的 dialer（回环 sing-box）。
 *  - buildXrayConfig：sidecar 整份配置——每节点一个 loopback socks 入站（独立端口 + 密码）→ inboundTag 路由
 *    → 该节点 outbound。**按入站端口而非 socks 用户名路由**：Xray 的 socks UDP 关联包不携带用户身份
 *   （实测 user 路由对 UDP 失效），按端口分流 TCP/UDP 一致。
 *
 * 字段口径以 Xray 26.x 实测为准（xray run -test）：
 *  - allowInsecure 已被移除（启用即 FATAL「migrated to pinnedPeerCertSha256」）→ 不下发，改用 pinnedPeerCertSha256；
 *  - mKCP header/seed 已迁 finalmask → 不提供结构化 kcp（需要者用自定义 Xray JSON）；
 *  - HTTP/2(h2) 传输已移除 → 结构化映射拒绝（canUseXrayCore 亦不允许强制）。
 */
import type { ServerConfig, LogLevel } from '../../shared/types';
import { isXhttpNetwork } from '../../shared/xray';

export type XrayLogLevel = 'debug' | 'info' | 'warning' | 'error' | 'none';

export interface XrayOutbound {
  tag: string;
  protocol: string;
  settings?: Record<string, unknown>;
  streamSettings?: Record<string, unknown>;
  mux?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface XrayInbound {
  tag: string;
  listen: string;
  port: number;
  protocol: string;
  settings: Record<string, unknown>;
}

export interface XrayRoutingRule {
  type?: 'field';
  inboundTag?: string[];
  network?: string;
  outboundTag: string;
}

export interface XrayConfig {
  log: { loglevel: XrayLogLevel; access?: string; dnsLog?: boolean };
  inbounds: XrayInbound[];
  outbounds: XrayOutbound[];
  routing: { domainStrategy?: string; rules: XrayRoutingRule[] };
}

/** sidecar 中一个节点的绑定：sing-box socks 出站 → 本入站（port + 凭据）→ outboundTag。 */
export interface XrayBridgeNode {
  serverId: string;
  inboundTag: string;
  outboundTag: string;
  port: number;
  user: string;
  pass: string;
  /** 本节点出网拨号所经的 dialer 出站 tag；缺省 = 不接管拨号（Xray 直拨，供无主核的临时测速会话用）。 */
  dialerTag?: string;
}

/** Xray → sing-box 的拨号回环（Xray socks 出站 → sing-box `xray-dial-in`，用户名决定 sing-box 侧前置代理）。 */
export interface XrayDialer {
  tag: string;
  port: number;
  user: string;
  pass: string;
}

/** Xray 入站/出站 tag 约定（serverId 入 tag，`xray run -test` 报错「with tag n-<id>」可反查节点）。 */
export const xrayInboundTag = (serverId: string): string => `in-${serverId}`;
export const xrayOutboundTag = (serverId: string): string => `n-${serverId}`;

/** 从 `xray run -test` 的报错中提取出错 outbound 的 tag（failed to build outbound config with tag X）。 */
export function parseXrayFailedOutboundTag(stderr: string): string | null {
  const m = /failed to build outbound config with tag ([^\s>]+)/i.exec(stderr);
  return m ? m[1] : null;
}

/**
 * FlowZ 日志级别 → Xray loglevel。info 也映射为 warning：Xray 的 info 级对每条连接打多行（分发/拨号/XHTTP 内部），
 * 全量转进 FlowZ 日志会淹没 sing-box 日志；需要 Xray 连接级细节时把 FlowZ 调到 debug。
 */
export function toXrayLogLevel(level: LogLevel | undefined): XrayLogLevel {
  switch (level) {
    case 'debug':
      return 'debug';
    case 'info':
      return 'warning';
    case 'warn':
      return 'warning';
    case 'error':
    case 'fatal':
      return 'error';
    default:
      return 'warning';
  }
}

/**
 * ECH 配置 → Xray echConfigList。Xray 接受 ECHConfigList 的 base64 串或 DNS 查询地址
 *（udp:// / https:// / h2c:// / `<domain>+https://…`）；FlowZ 表单存的是 sing-box 口径的 PEM。
 * PEM → 去 BEGIN/END 行拼 base64 体；已是 base64 / DNS 地址 → 原样；空 → null。
 */
export function toXrayEchConfigList(raw: string | undefined): string | null {
  const s = (raw || '').trim();
  if (!s) return null;
  if (/^(udp|https|h2c|tcp|tls|quic):\/\//i.test(s) || /\+(https|udp|h2c):\/\//i.test(s)) {
    return s;
  }
  if (s.includes('-----BEGIN')) {
    const body = s
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('-----'))
      .join('');
    return body || null;
  }
  return s.replace(/\s+/g, '');
}

/** FlowZ 指纹值 → Xray fingerprint。'none'（不挂 uTLS）≙ Xray 'unsafe'（Go 原生 TLS）；空 → 不下发（Xray 默认 chrome）。 */
function toXrayFingerprint(fp: string | undefined): string | undefined {
  const v = (fp || '').trim().toLowerCase();
  if (!v) return undefined;
  if (v === 'none') return 'unsafe';
  return v;
}

/** ws path 内 `?ed=` 早数据约定 Xray 原生支持，原样下发；Host 走 Xray 的 host 字段，其余 header 保留。 */
function splitHostHeader(headers: Record<string, string> | undefined): {
  host?: string;
  rest?: Record<string, string>;
} {
  if (!headers) return {};
  let host: string | undefined;
  const rest: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'host') host = v;
    else rest[k] = v;
  }
  return { host, rest: Object.keys(rest).length > 0 ? rest : undefined };
}

/** 去掉值为 undefined / 空串 的键（Xray 对空串字段多为「显式设置」语义，保持配置精简与稳定快照）。 */
function compact<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === '') continue;
    out[k] = v;
  }
  return out as T;
}

/** 结构化节点的 streamSettings（传输 + 安全层）。 */
function buildStreamSettings(
  server: ServerConfig,
  warn: (msg: string) => void
): Record<string, unknown> {
  const network = (server.network || 'tcp').toLowerCase();
  const ss: Record<string, unknown> = {};

  if (network === 'tcp' || network === 'raw' || network === '') {
    ss.network = 'raw';
  } else if (isXhttpNetwork(network)) {
    ss.network = 'xhttp';
    const x = server.xhttpSettings || {};
    const extra =
      x.extra &&
      typeof x.extra === 'object' &&
      !Array.isArray(x.extra) &&
      Object.keys(x.extra).length
        ? x.extra
        : undefined;
    ss.xhttpSettings = compact({
      host: x.host?.trim(),
      path: x.path?.trim() || '/',
      mode: x.mode && x.mode !== 'auto' ? x.mode : undefined,
      extra,
    });
  } else if (network === 'ws') {
    ss.network = 'ws';
    const { host, rest } = splitHostHeader(server.wsSettings?.headers);
    ss.wsSettings = compact({
      path: server.wsSettings?.path || '/',
      host,
      headers: rest,
    });
  } else if (network === 'httpupgrade') {
    ss.network = 'httpupgrade';
    const { host } = splitHostHeader(server.wsSettings?.headers);
    ss.httpupgradeSettings = compact({
      path: server.wsSettings?.path || '/',
      host: host || server.tlsSettings?.serverName,
    });
  } else if (network === 'grpc') {
    ss.network = 'grpc';
    ss.grpcSettings = compact({
      serviceName: server.grpcSettings?.serviceName || '',
      multiMode: server.grpcSettings?.multiMode ? true : undefined,
    });
  } else if (network === 'http' || network === 'h2') {
    throw new Error('Xray 内核已移除 HTTP/2(h2) 传输，请改用 XHTTP');
  } else {
    throw new Error(`Xray 内核不支持的传输层: ${network}`);
  }

  const security = (server.security || '').toLowerCase();
  // TLS 开启判据与 sing-box builder 逐字一致（security=tls / 存在 tlsSettings / trojan 恒 TLS），保证同一节点
  // 换内核不改变安全层语义。
  const tlsOn =
    security === 'tls' || !!server.tlsSettings || server.protocol.toLowerCase() === 'trojan';
  if (security === 'reality') {
    const r = server.realitySettings;
    if (!r?.publicKey?.trim()) throw new Error('Reality 节点缺少 publicKey');
    ss.security = 'reality';
    ss.realitySettings = compact({
      serverName: server.tlsSettings?.serverName?.trim(),
      fingerprint: toXrayFingerprint(server.tlsSettings?.fingerprint) || 'chrome',
      publicKey: r.publicKey.trim(),
      shortId: r.shortId?.trim(),
      spiderX: r.spiderX?.trim(),
      mldsa65Verify: r.mldsa65Verify?.trim(),
    });
  } else if (tlsOn) {
    const t = server.tlsSettings || {};
    ss.security = 'tls';
    const pinned = t.pinnedPeerCertSha256?.trim();
    if (t.allowInsecure && !pinned) {
      // Xray 26 移除 allowInsecure（下发即 FATAL）→ 不下发，按正常证书校验；自签证书节点需填证书指纹。
      warn(
        `节点「${server.name}」开启了「允许不安全证书」，但 Xray 内核已移除该选项：将按正常证书校验。自签证书请填写「证书 SHA256 指纹」。`
      );
    }
    let echConfigList: string | undefined;
    if (t.ech) {
      const ech = toXrayEchConfigList(t.echConfig);
      if (!ech) {
        throw new Error(
          'Xray 内核启用 ECH 需填写 ECHConfigList（base64 / PEM）或 DNS 查询地址（如 https://1.1.1.1/dns-query）'
        );
      }
      echConfigList = ech;
    }
    let alpn = t.alpn && t.alpn.length > 0 ? t.alpn : undefined;
    if (!alpn && server.protocol.toLowerCase() === 'trojan' && !isXhttpNetwork(network)) {
      alpn = ['http/1.1']; // 与 sing-box builder 的 trojan 默认 ALPN 一致
    }
    ss.tlsSettings = compact({
      serverName: t.serverName?.trim() || undefined,
      alpn,
      fingerprint: toXrayFingerprint(t.fingerprint),
      pinnedPeerCertSha256: pinned,
      echConfigList,
    });
  } else {
    ss.security = 'none';
  }
  return ss;
}

/** 结构化节点的 protocol + settings。 */
function buildProtocolSettings(server: ServerConfig): {
  protocol: string;
  settings: Record<string, unknown>;
} {
  const p = server.protocol.toLowerCase();
  if (p === 'vless') {
    if (!server.uuid?.trim()) throw new Error('VLESS 节点缺少 UUID');
    const encryption = server.encryption?.trim() || 'none';
    return {
      protocol: 'vless',
      settings: {
        vnext: [
          {
            address: server.address,
            port: server.port,
            users: [
              compact({
                id: server.uuid.trim(),
                encryption,
                flow: server.flow?.trim(),
              }),
            ],
          },
        ],
      },
    };
  }
  if (p === 'vmess') {
    if (!server.uuid?.trim()) throw new Error('VMess 节点缺少 UUID');
    return {
      protocol: 'vmess',
      settings: {
        vnext: [
          {
            address: server.address,
            port: server.port,
            users: [{ id: server.uuid.trim(), security: server.vmessSecurity || 'auto' }],
          },
        ],
      },
    };
  }
  if (p === 'trojan') {
    if (!server.password) throw new Error('Trojan 节点缺少密码');
    return {
      protocol: 'trojan',
      settings: {
        servers: [{ address: server.address, port: server.port, password: server.password }],
      },
    };
  }
  if (p === 'shadowsocks') {
    const ssCfg = server.shadowsocksSettings;
    if (!ssCfg?.method || !ssCfg.password) throw new Error('Shadowsocks 节点缺少加密方法或密码');
    if (ssCfg.plugin) throw new Error('Xray 内核不支持 Shadowsocks 插件');
    return {
      protocol: 'shadowsocks',
      settings: {
        servers: [
          {
            address: server.address,
            port: server.port,
            method: ssCfg.method,
            password: ssCfg.password,
          },
        ],
      },
    };
  }
  throw new Error(`Xray 内核不支持协议: ${server.protocol}`);
}

/**
 * 单节点 → Xray outbound。dialerTag 非空时把 streamSettings.sockopt.dialerProxy 接管为 FlowZ 的 dialer
 *（覆盖用户 JSON 里的同名字段，与 sing-box 自定义协议剥离 detour 同理：链路统一由 FlowZ 的 detour 管理）。
 */
export function buildXrayOutbound(
  server: ServerConfig,
  tag: string,
  opts: { dialerTag?: string; warn?: (msg: string) => void } = {}
): XrayOutbound {
  const warn = opts.warn ?? (() => {});
  let ob: XrayOutbound;
  if (server.protocol.toLowerCase() === 'custom') {
    const raw = server.customSettings?.outbound;
    if (server.customSettings?.engine !== 'xray' || !raw || typeof raw !== 'object') {
      throw new Error('自定义节点不是 Xray outbound JSON');
    }
    // 深拷贝：后续就地注入 sockopt 不得污染用户配置对象（config 内存态）。
    const copy = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
    // proxySettings（旧式链式代理）引用的 tag 在 FlowZ 生成的配置里不存在 → 剥离；链路由 FlowZ detour 管理。
    delete copy.proxySettings;
    delete copy.tag;
    if (typeof copy.protocol !== 'string' || !copy.protocol.trim()) {
      throw new Error('Xray outbound 缺少 protocol 字段');
    }
    ob = { ...(copy as Omit<XrayOutbound, 'tag'>), protocol: copy.protocol as string, tag };
  } else {
    const { protocol, settings } = buildProtocolSettings(server);
    ob = { tag, protocol, settings, streamSettings: buildStreamSettings(server, warn) };
  }

  if (opts.dialerTag) {
    const ss =
      ob.streamSettings && typeof ob.streamSettings === 'object' ? { ...ob.streamSettings } : {};
    const sockopt =
      ss.sockopt && typeof ss.sockopt === 'object' ? { ...(ss.sockopt as object) } : {};
    (sockopt as Record<string, unknown>).dialerProxy = opts.dialerTag;
    ss.sockopt = sockopt;
    ob.streamSettings = ss;
  } else if (ob.streamSettings && typeof ob.streamSettings === 'object') {
    // 无 dialer（临时测速直拨）：用户 JSON 里残留的 dialerProxy 指向不存在的 tag 会致 Xray 拒启 → 剥离。
    const sockopt = (ob.streamSettings as Record<string, unknown>).sockopt as
      | Record<string, unknown>
      | undefined;
    if (sockopt && 'dialerProxy' in sockopt) {
      const { dialerProxy: _drop, ...rest } = sockopt;
      (ob.streamSettings as Record<string, unknown>).sockopt = rest;
    }
  }
  return ob;
}

/**
 * sidecar 整份 Xray 配置。servers 按 serverId 取节点；构造失败的节点由调用方在 `xray run -test` 前就地
 * 处理（buildXrayOutbound 抛错 → 调用方剔除并记 gate 原因），本函数只拼装、不吞错。
 */
export function buildXrayConfig(input: {
  servers: ReadonlyMap<string, ServerConfig>;
  nodes: readonly XrayBridgeNode[];
  dialers: readonly XrayDialer[];
  logLevel: XrayLogLevel;
  warn?: (msg: string) => void;
}): XrayConfig {
  const inbounds: XrayInbound[] = [];
  const outbounds: XrayOutbound[] = [];
  const rules: XrayRoutingRule[] = [];

  for (const node of input.nodes) {
    const server = input.servers.get(node.serverId);
    if (!server) throw new Error(`Xray 节点不存在: ${node.serverId}`);
    inbounds.push({
      tag: node.inboundTag,
      listen: '127.0.0.1',
      port: node.port,
      protocol: 'socks',
      settings: {
        auth: 'password',
        accounts: [{ user: node.user, pass: node.pass }],
        udp: true,
        ip: '127.0.0.1',
      },
    });
    outbounds.push(
      buildXrayOutbound(server, node.outboundTag, { dialerTag: node.dialerTag, warn: input.warn })
    );
    rules.push({ type: 'field', inboundTag: [node.inboundTag], outboundTag: node.outboundTag });
  }

  for (const d of input.dialers) {
    outbounds.push({
      tag: d.tag,
      protocol: 'socks',
      settings: {
        servers: [{ address: '127.0.0.1', port: d.port, users: [{ user: d.user, pass: d.pass }] }],
      },
    });
  }

  // 兜底：未命中入站路由的流量（理论不存在）一律丢弃——Xray 无匹配时默认走**首个** outbound，
  // 不兜底会让异常流量静默串到某个节点。network 规则即 catch-all（Xray 规则须至少一个条件）。
  outbounds.push({ tag: 'flowz-block', protocol: 'blackhole' });
  rules.push({ type: 'field', network: 'tcp,udp', outboundTag: 'flowz-block' });

  return {
    log: { loglevel: input.logLevel, access: 'none', dnsLog: false },
    inbounds,
    outbounds,
    routing: { domainStrategy: 'AsIs', rules },
  };
}
