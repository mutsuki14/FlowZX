/**
 * Xray / v2ray JSON 配置 → ServerConfig 解析（纯模块，刻意不 import electron，可直接 jest 单测）。
 *
 * 与 sing-box JSON 的差异：xray outbound 用 `protocol` + `settings`（vnext/servers）+ `streamSettings`，
 * 而 sing-box 用扁平 `type` + 同级字段。两条落点：
 *  - **结构化**：vless/vmess/trojan/shadowsocks 且只用到 FlowZ 已建模字段（含 XHTTP / VLESS Encryption /
 *    Reality spiderX·ML-DSA-65 / 证书钉扎）→ 普通节点，可在表单编辑；需要 Xray 的组合由 sidecar 承载。
 *  - **原样透传**：其余（mKCP/finalmask/mux/sockopt、wireguard/hysteria 等 Xray 协议）→ 自定义节点
 *    （customSettings.engine='xray'，Xray outbound JSON 原样保存），由 Xray sidecar 直接运行，零语义丢失。
 *
 * 逐 outbound try/catch，单条失败不影响其它（对齐 ClashSubscriptionParser.parseClashProxies）。
 */
import { randomUUID } from 'crypto';
import type { ServerConfig, Network, Security, XhttpMode } from '../../shared/types';
import { xrayOutboundDisplayAddress } from '../../shared/xray';

/** 本模块可结构化映射的 xray outbound.protocol。 */
const XRAY_SUPPORTED = new Set(['vmess', 'vless', 'trojan', 'shadowsocks']);
/** xray 内部/非节点 outbound（忽略，不计入任何统计）。 */
const XRAY_INTERNAL = new Set(['freedom', 'blackhole', 'dns', 'loopback']);
/** 结构化映射认识的传输层（其余 → 原样透传）。 */
const STRUCTURED_NETWORKS = new Set([
  'tcp',
  'raw',
  'ws',
  'grpc',
  'h2',
  'http',
  'httpupgrade',
  'xhttp',
  'splithttp',
]);

export interface XrayParseResult {
  servers: ServerConfig[];
  skipped: number; // 无法导入（非对象 / 无 protocol）
  failed: number; // 字段缺失 / 异常
  warnings: string[];
}

/** 标量规整：数字/字符串统一 String()，缺省 undefined。 */
function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * 该 outbound 是否需原样透传（结构化映射会丢语义）：未知传输、finalmask、mux 开启、除 dialerProxy 外的 sockopt、
 * 遗留 xtls 安全层。dialerProxy 不算——链路由 FlowZ 的 detour 接管（与 sing-box 自定义剥 detour 同理），
 * 导入时映射为 ServerConfig.detour（见 parseXrayOutbounds 第二遍）。
 */
function needsPassthrough(o: Record<string, unknown>): string | null {
  const ss = obj(o.streamSettings);
  const network = (str(ss.network) || 'tcp').toLowerCase();
  if (!STRUCTURED_NETWORKS.has(network)) return `传输 ${network}`;
  if (ss.finalmask !== undefined) return 'finalmask';
  const security = (str(ss.security) || 'none').toLowerCase();
  if (security === 'xtls') return 'xtls';
  const sockopt = obj(ss.sockopt);
  if (Object.keys(sockopt).some((k) => k !== 'dialerProxy')) return 'sockopt';
  if (obj(o.mux).enabled === true) return 'mux';
  return null;
}

/** xray streamSettings → ServerConfig 传输/安全层字段。 */
function applyStreamSettings(server: ServerConfig, ss: Record<string, unknown> | undefined): void {
  if (!ss || typeof ss !== 'object') return;

  // 传输层
  const network = (str(ss.network) || 'tcp').toLowerCase();
  if (network === 'ws') {
    server.network = 'ws';
    const ws = obj(ss.wsSettings);
    const headers = obj(ws.headers);
    const host = str(ws.host) || str(headers.Host) || str(headers.host);
    server.wsSettings = { path: str(ws.path) || '/', headers: host ? { Host: host } : undefined };
  } else if (network === 'grpc') {
    server.network = 'grpc';
    const grpc = obj(ss.grpcSettings);
    server.grpcSettings = { serviceName: str(grpc.serviceName) || '' };
    if (grpc.multiMode === true) server.grpcSettings.multiMode = true;
  } else if (network === 'h2' || network === 'http') {
    server.network = 'http';
    const h2 = obj(ss.httpSettings);
    const hostVal = h2.host;
    server.httpSettings = {
      path: str(h2.path) || '/',
      host: Array.isArray(hostVal)
        ? (hostVal as string[])
        : str(hostVal)
          ? [str(hostVal)!]
          : undefined,
    };
  } else if (network === 'httpupgrade') {
    server.network = 'httpupgrade';
    const hu = obj(ss.httpupgradeSettings);
    const host = str(hu.host);
    server.wsSettings = { path: str(hu.path) || '/', headers: host ? { Host: host } : undefined };
  } else if (network === 'xhttp' || network === 'splithttp') {
    server.network = 'xhttp';
    const xh = obj(ss.xhttpSettings ?? ss.splithttpSettings);
    const mode = str(xh.mode)?.toLowerCase();
    // 高级项（downloadSettings / xPaddingBytes / xmux / headers…）Xray 也认在 xhttpSettings 顶层。Xray 语义：
    // 有 extra 时整份以 extra 为准（仅 path/host/mode 取顶层，顶层其余键被忽略——xray run -test 实证）；
    // 无 extra 时取顶层。FlowZ 只存 path/host/mode/extra → 无 extra 时把顶层其余键收进 extra，零语义丢失。
    const extra =
      xh.extra !== undefined
        ? obj(xh.extra)
        : Object.fromEntries(
            Object.entries(xh).filter(([k]) => !['path', 'host', 'mode', 'extra'].includes(k))
          );
    server.xhttpSettings = {
      path: str(xh.path) || '/',
      host: str(xh.host),
      mode:
        mode === 'auto' || mode === 'packet-up' || mode === 'stream-up' || mode === 'stream-one'
          ? (mode as XhttpMode)
          : undefined,
      extra: Object.keys(extra).length > 0 ? extra : undefined,
    };
  } else {
    server.network = 'tcp' as Network;
  }

  // 安全层
  const security = (str(ss.security) || 'none').toLowerCase();
  if (security === 'tls') {
    server.security = 'tls' as Security;
    const tls = obj(ss.tlsSettings);
    const alpn = tls.alpn;
    server.tlsSettings = {
      serverName: str(tls.serverName),
      allowInsecure: tls.allowInsecure === true,
      alpn: Array.isArray(alpn) ? (alpn as string[]) : undefined,
      fingerprint: str(tls.fingerprint) || 'chrome',
    };
    const pinned = str(tls.pinnedPeerCertSha256);
    if (pinned) server.tlsSettings.pinnedPeerCertSha256 = pinned;
    const ech = str(tls.echConfigList);
    if (ech) {
      server.tlsSettings.ech = true;
      server.tlsSettings.echConfig = /:\/\//.test(ech)
        ? ech
        : `-----BEGIN ECH CONFIGS-----\n${ech}\n-----END ECH CONFIGS-----`;
    }
  } else if (security === 'reality') {
    server.security = 'reality' as Security;
    const reality = obj(ss.realitySettings);
    server.tlsSettings = {
      serverName: str(reality.serverName),
      fingerprint: str(reality.fingerprint) || 'chrome',
    };
    server.realitySettings = {
      // Xray 25+ 客户端字段名 password（= publicKey），两者择一。
      publicKey: str(reality.publicKey) || str(reality.password) || '',
      shortId: str(reality.shortId),
    };
    const spiderX = str(reality.spiderX);
    if (spiderX) server.realitySettings.spiderX = spiderX;
    const pqv = str(reality.mldsa65Verify);
    if (pqv) server.realitySettings.mldsa65Verify = pqv;
  } else {
    server.security = 'none' as Security;
  }
}

/** vnext[0]/servers[0] 或 Xray 25+ 扁平 settings（address/port/id…）取首个服务端条目。 */
function firstServer(
  settings: Record<string, unknown>,
  key: 'vnext' | 'servers'
): {
  address?: string;
  port?: number;
  entry: Record<string, unknown>;
  user: Record<string, unknown>;
} {
  const list = settings[key];
  if (Array.isArray(list) && list.length > 0) {
    const entry = obj(list[0]);
    const users = entry.users;
    return {
      address: str(entry.address),
      port: num(entry.port),
      entry,
      user: Array.isArray(users) ? obj(users[0]) : {},
    };
  }
  // 扁平形态：settings 自身即服务端 + 用户
  return {
    address: str(settings.address),
    port: num(settings.port),
    entry: settings,
    user: settings,
  };
}

/** 单条 xray outbound → ServerConfig（失败 throw / 返回 null）。 */
function mapXrayOutbound(
  o: Record<string, unknown>,
  proto: string,
  now: string
): ServerConfig | null {
  const settings = obj(o.settings);
  const tag = str(o.tag);

  const base = (address: string, port: number): ServerConfig => ({
    id: randomUUID(),
    name: tag || `${address}:${port}`,
    protocol: proto as ServerConfig['protocol'],
    address,
    port,
    createdAt: now,
    updatedAt: now,
  });

  if (proto === 'vmess' || proto === 'vless') {
    const { address, port, user } = firstServer(settings, 'vnext');
    const uuid = str(user.id);
    if (!address || !port || !uuid) return null;
    const server = base(address, port);
    server.uuid = uuid;
    if (proto === 'vmess') {
      server.alterId = num(user.alterId) ?? 0;
      server.vmessSecurity = str(user.security) || 'auto';
    } else {
      server.flow = str(user.flow) || undefined;
      // VLESS Encryption（非 none → Xray sidecar 承载）。
      server.encryption = str(user.encryption) || 'none';
    }
    applyStreamSettings(server, o.streamSettings as Record<string, unknown>);
    return server;
  }

  if (proto === 'trojan') {
    const { address, port, entry } = firstServer(settings, 'servers');
    const password = str(entry.password);
    if (!address || !port || !password) return null;
    const server = base(address, port);
    server.password = password;
    applyStreamSettings(server, o.streamSettings as Record<string, unknown>);
    return server;
  }

  if (proto === 'shadowsocks') {
    const { address, port, entry } = firstServer(settings, 'servers');
    const method = str(entry.method);
    const password = str(entry.password);
    if (!address || !port || !method || !password) return null;
    const server = base(address, port);
    server.shadowsocksSettings = { method, password };
    applyStreamSettings(server, o.streamSettings as Record<string, unknown>);
    return server;
  }

  return null;
}

/** 原样透传为自定义 Xray 节点（customSettings.engine='xray'）。tag/proxySettings 由生成期接管，此处保留原文。 */
function makeXrayCustomNode(o: Record<string, unknown>, now: string): ServerConfig {
  const { address, port } = xrayOutboundDisplayAddress(o);
  const proto = str(o.protocol) || 'xray';
  const outbound = JSON.parse(JSON.stringify(o)) as Record<string, unknown>;
  delete outbound.tag;
  return {
    id: randomUUID(),
    name: str(o.tag) || (address ? `${proto} ${address}:${port}` : proto),
    protocol: 'custom',
    address,
    port,
    customSettings: { outbound, engine: 'xray' },
    createdAt: now,
    updatedAt: now,
  };
}

/** 链式代理引用的前置 outbound tag：sockopt.dialerProxy 优先，其次旧式 proxySettings.tag。 */
function chainRef(o: Record<string, unknown>): string | undefined {
  return (
    str(obj(obj(o.streamSettings).sockopt).dialerProxy)?.trim() ||
    str(obj(o.proxySettings).tag)?.trim() ||
    undefined
  );
}

/**
 * xray outbounds[] → ServerConfig[]，逐条 try/catch，聚合 skipped/failed/warnings。
 * 两遍：先逐条映射并记 源 tag → 新节点 id；再把 dialerProxy / proxySettings 链映射为 ServerConfig.detour
 *（生成期 Xray 侧的 dialerProxy / proxySettings 一律被 FlowZ 接管，不映射即静默变直连）。
 */
export function parseXrayOutbounds(outbounds: unknown, now: string): XrayParseResult {
  const servers: ServerConfig[] = [];
  let skipped = 0;
  let failed = 0;
  const warnings: string[] = [];
  if (!Array.isArray(outbounds)) return { servers, skipped, failed, warnings };

  const passByReason = new Map<string, number>();
  const idByTag = new Map<string, string>();
  const chains: { server: ServerConfig; ref: string }[] = [];
  const addServer = (o: Record<string, unknown>, server: ServerConfig): void => {
    servers.push(server);
    const tag = str(o.tag)?.trim();
    if (tag && !idByTag.has(tag)) idByTag.set(tag, server.id);
    const ref = chainRef(o);
    if (ref) chains.push({ server, ref });
  };

  for (const ob of outbounds) {
    if (!ob || typeof ob !== 'object') {
      failed++;
      continue;
    }
    const o = ob as Record<string, unknown>;
    const proto = (str(o.protocol) || '').toLowerCase();
    if (!proto) {
      skipped++;
      continue;
    }
    if (XRAY_INTERNAL.has(proto)) continue;
    try {
      const reason = XRAY_SUPPORTED.has(proto) ? needsPassthrough(o) : `协议 ${proto}`;
      if (reason) {
        addServer(o, makeXrayCustomNode(o, now));
        passByReason.set(reason, (passByReason.get(reason) ?? 0) + 1);
        continue;
      }
      const server = mapXrayOutbound(o, proto, now);
      if (server) addServer(o, server);
      else failed++;
    } catch {
      failed++;
    }
  }

  // 第二遍：链式代理 → detour。前置 tag 不在已导入节点里（内部 outbound / 解析失败 / 拼写错）→ 告警而非静默丢链。
  for (const { server, ref } of chains) {
    const detour = idByTag.get(ref);
    if (detour && detour !== server.id) {
      server.detour = detour;
    } else {
      warnings.push(
        `节点「${server.name}」的链式代理前置「${ref}」不是已导入的节点，该链未保留（将直连服务器）`
      );
    }
  }

  if (passByReason.size > 0) {
    const total = [...passByReason.values()].reduce((a, b) => a + b, 0);
    const detail = [...passByReason.entries()].map(([p, c]) => `${p}(${c})`).join(', ');
    warnings.push(`${total} 个节点以「自定义 Xray JSON」原样导入，由 Xray 内核运行: ${detail}`);
  }
  return { servers, skipped, failed, warnings };
}
