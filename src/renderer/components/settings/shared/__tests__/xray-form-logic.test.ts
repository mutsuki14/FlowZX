/**
 * xray-form-logic 单测：表单内核判定（证书钉扎 → Xray）+ xhttpExtra 对象级校验（仅 XHTTP 时拦）。
 * 后者经真实 zodResolver 走一遍：复现「XHTTP 下填了半截 extra、切到 WebSocket 后保存无反应」的回归。
 */
import * as z from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  formXrayRequirement,
  formCanUseXray,
  parseXhttpExtra,
  refineXhttpExtra,
} from '../xray-form-logic';

describe('formXrayRequirement', () => {
  it('TLS 证书钉扎 → tls-pinned-cert（表单徽标 / 开关置灰与生成期同一谓词）', () => {
    expect(
      formXrayRequirement({ protocol: 'vless', network: 'Tcp', security: 'Tls', pinnedCert: 'ab' })
    ).toBe('tls-pinned-cert');
    expect(
      formXrayRequirement({ protocol: 'trojan', network: 'ws', security: 'tls', pinnedCert: 'ab' })
    ).toBe('tls-pinned-cert');
    expect(
      formXrayRequirement({ protocol: 'vmess', network: 'Grpc', security: 'Tls', pinnedCert: 'ab' })
    ).toBe('tls-pinned-cert');
  });

  it('未填钉扎 / Reality / h2 → 不因钉扎走 Xray', () => {
    expect(formXrayRequirement({ protocol: 'vless', network: 'Tcp', security: 'Tls' })).toBeNull();
    expect(
      formXrayRequirement({
        protocol: 'vless',
        network: 'Tcp',
        security: 'Reality',
        pinnedCert: 'ab',
      })
    ).toBeNull();
    expect(
      formXrayRequirement({ protocol: 'vless', network: 'Http', security: 'Tls', pinnedCert: 'ab' })
    ).toBeNull();
  });

  it('其余判定不变：XHTTP / 手动勾选；formCanUseXray 拒 h2', () => {
    expect(formXrayRequirement({ protocol: 'vless', network: 'Xhttp', pinnedCert: 'ab' })).toBe(
      'xhttp'
    );
    expect(formXrayRequirement({ protocol: 'vmess', network: 'Tcp', useXrayCore: true })).toBe(
      'forced'
    );
    expect(formCanUseXray({ protocol: 'vless', network: 'Http' })).toBe(false);
    expect(formCanUseXray({ protocol: 'trojan', network: 'ws' })).toBe(true);
  });
});

describe('Shadowsocks 表单的「使用 Xray 内核」', () => {
  const ss = { protocol: 'shadowsocks', ssMethod: 'aes-256-gcm' };

  it('AEAD / SS2022 可切；勾选 → forced（与生成期同一谓词）', () => {
    expect(formCanUseXray(ss)).toBe(true);
    expect(formCanUseXray({ ...ss, ssMethod: '2022-blake3-aes-128-gcm' })).toBe(true);
    expect(formXrayRequirement({ ...ss, useXrayCore: true })).toBe('forced');
    expect(formXrayRequirement({ ...ss, useXrayCore: false })).toBeNull();
  });

  it('插件 / Shadow-TLS（开关开着）/ 流加密 → 不可切，勾了也不判 Xray', () => {
    for (const v of [
      { ...ss, ssPlugin: 'obfs-local' },
      { ...ss, shadowTls: true },
      { ...ss, ssMethod: 'aes-256-cfb' },
      { ...ss, ssMethod: 'rc4-md5' },
    ]) {
      expect(formCanUseXray(v)).toBe(false);
      expect(formXrayRequirement({ ...v, useXrayCore: true })).toBeNull();
    }
  });

  it('SS 无传输层：残留 network 值不影响判定（不会被判 xhttp / h2）', () => {
    expect(formXrayRequirement({ ...ss, network: 'xhttp' })).toBeNull();
    expect(formCanUseXray({ ...ss, network: 'http' })).toBe(true);
  });
});

describe('Trojan 表单的 REALITY', () => {
  it('纯 REALITY → sing-box（null）；填 ML-DSA-65 → reality-pqv；勾选 → forced', () => {
    const base = { protocol: 'trojan', network: 'tcp', security: 'reality' };
    expect(formXrayRequirement(base)).toBeNull();
    expect(formXrayRequirement({ ...base, mldsa65Verify: 'pq' })).toBe('reality-pqv');
    expect(formXrayRequirement({ ...base, useXrayCore: true })).toBe('forced');
    expect(formCanUseXray({ ...base, network: 'grpc' })).toBe(true);
  });

  it('REALITY + ws / httpupgrade：不可切 Xray（Xray 的 REALITY 仅 RAW / XHTTP / gRPC）；vless 同口径', () => {
    for (const protocol of ['trojan', 'vless']) {
      expect(formCanUseXray({ protocol, network: 'ws', security: 'reality' })).toBe(false);
      expect(formCanUseXray({ protocol, network: 'HttpUpgrade', security: 'Reality' })).toBe(false);
      expect(
        formXrayRequirement({ protocol, network: 'ws', security: 'reality', useXrayCore: true })
      ).toBeNull();
      expect(formCanUseXray({ protocol, network: 'ws', security: 'tls' })).toBe(true);
    }
  });
});

describe('refineXhttpExtra（xhttpExtra 仅 XHTTP 时校验）', () => {
  const schema = z
    .object({
      network: z.enum(['Tcp', 'Ws', 'Xhttp']),
      xhttpExtra: z.string().optional(),
    })
    .superRefine(refineXhttpExtra);
  const resolve = (values: { network: 'Tcp' | 'Ws' | 'Xhttp'; xhttpExtra?: string }) =>
    zodResolver(schema)(values, undefined, {
      fields: {},
      shouldUseNativeValidation: false,
    } as never);

  it('parseXhttpExtra：空 → null；对象 → 对象；非对象 / 坏 JSON → invalid', () => {
    expect(parseXhttpExtra('  ')).toBeNull();
    expect(parseXhttpExtra('{"xmux":{}}')).toEqual({ xmux: {} });
    expect(parseXhttpExtra('[1]')).toBe('invalid');
    expect(parseXhttpExtra('{"xmux": {')).toBe('invalid');
  });

  it('XHTTP + 非法 extra → 错误挂在 xhttpExtra 字段', async () => {
    const r = await resolve({ network: 'Xhttp', xhttpExtra: '{"xmux": {' });
    expect(Object.keys(r.errors)).toEqual(['xhttpExtra']);
  });

  it('切走 XHTTP 后残留的非法 extra 不再拦提交（该字段已不渲染、提交也不读它）', async () => {
    const r = await resolve({ network: 'Ws', xhttpExtra: '{"xmux": {' });
    expect(r.errors).toEqual({});
    expect(r.values).toMatchObject({ network: 'Ws' });
  });

  it('小写 network（trojan 表单口径）同样生效；合法 extra 通过', async () => {
    const lower = z
      .object({ network: z.string(), xhttpExtra: z.string().optional() })
      .superRefine(refineXhttpExtra);
    expect(lower.safeParse({ network: 'xhttp', xhttpExtra: 'nope' }).success).toBe(false);
    expect(lower.safeParse({ network: 'xhttp', xhttpExtra: '{"a":1}' }).success).toBe(true);
    expect(lower.safeParse({ network: 'tcp', xhttpExtra: 'nope' }).success).toBe(true);
  });
});
