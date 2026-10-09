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
