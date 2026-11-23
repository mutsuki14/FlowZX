/**
 * AmneziaWG 参数（wg-quick [Interface] 的 Jc / S1 / H1 / I1 / HeaderProtectionKey… 字段）的单一真值：
 * - wg-quick .conf 导入（shared/wg-quick）与节点表单的「AmneziaWG 参数」文本框共用同一解析 / 序列化；
 * - 配置加载时的清洗（ConfigManager）复用 normalizeAmneziaSettings。
 *
 * 字段名、取值形态对齐 awgm-box（hoaxisr/awgm-box）option/awg.go 与 amneziawg-go 的 UAPI：
 *  - Jc/Jmin/Jmax/S1–S4：非负整数；
 *  - H1–H4：整数或 "min-max" 区间（AWG 1.5+）；
 *  - I1–I5：CPS 包模板（如 `<b 0x...><r 16>`），原样透传；
 *  - 时序字段（RekeyAfterTime 等）：秒数或 "min-max" 区间；
 *  - HeaderProtectionKey：base64（32 字节）；设置时 S1–S4 必须都 ≥ 12（内核会拒绝，这里提前报）。
 * 纯函数，无 IO。
 */
import type { AmneziaWgSettings } from './types';

type NumKey = 'jc' | 'jmin' | 'jmax' | 's1' | 's2' | 's3' | 's4';
type StrKey =
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'i1'
  | 'i2'
  | 'i3'
  | 'i4'
  | 'i5'
  | 'headerProtectionKey'
  | 'contentPaddingAddition'
  | 'rekeyAfterTime'
  | 'rekeyTimeout'
  | 'rejectAfterTime'
  | 'keepaliveTimeout'
  | 'maxHandshakeAttempts'
  | 'persistentKeepalive';
type BoolKey = 'randomTrailers' | 'disableCookies';

interface FieldDef {
  key: NumKey | StrKey | BoolKey;
  /** wg-quick 里的写法（序列化用；解析按小写匹配）。 */
  conf: string;
  kind: 'int' | 'range' | 'template' | 'base64' | 'bool';
}

const RANGE_RE = /^\d+(?:\s*-\s*\d+)?$/;
const BASE64_32_RE = /^[A-Za-z0-9+/]{43}=$/;

/** 字段表（顺序即序列化顺序，与 Amnezia 客户端导出的 .conf 一致）。 */
export const AMNEZIA_FIELDS: readonly FieldDef[] = [
  { key: 'jc', conf: 'Jc', kind: 'int' },
  { key: 'jmin', conf: 'Jmin', kind: 'int' },
  { key: 'jmax', conf: 'Jmax', kind: 'int' },
  { key: 's1', conf: 'S1', kind: 'int' },
  { key: 's2', conf: 'S2', kind: 'int' },
  { key: 's3', conf: 'S3', kind: 'int' },
  { key: 's4', conf: 'S4', kind: 'int' },
  { key: 'h1', conf: 'H1', kind: 'range' },
  { key: 'h2', conf: 'H2', kind: 'range' },
  { key: 'h3', conf: 'H3', kind: 'range' },
  { key: 'h4', conf: 'H4', kind: 'range' },
  { key: 'i1', conf: 'I1', kind: 'template' },
  { key: 'i2', conf: 'I2', kind: 'template' },
  { key: 'i3', conf: 'I3', kind: 'template' },
  { key: 'i4', conf: 'I4', kind: 'template' },
  { key: 'i5', conf: 'I5', kind: 'template' },
  { key: 'headerProtectionKey', conf: 'HeaderProtectionKey', kind: 'base64' },
  { key: 'contentPaddingAddition', conf: 'ContentPaddingAddition', kind: 'range' },
  { key: 'rekeyAfterTime', conf: 'RekeyAfterTime', kind: 'range' },
  { key: 'rekeyTimeout', conf: 'RekeyTimeout', kind: 'range' },
  { key: 'rejectAfterTime', conf: 'RejectAfterTime', kind: 'range' },
  { key: 'keepaliveTimeout', conf: 'KeepaliveTimeout', kind: 'range' },
  { key: 'maxHandshakeAttempts', conf: 'MaxHandshakeAttempts', kind: 'range' },
  { key: 'randomTrailers', conf: 'RandomTrailers', kind: 'bool' },
  { key: 'disableCookies', conf: 'DisableCookies', kind: 'bool' },
  // [Peer] 字段：AWG 3.0 起可写区间（"25-35"），普通 WireGuard 的整数 keepalive 不进这里。
  { key: 'persistentKeepalive', conf: 'PersistentKeepalive', kind: 'range' },
];

const BY_CONF = new Map(AMNEZIA_FIELDS.map((f) => [f.conf.toLowerCase(), f]));

function parseBool(v: string): boolean | null {
  const s = v.trim().toLowerCase();
  if (['on', 'true', 'yes', '1'].includes(s)) return true;
  if (['off', 'false', 'no', '0'].includes(s)) return false;
  return null;
}

/** 单个值按字段类型校验 + 规范化；不合法 → null。 */
function coerce(f: FieldDef, raw: unknown): number | string | boolean | null {
  if (f.kind === 'bool') {
    if (typeof raw === 'boolean') return raw;
    return typeof raw === 'string' ? parseBool(raw) : null;
  }
  if (f.kind === 'int') {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
    return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : null;
  }
  const s = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!s) return null;
  if (f.kind === 'range') {
    if (!RANGE_RE.test(s)) return null;
    const [lo, hi] = s.split('-').map((x) => Number(x.trim()));
    if (hi !== undefined && hi < lo) return null;
    return s.replace(/\s+/g, '');
  }
  if (f.kind === 'base64') return BASE64_32_RE.test(s) ? s : null;
  return s; // template：原样
}

export interface AmneziaParseResult {
  settings: AmneziaWgSettings | undefined;
  /** 认得但值不合法的字段（wg-quick 写法）。 */
  invalid: string[];
  /** 不认识的键（表单文本框里出现时报错；.conf 导入里忽略，因为 [Interface] 还有 PrivateKey 等普通字段）。 */
  unknown: string[];
}

/**
 * 从「小写键 → 原始值」表里取出 AmneziaWG 字段。值为 0 / false 的字段视为未设置（内核默认即关闭），不入结果。
 * 全部未设置 → settings=undefined（即普通 WireGuard）。
 */
export function amneziaFromRecord(rec: Record<string, string>): AmneziaParseResult {
  const out: AmneziaWgSettings = {};
  const invalid: string[] = [];
  const unknown: string[] = [];
  for (const [k, v] of Object.entries(rec)) {
    const f = BY_CONF.get(k.toLowerCase());
    if (!f) {
      unknown.push(k);
      continue;
    }
    const val = coerce(f, v);
    if (val === null) {
      invalid.push(f.conf);
      continue;
    }
    if (val === 0 || val === false) continue;
    (out as Record<string, unknown>)[f.key] = val;
  }
  return { settings: Object.keys(out).length ? out : undefined, invalid, unknown };
}

/** 是否带有任何 AmneziaWG 参数（判定节点是否为 AmneziaWG）。 */
export function hasAmneziaParams(a: AmneziaWgSettings | undefined | null): boolean {
  return (
    !!a &&
    AMNEZIA_FIELDS.some((f) => {
      const v = (a as Record<string, unknown>)[f.key];
      return v !== undefined && v !== null && v !== '' && v !== 0 && v !== false;
    })
  );
}

/**
 * 内核会拒绝的组合（提前给出可读原因）：HeaderProtectionKey 要求 S1–S4 均 ≥ 12。
 * 返回问题描述列表（空 = 无问题）。
 */
export function amneziaIssues(a: AmneziaWgSettings | undefined): string[] {
  if (!a?.headerProtectionKey) return [];
  const small = (['s1', 's2', 's3', 's4'] as const).filter((k) => (a[k] ?? 0) < 12);
  return small.length
    ? [`HeaderProtectionKey requires ${small.map((k) => k.toUpperCase()).join(', ')} ≥ 12`]
    : [];
}

/** 序列化为 wg-quick 行（表单文本框回显用）。 */
export function amneziaToText(a: AmneziaWgSettings | undefined): string {
  if (!a) return '';
  const lines: string[] = [];
  for (const f of AMNEZIA_FIELDS) {
    const v = (a as Record<string, unknown>)[f.key];
    if (v === undefined || v === null || v === '' || v === 0 || v === false) continue;
    lines.push(`${f.conf} = ${f.kind === 'bool' ? 'on' : String(v)}`);
  }
  return lines.join('\n');
}

/** 解析表单文本框（`Key = Value` 每行一个，# 注释 / 空行忽略）。 */
export function amneziaFromText(text: string | undefined | null): AmneziaParseResult {
  const rec: Record<string, string> = {};
  const bad: string[] = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) {
      bad.push(line);
      continue;
    }
    rec[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  const r = amneziaFromRecord(rec);
  return { ...r, unknown: [...r.unknown, ...bad] };
}

/**
 * 配置加载清洗：只保留合法字段（类型 / 形态不符的丢弃），全空 → undefined。不 throw（脏字段不应让整份配置回落默认）。
 */
export function normalizeAmneziaSettings(raw: unknown): AmneziaWgSettings | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: AmneziaWgSettings = {};
  for (const f of AMNEZIA_FIELDS) {
    const v = (raw as Record<string, unknown>)[f.key];
    if (v === undefined || v === null) continue;
    const val = coerce(f, v);
    if (val === null || val === 0 || val === false) continue;
    (out as Record<string, unknown>)[f.key] = val;
  }
  return Object.keys(out).length ? out : undefined;
}
