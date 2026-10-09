/**
 * Xray sidecar「桥」规划（纯函数，零实例状态）：把需要 Xray 内核的节点映射为两侧配置的共同真值——
 *
 *  sing-box 侧：每节点一个 socks 出站（127.0.0.1:<port> + 凭据）+ 一个 `xray-dial-in` socks 入站（Xray 拨号回环）
 *              + 按 auth_user 钉死的回环路由（direct 或前置代理）；
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
 * 规划桥。ports 需 candidates.length + 1 个（末位给 xray-dial-in）。secret() 产随机凭据。
 * withDialer=false（无主核的临时测速会话）：Xray 直拨、不生成 dialer/回环入站，dialInbound.port=0。
 */
export function planXrayBridge(input: {
  candidates: readonly ServerConfig[];
  allServers: readonly ServerConfig[];
  ports: readonly number[];
  secret: () => string;
  withDialer?: boolean;
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
  // 每个前置代理目标一个 dialer（多个节点共用同一前置时复用）。
  const viaDialerByDetour = new Map<string, string>();

  input.candidates.forEach((server, i) => {
    let dialerTag: string | undefined = withDialer ? 'flowz-dialer' : undefined;
    const detourId = withDialer ? resolveDetour(server, byId, warn) : undefined;
    if (detourId) {
      detourOf.set(server.id, detourId);
      let tag = viaDialerByDetour.get(detourId);
      if (!tag) {
        const k = viaDialerByDetour.size;
        tag = `flowz-dialer-via-${k}`;
        const user = { username: `via-${k}`, password: input.secret() };
        viaDialerByDetour.set(detourId, tag);
        dialers.push({ tag, port: dialPort, user: user.username, pass: user.password });
        dialUsers.push(user);
        dialRoutes.push({ username: user.username, detourServerId: detourId });
      }
      dialerTag = tag;
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
