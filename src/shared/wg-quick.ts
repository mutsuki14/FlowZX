/**
 * wg-quick .conf（INI）解析为 FlowZ WireGuard 节点字段（纯函数；UI 表单"粘贴 .conf 自动填充"用，无网络/FS）。
 * 单 peer 模型：peer 的 Endpoint(host:port) → {address, port}（= ServerConfig.address/port）；其余 → WireGuardSettings。
 * 缺必填（PrivateKey / PublicKey / Endpoint / Address）→ null（调用方提示改手填）。DNS 字段忽略（FlowZ 用自身 DNS）。
 * AmneziaWG 的 .conf（Amnezia 客户端导出，[Interface] 带 Jc / S1 / H1 / HeaderProtectionKey…）解析进 settings.amnezia。
 */
import type { WireGuardSettings } from './types';
import { amneziaFromRecord, amneziaIssues } from './amnezia-wg';

export interface ParsedWgQuick {
  address: string; // peer endpoint host（写入 ServerConfig.address）
  port: number; // peer endpoint port（写入 ServerConfig.port）
  settings: WireGuardSettings;
  /** AmneziaWG 字段值不合法 / 组合会被内核拒绝时的说明（非空也照常返回结果，由调用方提示）。 */
  warnings: string[];
}

function splitList(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** 解析 Endpoint "host:port"，支持 IPv6 `[::1]:port`、域名:port、IPv4:port。非法 → null。 */
function parseEndpoint(ep: string): { host: string; port: number } | null {
  const s = ep.trim();
  let host: string;
  let portStr: string;
  if (s.startsWith('[')) {
    const close = s.indexOf(']');
    if (close < 0) return null;
    host = s.slice(1, close);
    const rest = s.slice(close + 1);
    if (!rest.startsWith(':')) return null;
    portStr = rest.slice(1);
  } else {
    const idx = s.lastIndexOf(':');
    if (idx < 0) return null;
    host = s.slice(0, idx);
    portStr = s.slice(idx + 1);
  }
  const port = Number(portStr);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

export function parseWgQuickConf(raw: string | undefined | null): ParsedWgQuick | null {
  if (!raw || typeof raw !== 'string') return null;
  let section = '';
  const iface: Record<string, string> = {};
  const peer: Record<string, string> = {};
  for (const lineRaw of raw.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[(\w+)\]$/.exec(line);
    if (sec) {
      section = sec[1].toLowerCase();
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const val = line.slice(eq + 1).trim();
    // 取首个 [Peer]（多 peer 的客户端 .conf 罕见；首 peer 即服务器）。
    if (section === 'interface') {
      if (!(key in iface)) iface[key] = val;
    } else if (section === 'peer') {
      if (!(key in peer)) peer[key] = val;
    }
  }

  const privateKey = iface['privatekey'];
  const localAddress = splitList(iface['address']);
  const peerPublicKey = peer['publickey'];
  const endpoint = peer['endpoint'];
  if (!privateKey || !peerPublicKey || !endpoint || localAddress.length === 0) return null;
  const ep = parseEndpoint(endpoint);
  if (!ep) return null;

  const settings: WireGuardSettings = { privateKey, localAddress, peerPublicKey };
  if (peer['presharedkey']) settings.preSharedKey = peer['presharedkey'];
  const allowed = splitList(peer['allowedips']);
  if (allowed.length) settings.allowedIPs = allowed;
  const keepaliveRaw = (peer['persistentkeepalive'] ?? '').trim();
  const keepalive = Number(keepaliveRaw);
  if (Number.isFinite(keepalive) && keepalive > 0) settings.persistentKeepalive = keepalive;
  const mtu = Number(iface['mtu']);
  if (Number.isFinite(mtu) && mtu > 0) settings.mtu = mtu;

  // AmneziaWG：[Interface] 里的 Jc / S1 / H1 / I1 / HeaderProtectionKey… 以及 [Peer] 的区间 keepalive（"25-35"）。
  // 普通 WireGuard 键（PrivateKey / Address / DNS / MTU / ListenPort…）落在 unknown，忽略即可。
  const awgRec: Record<string, string> = {};
  for (const [k, v] of Object.entries(iface)) awgRec[k] = v;
  // 区间 keepalive 只有 AWG 3.0+ 认；纯数字仍按普通 WireGuard 处理。
  if (keepaliveRaw.includes('-')) awgRec['persistentkeepalive'] = keepaliveRaw;
  const awg = amneziaFromRecord(awgRec);
  const warnings = awg.invalid.map((k) => `AmneziaWG: invalid value for ${k}`);
  if (awg.settings) {
    settings.amnezia = awg.settings;
    warnings.push(...amneziaIssues(awg.settings));
    // 区间 keepalive：普通字段取下限，作为内核不支持 AWG 时的展示 / 回退值。
    if (awg.settings.persistentKeepalive && !settings.persistentKeepalive) {
      const lo = Number(awg.settings.persistentKeepalive.split('-')[0]);
      if (Number.isFinite(lo) && lo > 0) settings.persistentKeepalive = lo;
    }
  }

  return { address: ep.host, port: ep.port, settings, warnings };
}

/** 文本是否像 wg-quick .conf（有 [Interface] 与 [Peer] 段）。 */
export function looksLikeWgQuickConf(raw: string | undefined | null): boolean {
  if (!raw || typeof raw !== 'string') return false;
  return /^\s*\[Interface\]\s*$/im.test(raw) && /^\s*\[Peer\]\s*$/im.test(raw);
}
