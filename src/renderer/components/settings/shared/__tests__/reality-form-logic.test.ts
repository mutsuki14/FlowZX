/**
 * reality-form-logic 单测：trojan 表单 REALITY 的读默认值 / 提交映射往返 + publicKey 条件必填（真实 zodResolver）。
 * 回归对象：trojan 表单此前只认 none/tls，编辑一个 trojan+REALITY 节点再保存会被折成 TLS、realitySettings 丢失；
 * 以及 trojan 的 TLS 指纹缺省 'none' 带进 REALITY 会让两侧内核拒收。
 */
import * as z from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import type { ServerConfig } from '../../../../../shared/types';
import {
  normalizeFormSecurity,
  readRealityDefaults,
  realityFingerprint,
  buildRealityTlsSettings,
  buildRealitySettings,
  requireRealityPublicKey,
} from '../reality-form-logic';

describe('normalizeFormSecurity', () => {
  it('reality / tls / none 大小写归一；缺省与杂值 → tls（trojan 默认即 TLS）', () => {
    expect(normalizeFormSecurity('reality')).toBe('reality');
    expect(normalizeFormSecurity('Reality')).toBe('reality');
    expect(normalizeFormSecurity('NONE')).toBe('none');
    expect(normalizeFormSecurity('tls')).toBe('tls');
    expect(normalizeFormSecurity(undefined)).toBe('tls');
    expect(normalizeFormSecurity('xtls')).toBe('tls');
  });
});

describe('realityFingerprint', () => {
  it('none / 空 → chrome（两侧内核拒收无 uTLS 的 REALITY）；其余小写透传', () => {
    expect(realityFingerprint('none')).toBe('chrome');
    expect(realityFingerprint(undefined)).toBe('chrome');
    expect(realityFingerprint('  ')).toBe('chrome');
    expect(realityFingerprint('Firefox')).toBe('firefox');
    expect(realityFingerprint('random')).toBe('random');
  });
});

describe('REALITY 读 / 写往返（trojan 表单 getDefaultValues → handleSubmit 的 REALITY 部分）', () => {
  const node = {
    id: 'n',
    name: 'n',
    protocol: 'trojan',
    address: 'r.example.com',
    port: 443,
    password: 'pw',
    security: 'reality',
    tlsSettings: { serverName: 'www.microsoft.com', allowInsecure: false, fingerprint: 'firefox' },
    realitySettings: { publicKey: 'PBK', shortId: 'ab12', spiderX: '/s', mldsa65Verify: 'pq' },
  } as ServerConfig;

  /** 与 trojan-form.tsx getDefaultValues 的 REALITY 分支同构。 */
  const load = (s: ServerConfig) => ({
    security: normalizeFormSecurity(s.security),
    tlsServerName: s.tlsSettings?.serverName || '',
    tlsFingerprint: realityFingerprint(s.tlsSettings?.fingerprint),
    ...readRealityDefaults(s),
  });

  it('保存 = 原节点（security / tlsSettings / realitySettings 不丢、不折成 TLS）', () => {
    const v = load(node);
    expect(v.security).toBe('reality');
    expect(buildRealityTlsSettings(v)).toEqual(node.tlsSettings);
    expect(buildRealitySettings(v)).toEqual(node.realitySettings);
  });

  it('可选项留空 → undefined（不写空串）；前后空白 trim', () => {
    const v = load({
      ...node,
      tlsSettings: undefined,
      realitySettings: { publicKey: ' PBK ' },
    } as ServerConfig);
    expect(buildRealityTlsSettings(v)).toEqual({
      serverName: undefined,
      allowInsecure: false,
      fingerprint: 'chrome',
    });
    expect(buildRealitySettings(v)).toEqual({
      publicKey: 'PBK',
      shortId: undefined,
      spiderX: undefined,
      mldsa65Verify: undefined,
    });
  });

  it("从 TLS 切到 REALITY：TLS 缺省指纹 'none' 提交为 chrome；TLS 专属项（ALPN / ECH / 钉扎…）不带过来", () => {
    const tls = buildRealityTlsSettings({ tlsServerName: 'www.apple.com', tlsFingerprint: 'none' });
    expect(tls).toEqual({
      serverName: 'www.apple.com',
      allowInsecure: false,
      fingerprint: 'chrome',
    });
  });

  it('新建 / 非 REALITY 节点 → 空串默认值', () => {
    expect(readRealityDefaults()).toEqual({
      realityPublicKey: '',
      realityShortId: '',
      realitySpiderX: '',
      realityMldsa65: '',
    });
  });
});

describe('requireRealityPublicKey（对象级，经真实 zodResolver）', () => {
  const schema = z
    .object({
      security: z.enum(['none', 'tls', 'reality']),
      realityPublicKey: z.string().optional(),
    })
    .superRefine(requireRealityPublicKey('need-pbk'));
  const resolve = (values: { security: 'none' | 'tls' | 'reality'; realityPublicKey?: string }) =>
    zodResolver(schema)(values, undefined, {
      fields: {},
      shouldUseNativeValidation: false,
    } as never);

  it('REALITY + 空 / 纯空白 publicKey → 错误挂在 realityPublicKey', async () => {
    for (const realityPublicKey of ['', '  ', undefined]) {
      const r = await resolve({ security: 'reality', realityPublicKey });
      expect(Object.keys(r.errors)).toEqual(['realityPublicKey']);
      expect((r.errors as any).realityPublicKey.message).toBe('need-pbk');
    }
  });

  it('REALITY + publicKey → 通过；TLS / none 下残留空 publicKey 不拦保存', async () => {
    expect((await resolve({ security: 'reality', realityPublicKey: 'PBK' })).errors).toEqual({});
    expect((await resolve({ security: 'tls', realityPublicKey: '' })).errors).toEqual({});
    expect((await resolve({ security: 'none' })).errors).toEqual({});
  });
});
