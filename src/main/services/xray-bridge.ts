/**
 * Xray sidecar「桥」规划（纯函数，零实例状态）：把需要 Xray 内核的节点映射为两侧配置的共同真值——
 *
 *  sing-box 侧：每节点一个 socks 出站（127.0.0.1:<port> + 凭据）+ 一个 `xray-dial-in` socks 入站（Xray 拨号回环）
 *              + 按 auth_user 钉死的回环路由（direct 或前置代理；需 TLS 分片的节点另挂 tls_fragment）；
 *  Xray 侧    ：每节点一个 socks 入站（同端口/凭据）→ 节点 outbound（sockopt.dialerProxy → dialer）
 *              + dialer 出站（socks 回 sing-box 的 xray-dial-in，用户名决定 sing-box 侧走 direct 还是前置代理）。
 *
 * 前置代理(detour) 语义与 sing-box 节点一致（见 singbox-outbound-builder.buildOutbounds）：目标不存在→忽略；
 * 成环→忽略并告警；目标为组网 endpoint（WireGuard/Tailscale）→忽略并告警（UI 亦不列其为候选）。
 */
import type { ServerConfig } from '../../shared/types';
import { isEndpointProtocol } from '../../shared/endpoint-routes';
import {
  xrayInboundTag,
  xrayOutboundTag,
  type XrayBridgeNode,
  type XrayDialer,
} from './xray-config-builder';

/** sing-box 侧 Xray 回环拨号入站 tag / 直连出站 tag（保留 tag，见 singbox-config-helpers.RESERVED_OUTBOUND_TAGS）。 */
export const XRAY_DIAL_INBOUND_TAG = 'xray-dial-in';
export const XRAY_DIAL_DIRECT_TAG = 'xray-dial-direct';

export interface XrayDialRoute {
  /** xray-dial-in 的认证用户名（sing-box route rule auth_user 匹配）。 */
  username: string;
  /** 前置代理节点 id；缺省 = 直连（xray-dial-direct）。 */
  detourServerId?: string;
  /** 经此用户的拨号流量在 sing-box 侧挂 tls_fragment 路由选项（切分 Xray 自身的 TLS/REALITY ClientHello）。 */
  tlsFragment?: boolean;
}

export interface XrayBridgePlan {
  nodes: XrayBridgeNode[];
  dialers: XrayDialer[];
  dialInbound: { port: number; users: { username: string; password: string }[] };
  dialRoutes: XrayDialRoute[];
  /** xray 节点 id → 前置代理节点 id（剔除级联用：前置被剔 → 本节点一并剔，绝不静默改直连）。 */
  detourOf: Map<string, string>;
}

/**
 * 节点经 Xray 拨出的 TLS/REALITY ClientHello 是否应分片（全局 tlsFragment 或节点 tlsSettings.fragment）。
 * 结构化节点：安全层判据与 xray-config-builder.buildStreamSettings 一致（reality / tls / 存在 tlsSettings / trojan 恒 TLS）；
 * 自定义 Xray JSON：只认全局开关，且仅 streamSettings.security 为 tls/reality、非 QUIC 系（hysteria）时（其余底层
 * 传输无从细究，保守）。
 */
export function xrayNodeWantsTlsFragment(server: ServerConfig, globalFragment: boolean): boolean {
  if (server.protocol.toLowerCase() === 'custom') {
    const ob = (server.customSettings?.outbound ?? {}) as Record<string, unknown>;
    const stream = (ob.streamSettings ?? {}) as Record<string, unknown>;
    const lower = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : '');
    const sec = lower(stream.security);
    const quic = lower(ob.protocol).startsWith('hysteria') || lower(stream.network) === 'hysteria';
    return globalFragment && !quic && (sec === 'tls' || sec === 'reality');
  }
  if (!globalFragment && !server.tlsSettings?.fragment) return false;
  const sec = (server.security || '').toLowerCase();
  return (
    sec === 'reality' ||
    sec === 'tls' ||
    !!server.tlsSettings ||
    server.protocol.toLowerCase() === 'trojan'
  );
}

/**
 * 规划桥。ports 需 candidates.length + 1 个（末位给 xray-dial-in）。secret() 产随机凭据。
 * withDialer=false（无主核的临时测速会话）：Xray 直拨、不生成 dialer/回环入站，dialInbound.port=0。
 * tlsFragment = 全局 TLS 分片开关（UserConfig.tlsFragment）：需分片的节点改用带 `-frag` 后缀的独立 dialer 用户，
 * sing-box 侧按该用户的回环路由挂 tls_fragment（见 xrayNodeWantsTlsFragment / singbox-route-builder A0）。
 */
export function planXrayBridge(input: {
  candidates: readonly ServerConfig[];
  allServers: readonly ServerConfig[];
  ports: readonly number[];
  secret: () => string;
  withDialer?: boolean;
  tlsFragment?: boolean;
  warn?: (msg: string) => void;
}): XrayBridgePlan {
  const withDialer = input.withDialer !== false;
  const warn = input.warn ?? (() => {});
  const byId = new Map(input.allServers.map((s) => [s.id, s]));
  if (input.ports.length < input.candidates.length + (withDialer ? 1 : 0)) {
    throw new Error('Xray 桥端口不足');
  }
  const dialPort = withDialer ? input.ports[input.candidates.length] : 0;
  const nodes: XrayBridgeNode[] = [];
  const dialers: XrayDialer[] = [];
  const dialUsers: { username: string; password: string }[] = [];
  const dialRoutes: XrayDialRoute[] = [];
  const detourOf = new Map<string, string>();

  // 直连 dialer（所有无前置代理的节点共用）。
  const directUser = { username: 'direct', password: input.secret() };
  if (withDialer) {
    dialers.push({
      tag: 'flowz-dialer',
      port: dialPort,
      user: directUser.username,
      pass: directUser.password,
    });
    dialUsers.push(directUser);
    dialRoutes.push({ username: directUser.username });
  }
  // 其余 dialer 按（前置代理目标, 是否 TLS 分片）复用：多个节点共用同一前置时共用一个 dialer；分片节点单独一个
  // 用户，sing-box 才能只对它们的 ClientHello 挂 tls_fragment。via 序号按前置目标分配（分片与否同号）。
  const dialerByKey = new Map<string, string>([[JSON.stringify([null, false]), 'flowz-dialer']]);
  const viaIndex = new Map<string, number>();
  const dialerFor = (detourId: string | undefined, fragment: boolean): string => {
    const key = JSON.stringify([detourId ?? null, fragment]);
    const existing = dialerByKey.get(key);
    if (existing) return existing;
    let base = 'flowz-dialer';
    let userBase = 'direct';
    if (detourId) {
      const k = viaIndex.get(detourId) ?? viaIndex.size;
      viaIndex.set(detourId, k);
      base = `flowz-dialer-via-${k}`;
      userBase = `via-${k}`;
    }
    const tag = fragment ? `${base}-frag` : base;
    const user = { username: fragment ? `${userBase}-frag` : userBase, password: input.secret() };
    dialerByKey.set(key, tag);
    dialers.push({ tag, port: dialPort, user: user.username, pass: user.password });
    dialUsers.push(user);
    dialRoutes.push({
      username: user.username,
      ...(detourId ? { detourServerId: detourId } : {}),
      ...(fragment ? { tlsFragment: true } : {}),
    });
    return tag;
  };

  input.candidates.forEach((server, i) => {
    let dialerTag: string | undefined;
    if (withDialer) {
      const detourId = resolveDetour(server, byId, warn);
      if (detourId) detourOf.set(server.id, detourId);
      dialerTag = dialerFor(detourId, xrayNodeWantsTlsFragment(server, input.tlsFragment === true));
    }
    nodes.push({
      serverId: server.id,
      inboundTag: xrayInboundTag(server.id),
      outboundTag: xrayOutboundTag(server.id),
      port: input.ports[i],
      user: 'flowz',
      pass: input.secret(),
      dialerTag,
    });
  });

  return {
    nodes,
    dialers,
    dialInbound: { port: dialPort, users: dialUsers },
    dialRoutes,
    detourOf,
  };
}

/** 有效前置代理 id（不存在 / 成环 / endpoint → undefined + 告警）。 */
function resolveDetour(
  server: ServerConfig,
  byId: ReadonlyMap<string, ServerConfig>,
  warn: (msg: string) => void
): string | undefined {
  if (!server.detour || !byId.has(server.detour)) return undefined;
  const seen = new Set<string>([server.id]);
  let cur: string | undefined = server.detour;
  while (cur) {
    if (seen.has(cur)) {
      warn(`检测到代理链成环，已跳过 detour: ${server.name}`);
      return undefined;
    }
    seen.add(cur);
    cur = byId.get(cur)?.detour;
  }
  const target = byId.get(server.detour)!;
  if (isEndpointProtocol(target.protocol)) {
    warn(
      `endpoint 节点（WireGuard/Tailscale）不支持作为前置代理(detour)目标，已忽略「${server.name}」的代理链`
    );
    return undefined;
  }
  return server.detour;
}
