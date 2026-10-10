/**
 * REALITY 表单字段 ↔ ServerConfig 的纯映射（读默认值 / 提交 / publicKey 条件必填）——零 react / 别名运行时依赖
 *（shared 用相对路径），供 jest 直测。字段名沿用 vless 表单约定：tlsServerName（REALITY 目标 SNI）/ tlsFingerprint /
 * realityPublicKey / realityShortId / realitySpiderX / realityMldsa65。当前由 trojan 表单使用。
 */
import type { RefinementCtx } from 'zod';
import type { RealitySettings, ServerConfig, TlsSettings } from '../../../../shared/types';
import { realityFingerprint } from '../../../../shared/reality';

export { realityFingerprint, REALITY_DEFAULT_FINGERPRINT } from '../../../../shared/reality';

/** 表单安全层（小写口径，trojan 表单）。 */
export type FormSecurity = 'none' | 'tls' | 'reality';

/**
 * 存量 / 导入节点的 security → 表单枚举。大小写归一（导入可能是 'Reality'），缺省按 TLS（trojan 默认即 TLS）。
 * REALITY 必须原样保留：此前 trojan 表单只认 none/tls，编辑一个 trojan+REALITY 节点再保存会把它折成 TLS 并丢掉
 * realitySettings。
 */
export function normalizeFormSecurity(s: string | undefined): FormSecurity {
  const lower = (s || 'tls').toLowerCase();
  if (lower === 'none') return 'none';
  if (lower === 'reality') return 'reality';
  return 'tls';
}

export interface RealityFormValues {
  tlsServerName?: string;
  tlsFingerprint?: string;
  realityPublicKey?: string;
  realityShortId?: string;
  realitySpiderX?: string;
  realityMldsa65?: string;
}

/** 从既有节点读取 REALITY 专属字段默认值（新建 / 无 realitySettings → 空串）。 */
export function readRealityDefaults(server?: ServerConfig) {
  const r = server?.realitySettings;
  return {
    realityPublicKey: r?.publicKey || '',
    realityShortId: r?.shortId || '',
    realitySpiderX: r?.spiderX || '',
    realityMldsa65: r?.mldsa65Verify || '',
  };
}

/**
 * REALITY 的 tlsSettings 片段：目标 SNI + uTLS 指纹（none / 空 → chrome，见 shared/reality）。REALITY 不走证书链，
 * allowInsecure 恒 false；TLS 专属项（ALPN / 引擎 / spoof / ECH / 证书钉扎）不下发。
 */
export function buildRealityTlsSettings(values: RealityFormValues): TlsSettings {
  return {
    serverName: values.tlsServerName?.trim() || undefined,
    allowInsecure: false,
    fingerprint: realityFingerprint(values.tlsFingerprint),
  };
}

/** realitySettings 提交映射（spiderX / ML-DSA-65 仅 Xray 消费；后者非空即经 Xray 内核运行）。 */
export function buildRealitySettings(values: RealityFormValues): RealitySettings {
  return {
    publicKey: values.realityPublicKey?.trim() || '',
    shortId: values.realityShortId?.trim() || undefined,
    spiderX: values.realitySpiderX?.trim() || undefined,
    mldsa65Verify: values.realityMldsa65?.trim() || undefined,
  };
}

/**
 * security=reality 时 publicKey 必填（缺则两侧都无法握手：Xray 构造期拒收、sing-box 按空 public_key 起不来）。
 * 挂对象级（`.superRefine(requireRealityPublicKey(msg))`）：字段只在 REALITY 时渲染，切回 TLS 后残留空值不拦保存。
 */
export function requireRealityPublicKey(message: string) {
  return (v: { security?: string; realityPublicKey?: string }, ctx: RefinementCtx): void => {
    if (
      String(v.security ?? '').toLowerCase() === 'reality' &&
      !(v.realityPublicKey || '').trim()
    ) {
      ctx.addIssue({ code: 'custom', path: ['realityPublicKey'], message });
    }
  };
}
