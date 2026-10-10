/**
 * reality-form-logic 单测：trojan 表单 REALITY 的读默认值 / 提交映射往返 + publicKey 条件必填（真实 zodResolver）
 * + ML-DSA-65（pqv）按传输门控（trojan / vless 共用）。
 * 回归对象：trojan 表单此前只认 none/tls，编辑一个 trojan+REALITY 节点再保存会被折成 TLS、realitySettings 丢失；
 * trojan 的 TLS 指纹缺省 'none' 带进 REALITY 会让两侧内核拒收；ws / httpupgrade / HTTP/2 上填 pqv 会把节点送进
 * 必然拒收它的 Xray。
 */
import * as z from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import type { ServerConfig } from '../../../../../shared/types';
import { xrayRequirement } from '../../../../../shared/xray';
import {
  normalizeFormSecurity,
  readRealityDefaults,
  readTrojanSecurityDefaults,
  realityFingerprint,
  realityXrayExtrasSupported,
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

  // 读侧直接用 trojan-form.tsx getDefaultValues 展开的同一个函数（不复刻映射）；network 在表单里来自
  // readTransportDefaults（trojan 小写），此处按节点原值给出。
  const load = (s: ServerConfig) => ({
    network: (s.network || 'tcp').toLowerCase(),
    ...readTrojanSecurityDefaults(s),
  });

  it('保存 = 原节点（security / tlsSettings / realitySettings 不丢、不折成 TLS）', () => {
    for (const network of [undefined, 'tcp', 'grpc', 'xhttp'] as const) {
      const n = { ...node, network } as ServerConfig;
      const v = load(n);
      expect(v.security).toBe('reality');
      expect(buildRealityTlsSettings(v)).toEqual(node.tlsSettings);
      expect(buildRealitySettings('trojan', v)).toEqual(node.realitySettings);
    }
  });

  it('REALITY 指纹 none / 缺省 → chrome；TLS 节点指纹缺省 none、原值小写', () => {
    const fp = (security: string, fingerprint?: string) =>
      readTrojanSecurityDefaults({
        ...node,
        security,
        tlsSettings: { serverName: 'h', fingerprint },
      } as ServerConfig).tlsFingerprint;
    expect(fp('reality', 'none')).toBe('chrome');
    expect(fp('Reality', undefined)).toBe('chrome');
    expect(fp('tls', undefined)).toBe('none');
    expect(fp('tls', 'Firefox')).toBe('firefox');
  });

  it('新建（无节点）→ TLS + 指纹 none + 空 SNI / REALITY 字段（与表单新建初值一致）', () => {
    expect(readTrojanSecurityDefaults()).toEqual({
      security: 'tls',
      tlsServerName: '',
      tlsFingerprint: 'none',
      realityPublicKey: '',
      realityShortId: '',
      realitySpiderX: '',
      realityMldsa65: '',
    });
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
    expect(buildRealitySettings('trojan', v)).toEqual({
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

describe('ML-DSA-65（pqv）按传输门控：Xray 的 REALITY 仅支持 RAW / gRPC / XHTTP', () => {
  const values = (network: string) => ({
    network,
    realityPublicKey: 'PBK',
    realitySpiderX: '/s',
    realityMldsa65: ' pq ',
  });

  it.each([
    ['trojan', 'tcp', 'reality-pqv'],
    ['trojan', 'grpc', 'reality-pqv'],
    ['trojan', 'xhttp', 'xhttp'], // XHTTP 本就优先判 Xray
    ['vless', 'Tcp', 'reality-pqv'],
    ['vless', 'Grpc', 'reality-pqv'],
    ['vless', 'Xhttp', 'xhttp'],
  ])('%s + %s → 可用：pqv 提交（trim）→ 节点经 Xray（%s）', (protocol, network, reason) => {
    expect(realityXrayExtrasSupported(protocol, network)).toBe(true);
    const rs = buildRealitySettings(protocol, values(network));
    expect(rs.mldsa65Verify).toBe('pq');
    expect(
      xrayRequirement({
        id: 'n',
        name: 'n',
        address: 'a',
        port: 443,
        protocol,
        network: network.toLowerCase(),
        security: 'reality',
        realitySettings: rs,
      } as ServerConfig)
    ).toBe(reason);
  });

  it.each([
    ['trojan', 'ws'],
    ['trojan', 'httpupgrade'],
    ['trojan', 'http'],
    ['vless', 'Ws'],
    ['vless', 'HttpUpgrade'],
    ['vless', 'Http'],
  ])(
    '%s + %s → 不可用：残留 pqv 不提交 → 节点留在 sing-box；spiderX 原样保留（不改内核归属）',
    (protocol, network) => {
      expect(realityXrayExtrasSupported(protocol, network)).toBe(false);
      const rs = buildRealitySettings(protocol, values(network));
      expect(rs).toEqual({
        publicKey: 'PBK',
        shortId: undefined,
        spiderX: '/s',
        mldsa65Verify: undefined,
      });
      expect(
        xrayRequirement({
          id: 'n',
          name: 'n',
          address: 'a',
          port: 443,
          protocol,
          network: network.toLowerCase(),
          security: 'reality',
          realitySettings: rs,
        } as ServerConfig)
      ).toBeNull();
    }
  );

  it('缺省传输按 tcp（可用）', () => {
    expect(realityXrayExtrasSupported('trojan', undefined)).toBe(true);
    expect(buildRealitySettings('trojan', { realityMldsa65: 'pq' }).mldsa65Verify).toBe('pq');
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
