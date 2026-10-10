/**
 * Xray 表单的纯逻辑（内核判定 / XHTTP extra 解析与校验）——从 xray-fields.tsx / field-schemas.ts 抽出，零 react /
 * 别名运行时依赖（shared 用相对路径），供 jest 直测。xray-fields.tsx / field-schemas.ts 原样 re-export，调用方不变。
 */
import type { RefinementCtx } from 'zod';
import type { ServerConfig } from '../../../../shared/types';
import { xrayRequirement, canUseXrayCore, type XrayRequirement } from '../../../../shared/xray';

/** extra 文本框：空或合法 JSON 对象。 */
export function parseXhttpExtra(
  text: string | undefined
): Record<string, unknown> | null | 'invalid' {
  const t = (text || '').trim();
  if (!t) return null;
  try {
    const o = JSON.parse(t);
    return o && typeof o === 'object' && !Array.isArray(o)
      ? (o as Record<string, unknown>)
      : 'invalid';
  } catch {
    return 'invalid';
  }
}

/**
 * xhttpExtra 非法 JSON 时拦提交（错误挂在该字段）——仅当传输为 XHTTP：该输入框只在 XHTTP 时渲染，RHF 保留
 * 已卸载字段的值、zodResolver 校验全量，字段级校验会让切到其它传输后残留的非法文本无提示地拦住保存；
 * 非 XHTTP 时 buildTransportSettings 本就不读该值。各表单 schema 以 `.superRefine(refineXhttpExtra)` 挂对象级。
 */
export function refineXhttpExtra(
  v: { network?: string; xhttpExtra?: string },
  ctx: RefinementCtx
): void {
  if (
    String(v.network ?? '').toLowerCase() === 'xhttp' &&
    parseXhttpExtra(v.xhttpExtra) === 'invalid'
  ) {
    ctx.addIssue({ code: 'custom', path: ['xhttpExtra'], message: 'invalid-json' });
  }
}

/**
 * Shadowsocks 表单的附加层字段（仅 SS 表单传）：加密方法 / 插件 / 是否启用 Shadow-TLS——
 * 决定 canUseXrayCore（插件、Shadow-TLS 为 sing-box 独有；流加密 Xray 已移除）。
 */
interface FormSsLayer {
  ssMethod?: string;
  ssPlugin?: string;
  shadowTls?: boolean;
}

/** 表单值中与 canUseXrayCore 相关的部分 → 最小 ServerConfig 片段（与提交映射同判据）。 */
function formLayerConfig(
  v: { protocol: string; network?: string; security?: string } & FormSsLayer
): Pick<
  ServerConfig,
  'protocol' | 'network' | 'security' | 'shadowsocksSettings' | 'shadowTlsSettings'
> {
  const isSs = v.protocol.toLowerCase() === 'shadowsocks';
  return {
    protocol: v.protocol as ServerConfig['protocol'],
    // SS 无传输层（恒 tcp）：不让残留 network 值影响判定。
    network: (isSs ? 'tcp' : (v.network || 'tcp').toLowerCase()) as ServerConfig['network'],
    // security 参与判定：REALITY 在 Xray 侧仅支持 RAW / XHTTP / gRPC（ws / httpupgrade + REALITY 不能切 Xray）。
    security: (v.security || '').toLowerCase() as ServerConfig['security'],
    shadowsocksSettings: isSs
      ? { method: v.ssMethod || '', password: '', plugin: v.ssPlugin || undefined }
      : undefined,
    shadowTlsSettings: v.shadowTls ? { password: '', sni: '' } : undefined,
  };
}

/** 以表单当前值构造最小 ServerConfig，求内核判定（与主进程生成期同一谓词）。 */
export function formXrayRequirement(
  v: {
    protocol: string;
    network?: string;
    encryption?: string;
    flow?: string;
    security?: string;
    mldsa65Verify?: string;
    /** 证书 SHA-256 钉扎（调用方仅在 TLS（非 Reality）时传入，与提交映射一致）。 */
    pinnedCert?: string;
    useXrayCore?: boolean;
  } & FormSsLayer
): XrayRequirement | null {
  return xrayRequirement({
    id: '',
    name: '',
    address: '',
    port: 0,
    ...formLayerConfig(v),
    encryption: v.encryption,
    flow: v.flow,
    realitySettings: v.mldsa65Verify
      ? { publicKey: '', mldsa65Verify: v.mldsa65Verify }
      : undefined,
    tlsSettings: v.pinnedCert ? { pinnedPeerCertSha256: v.pinnedCert } : undefined,
    useXrayCore: v.useXrayCore,
  });
}

/** 表单「当前协议是否允许手动切 Xray」：结构化协议 + 无 sing-box 独有附加层（复用 shared 谓词）。 */
export function formCanUseXray(
  v: { protocol: string; network?: string; security?: string } & FormSsLayer
): boolean {
  return canUseXrayCore({ id: '', name: '', address: '', port: 0, ...formLayerConfig(v) });
}
