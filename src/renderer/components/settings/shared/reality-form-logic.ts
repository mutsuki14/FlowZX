/**
 * REALITY 表单字段 ↔ ServerConfig 的纯映射（读默认值 / 提交 / publicKey 条件必填）——零 react / 别名运行时依赖
 *（shared 用相对路径），供 jest 直测。字段名沿用 vless 表单约定：tlsServerName（REALITY 目标 SNI）/ tlsFingerprint /
 * realityPublicKey / realityShortId / realitySpiderX / realityMldsa65。trojan 表单全量使用；vless 表单复用
 * buildRealitySettings / realityXrayExtrasSupported。
 */
import type { RefinementCtx } from 'zod';
import type { RealitySettings, ServerConfig, TlsSettings } from '../../../../shared/types';
import { realityFingerprint } from '../../../../shared/reality';
import { formCanUseXray } from './xray-form-logic';

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
  /** 传输（大小写不限：trojan 表单小写、vless 表单首字母大写）——决定 ML-DSA-65 能否提交，见 buildRealitySettings。 */
  network?: string;
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
 * trojan 表单安全层相关默认值（getDefaultValues 两个分支共用，往返单测直接调用本函数而非复刻映射）：
 * security 归一 + SNI + 指纹 + REALITY 专属字段。指纹：TLS 缺省不挂 uTLS（none）；REALITY 必须挂 → 缺省 / none
 * 归 chrome（与两侧 builder 同口径）。新建（无 server）→ TLS + none + 空 REALITY 字段。
 */
export function readTrojanSecurityDefaults(server?: ServerConfig) {
  const security = normalizeFormSecurity(server?.security);
  const fp = server?.tlsSettings?.fingerprint;
  return {
    security,
    tlsServerName: server?.tlsSettings?.serverName || '',
    tlsFingerprint: security === 'reality' ? realityFingerprint(fp) : (fp || 'none').toLowerCase(),
    ...readRealityDefaults(server),
  };
}

/**
 * REALITY 的 Xray 扩展（spiderX / ML-DSA-65 验证公钥，sing-box 均不消费）能否生效 = 该传输上的 REALITY 节点能否
 * 切到 Xray：Xray 的 REALITY 仅支持 RAW / gRPC / XHTTP，ws / httpupgrade 上被 `xray run -test` 拒收（「REALITY only
 * supports RAW, XHTTP and gRPC」），HTTP/2 则 Xray 已整体移除。判据复用 canUseXrayCore（与「使用 Xray 内核」开关、
 * 证书钉扎同一谓词），表单据此显示 / 隐藏扩展字段、决定 ML-DSA-65 是否提交。
 */
export function realityXrayExtrasSupported(protocol: string, network: string | undefined): boolean {
  return formCanUseXray({ protocol, network, security: 'reality' });
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

/**
 * realitySettings 提交映射（spiderX / ML-DSA-65 仅 Xray 消费；后者非空即经 Xray 内核运行，xrayRequirement=reality-pqv）。
 * ML-DSA-65 仅在传输能承载 Xray REALITY 时提交（与证书钉扎同口径）：ws / httpupgrade / HTTP/2 上残留的 pqv 会把节点
 * 送进必然拒收它的 Xray（启动时被 Xray 闸门剔除，或选中时起不来）。该字段在这些传输上不渲染，但 RHF 保留已卸载字段
 * 的值 → 必须在提交侧丢弃。spiderX 不改变内核归属（sing-box 忽略），原样保留以免编辑一次就丢掉导入值。
 */
export function buildRealitySettings(protocol: string, values: RealityFormValues): RealitySettings {
  return {
    publicKey: values.realityPublicKey?.trim() || '',
    shortId: values.realityShortId?.trim() || undefined,
    spiderX: values.realitySpiderX?.trim() || undefined,
    mldsa65Verify: realityXrayExtrasSupported(protocol, values.network)
      ? values.realityMldsa65?.trim() || undefined
      : undefined,
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
