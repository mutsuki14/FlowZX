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
import { isVlessEncryptionEnabled, isXhttpNetwork } from '../../shared/xray';
import { realityFingerprint } from '../../shared/reality';

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
  if (/^(udp|https|h2c|tcp|tls|quic):\/\//i.test(s)) return s;
  // `<domain>+https://…`：分隔符 '+' 可能已被表单解码成空白（旧版分享链解析存量）→ 归一回 '+'。
  if (/[+\s](https|udp|h2c):\/\//i.test(s))
    return s.replace(/[+\s]+(?=(https|udp|h2c):\/\/)/i, '+');
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

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * VLESS Encryption 串预校验（镜像 Xray 26 infra/conf/vless.go + encryption.ParsePadding）：
 *   mlkem768x25519plus.<native|xorpub|random>.<1rtt|0rtt>[.<padding>…].<公钥>[.<公钥>…]
 * Xray 以「段长 < 20」区分 padding 段（须在公钥之前）与公钥段（base64url 无填充，32 字节 X25519 / 1184 字节 ML-KEM-768）。
 * 畸形串在 Xray 侧要么让 `xray run -test` 直接 panic（无公钥段，如 `…0rtt.` / `…0rtt.abc`），要么在起 handler 时报
 * **不带 tag** 的错（padding / 公钥位置错）——无法归因到节点会拖垮全部 Xray 节点，故在此抛错、只 gate 本节点。
 */
export function validateVlessEncryption(enc: string): void {
  const bad = (why: string) => new Error(`VLESS Encryption 参数无效：${why}`);
  const s = enc.split('.');
  if (s.length < 4 || s[0] !== 'mlkem768x25519plus') {
    throw bad('格式应为 mlkem768x25519plus.<模式>.<1rtt|0rtt>.<公钥>');
  }
  if (!['native', 'xorpub', 'random'].includes(s[1])) throw bad(`未知模式「${s[1]}」`);
  if (!['1rtt', '0rtt'].includes(s[2])) throw bad(`未知握手「${s[2]}」`);
  const rest = s.slice(3);
  const firstKey = rest.findIndex((r) => r.length >= 20);
  if (firstKey < 0) throw bad('缺少公钥');
  for (const k of rest.slice(firstKey)) {
    if (!/^[A-Za-z0-9_-]+$/.test(k) || ![32, 1184].includes(Buffer.from(k, 'base64url').length)) {
      throw bad(
        '公钥须为 base64url 编码的 32 字节（X25519）或 1184 字节（ML-KEM-768），且位于 padding 之后'
      );
    }
  }
  // padding（公钥前的短段，`.` 连接；空串 = 无 padding）：每段「概率-最小-最大」三个整数，首段 ≥100-35-35，
  // 长度段（偶数位）最大值之和 ≤ 18+65535。
  const padding = rest.slice(0, firstKey).join('.');
  if (!padding) return;
  let total = 0;
  padding.split('.').forEach((seg, i) => {
    const x = seg.split('-');
    if (x.length < 3 || !x.slice(0, 3).every((v) => /^\d+$/.test(v))) {
      throw bad(`padding 段「${seg}」格式应为 概率-最小-最大`);
    }
    const [p, lo, hi] = x.slice(0, 3).map(Number);
    if (i === 0 && (p < 100 || lo < 35 || hi < 35)) throw bad('首段 padding 不得小于 100-35-35');
    if (i % 2 === 0) total += Math.max(lo, hi);
  });
  if (total > 18 + 65535) throw bad('padding 总长度超过 65553');
}

/**
 * Shadowsocks 2022 密钥预校验（镜像 sing-shadowsocks shadowaead_2022.NewWithPassword，Xray 同用）：`:` 分隔的每段
 * 须为标准 base64（带填充），解码长度 ≥ 方法密钥长度（aes-128 为 16，其余 32；更长的会被派生截断，可用）；
 * chacha20-poly1305 不支持多段（EIH）。不合法时 Xray 在起 handler 时报**不带 tag** 的「decode key / bad key」，
 * 无法归因到节点 → 在此抛错、只 gate 本节点。非 2022 方法不校验。
 */
export function validateShadowsocks2022Password(method: string, password: string): void {
  const m = method.toLowerCase();
  if (!m.startsWith('2022-')) return;
  const keyLen = m === '2022-blake3-aes-128-gcm' ? 16 : 32;
  const parts = password.replace(/[\r\n]/g, '').split(':');
  if (m === '2022-blake3-chacha20-poly1305' && parts.length > 1) {
    throw new Error('Shadowsocks 2022（chacha20-poly1305）不支持多段密钥');
  }
  for (const p of parts) {
    if (
      !/^[A-Za-z0-9+/]*={0,2}$/.test(p) ||
      p.length % 4 !== 0 ||
      Buffer.from(p, 'base64').length < keyLen
    ) {
      throw new Error(`Shadowsocks 2022 密钥无效：须为 base64 编码的 ${keyLen} 字节密钥`);
    }
  }
}

/** XHTTP 传输块：xhttpSettings 优先，缺省时 Xray 仍认旧名 splithttpSettings（StreamConfig.Build 同口径）。 */
function xhttpTransportSettings(ss: Record<string, unknown>): Record<string, unknown> | null {
  const x = ss.xhttpSettings ?? ss.splithttpSettings;
  return isPlainObject(x) ? x : null;
}

/** XHTTP 上下行分离的下行腿配置原值（<xhttp>.downloadSettings / <xhttp>.extra.downloadSettings）。 */
function xhttpDownloadSettings(ss: Record<string, unknown>): unknown[] {
  const x = xhttpTransportSettings(ss);
  if (!x) return [];
  return [x.downloadSettings, isPlainObject(x.extra) ? x.extra.downloadSettings : undefined];
}

/**
 * downloadSettings 结构预检：须含非空 address、1..65535 整数 port，且 network 为 xhttp/splithttp。`xray run -test`
 * 对这些缺失照样放行，但首次拨号即 panic（缺 address：解引用空 Destination，源码注释「just panic」；network 非 XHTTP：
 * 下行腿对 *splithttp.Config 做不带 ok 的类型断言）——所有 Xray 节点共用一个 sidecar，一个坏节点会拖垮全部，故在此抛错、
 * 只 gate 本节点。只校验生效的那条：有 extra 时 Xray 以 extra 整体替换（外层 downloadSettings 被忽略）。
 */
function validateXhttpDownloadSettings(ss: Record<string, unknown>): void {
  const x = xhttpTransportSettings(ss);
  if (!x) return;
  const ds = isPlainObject(x.extra) ? x.extra.downloadSettings : x.downloadSettings;
  if (ds === undefined || ds === null) return;
  const ok =
    isPlainObject(ds) &&
    typeof ds.address === 'string' &&
    ds.address.trim() !== '' &&
    typeof ds.port === 'number' &&
    Number.isInteger(ds.port) &&
    ds.port >= 1 &&
    ds.port <= 65535 &&
    typeof ds.network === 'string' &&
    isXhttpNetwork(ds.network);
  if (!ok) {
    throw new Error(
      'XHTTP downloadSettings 缺少 address/port 或 network 不是 xhttp（需填写下行服务器地址、端口，network 为 xhttp）'
    );
  }
}

/** 删除对象上的 dialerProxy（对象不存在 / 无此键 → 无操作）。 */
function dropDialerProxy(o: unknown): void {
  if (isPlainObject(o)) delete o.dialerProxy;
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
      // REALITY 必须是浏览器指纹：'none'（→ Xray 'unsafe'）被 Xray 拒收 → 与 sing-box 同口径归一为 chrome。
      fingerprint: realityFingerprint(server.tlsSettings?.fingerprint),
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
  // sing-box 独有的 TLS 选项（spoof / 系统原生 TLS 引擎）Xray 无对应实现 → 告警后忽略（不静默）。
  //（TLS 分片另经 sing-box 的 xray-dial-in 路由选项实现，见 xray-bridge。）
  const t = server.tlsSettings;
  if (
    ss.security !== 'none' &&
    t &&
    ((t.spoofMethod && t.spoofSni?.trim()) || (t.engine && t.engine !== 'go'))
  ) {
    warn(
      `节点「${server.name}」设置了 TLS 伪装（spoof）或系统 TLS 引擎，Xray 内核不支持这些选项，已忽略。`
    );
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
    // 仅真正的 VLESS Encryption 串原样下发（先做语法预校验）；none / 空 / 杂值（auto、None…）一律 none——Xray 对
    // 非 none 的杂值直接拒收，而 sing-box 时代这些节点是忽略该字段照常可用的。
    const encryption = isVlessEncryptionEnabled(server.encryption)
      ? (server.encryption || '').trim()
      : 'none';
    if (encryption !== 'none') validateVlessEncryption(encryption);
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
    // 方法名统一小写下发：Xray 仅对 AEAD 名做大小写归一，2022-blake3-* 按原样匹配（大写导入 → 「unknown cipher
    // method」）；shared/xray#isXrayShadowsocksMethod 按大小写不敏感放行，两侧在此对齐。
    const method = ssCfg?.method?.trim().toLowerCase();
    if (!method || !ssCfg?.password) throw new Error('Shadowsocks 节点缺少加密方法或密码');
    if (ssCfg.plugin) throw new Error('Xray 内核不支持 Shadowsocks 插件');
    validateShadowsocks2022Password(method, ssCfg.password);
    return {
      protocol: 'shadowsocks',
      settings: {
        servers: [
          {
            address: server.address,
            port: server.port,
            method,
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
 *（覆盖用户 JSON 里的同名字段，与 sing-box 自定义协议剥离 detour 同理：链路统一由 FlowZ 的 detour 管理），
 * 并以 sockopt.penetrate / tlsSettings.echSockopt 让 XHTTP 下行腿与 ECH 查询同样经 dialer（绝不旁路直拨）。
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
  if (isPlainObject(ob.streamSettings)) validateXhttpDownloadSettings(ob.streamSettings);

  // 深拷贝后再就地改写：结构化节点的 xhttpSettings.extra 是用户配置对象的引用，不得污染。
  const stream = isPlainObject(ob.streamSettings)
    ? (JSON.parse(JSON.stringify(ob.streamSettings)) as Record<string, unknown>)
    : undefined;
  if (opts.dialerTag) {
    const ss = stream ?? {};
    // penetrate：XHTTP 上下行分离的下行腿（downloadSettings）只在 penetrate=true 时继承主 sockopt，否则 Xray 直拨
    //（绕过 dialer：不走前置代理、不经 sing-box 节点解析器）。对非 XHTTP 传输无副作用。
    ss.sockopt = {
      ...(isPlainObject(ss.sockopt) ? ss.sockopt : {}),
      dialerProxy: opts.dialerTag,
      penetrate: true,
    };
    // ECH 的 DNS 查询（echConfigList 为 DoH 等地址时）走 tlsSettings.echSockopt，同样接管到 dialer（含下行腿）。
    for (const leg of [ss, ...xhttpDownloadSettings(ss).filter(isPlainObject)]) {
      const tls = leg.tlsSettings;
      if (isPlainObject(tls) && tls.echConfigList) {
        tls.echSockopt = {
          ...(isPlainObject(tls.echSockopt) ? tls.echSockopt : {}),
          dialerProxy: opts.dialerTag,
        };
      }
    }
    ob.streamSettings = ss;
  } else if (stream) {
    // 无 dialer（临时测速直拨）：用户 JSON 里残留的 dialerProxy（主 sockopt / ECH echSockopt / XHTTP 下行腿）
    // 指向本配置里不存在的 tag → 剥离。
    for (const leg of [stream, ...xhttpDownloadSettings(stream).filter(isPlainObject)]) {
      dropDialerProxy(leg.sockopt);
      if (isPlainObject(leg.tlsSettings)) dropDialerProxy(leg.tlsSettings.echSockopt);
    }
    ob.streamSettings = stream;
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
