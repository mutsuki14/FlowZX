/**
 * REALITY 的跨端小谓词（主进程两侧 builder 与渲染端表单共用）。纯模块：不 import electron/node。
 */

/** REALITY 的 uTLS 指纹缺省值（与 sing-box builder / Xray builder 既有缺省一致）。 */
export const REALITY_DEFAULT_FINGERPRINT = 'chrome';

/**
 * REALITY 必须伪装成真实浏览器的 ClientHello：指纹 'none'（FlowZ 口径「不挂 uTLS」）在两侧内核都被拒——
 * sing-box FATAL「unknown uTLS fingerprint: none」（整份配置起不来），Xray 侧 'none'→'unsafe' 报
 * 「invalid "fingerprint": unsafe」（均已真核实证）。Trojan 的 TLS 指纹缺省恰是 'none'，切到 REALITY 时
 * 原样带过来即中招 → 空 / none 一律归一为 chrome；其余值小写透传（random / randomized 等两侧都认）。
 */
export function realityFingerprint(fp: string | undefined): string {
  const v = (fp || '').trim().toLowerCase();
  return !v || v === 'none' ? REALITY_DEFAULT_FINGERPRINT : v;
}
