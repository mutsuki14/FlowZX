/**
 * Xray sidecar 真核门 —— 把「Xray 独有协议组合」节点交**随包 Xray 内核**（`xray run -test`）与**随包 sing-box**
 *（`sing-box check`）双重校验，覆盖单测 toEqual 管不到的值域与跨字段引用：
 *  - Xray 侧：VLESS-XHTTP-REALITY-ENC / RAW-REALITY-Vision-ENC / XHTTP-TLS 证书钉扎 / Reality ML-DSA-65 /
 *    vision-udp443 / VMess-XHTTP / Trojan-XHTTP-REALITY / SS2022 强制 Xray / 自定义 Xray JSON（XHTTP 上下行分离）
 *    + 前置代理链（Xray→sing-box 节点、Xray→Xray 节点）+ Xray JSON 订阅（v2ray-json 配置数组）的解析产物；
 *  - sing-box 侧：socks 桥出站 / xray-dial-in 回环入站（users）/ auth_user 钉死路由 / xray-dial-direct 出站
 *    在完整 generateSingBoxConfig 产物中引用完整、check 通过。
 *
 * 与 singbox-check-gate 同一调用位置与语义：不在默认 `npm test`（需随包二进制，已 gitignore），由
 * `npm run test:core-gate`（打包链必经、先跑 fetch:core）执行；二进制缺失即硬 fail，无豁免。
 * 门的自检：最后一个用例注入一个 Xray 拒收的节点，要求 `xray run -test` 必须失败且能归因到该节点的 tag。
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-xraycheck-'));
jest.mock('electron', () => ({
  app: {
    getPath: () => TMP,
    getVersion: () => '9.9.9',
    isPackaged: false,
    getAppPath: () => TMP,
  },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));

import { ProxyManager } from '../ProxyManager';
import type { UserConfig, ServerConfig } from '../../../shared/types';
import type { SingBoxConfig } from '../singbox-config-types';
import { canUseXrayCore, requiresXrayCore } from '../../../shared/xray';
import { SubscriptionService } from '../SubscriptionService';
import { ProtocolParser } from '../ProtocolParser';
import { V2RAY_JSON_NODE_NAMES, v2rayJsonSubscription } from './xray-subscription-fixtures';
import {
  buildXrayConfig,
  buildXrayOutbound,
  parseXrayFailedOutboundTag,
  validateShadowsocks2022Password,
  validateVlessEncryption,
  xrayOutboundTag,
} from '../xray-config-builder';
import { planXrayBridge } from '../xray-bridge';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
function platformDir(): string {
  if (process.platform === 'win32') return 'resources/win';
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'resources/mac-arm64' : 'resources/mac-x64';
  }
  return 'resources/linux';
}
const EXE = process.platform === 'win32' ? '.exe' : '';
const XRAY = path.join(REPO_ROOT, platformDir(), `xray${EXE}`);
const SINGBOX = path.join(REPO_ROOT, platformDir(), `sing-box${EXE}`);
const present = (p: string): boolean => {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

function run(bin: string, args: string[]): { code: number; out: string } {
  if (!present(bin)) {
    throw new Error(
      `随包内核缺失或不可执行（${bin}）。本门只在 fetch:core 之后的链路上运行（npm run test:core-gate），走到这里说明环境坏了。`
    );
  }
  try {
    const out = execFileSync(bin, args, { stdio: 'pipe', timeout: 30_000 }).toString();
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      code: err.status ?? -1,
      out: `${err.stdout?.toString() ?? ''}\n${err.stderr?.toString() ?? ''}`,
    };
  }
}

function xrayTest(config: unknown, name: string): { code: number; out: string } {
  const file = path.join(TMP, `${name}.xray.json`);
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  return run(XRAY, ['run', '-test', '-c', file]);
}

function singboxCheck(config: SingBoxConfig, name: string): { code: number; out: string } {
  const file = path.join(TMP, `${name}.sb.json`);
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  return run(SINGBOX, ['check', '-c', file]);
}

// ── 语料 ─────────────────────────────────────────────────────────────────────────
const UUID = '8a502aeb-b677-4fc6-bdbf-0b11435a99ec';
const PBK = 'e5pKf8zQy_I1P-H_GcWVubf9EYtWT6gX_6Q5exYFvi0';
const ENC_X25519 = 'mlkem768x25519plus.native.0rtt.QxKoobAnmyilC09GlvGiUCWXF1PrxmC7l2lR72ThGSE';
const ENC_XORPUB_1RTT =
  'mlkem768x25519plus.xorpub.1rtt.QxKoobAnmyilC09GlvGiUCWXF1PrxmC7l2lR72ThGSE';

function corpus(pqv: string): ServerConfig[] {
  const base = (id: string, over: Partial<ServerConfig>): ServerConfig =>
    ({
      id,
      name: id,
      protocol: 'vless',
      address: `${id}.example.com`,
      port: 443,
      uuid: UUID,
      ...over,
    }) as ServerConfig;
  return [
    base('vless-xhttp-reality-enc', {
      encryption: ENC_X25519,
      network: 'xhttp',
      security: 'reality',
      xhttpSettings: { path: '/xh', mode: 'auto', extra: { xmux: { maxConcurrency: '16-32' } } },
      tlsSettings: { serverName: 'www.microsoft.com', fingerprint: 'chrome' },
      realitySettings: { publicKey: PBK, shortId: '0123abcd', spiderX: '/' },
    }),
    base('vless-xhttp-tls-pinned-enc', {
      encryption: ENC_XORPUB_1RTT,
      network: 'xhttp',
      security: 'tls',
      xhttpSettings: { path: '/tl', mode: 'packet-up', host: 'cdn.example.com' },
      tlsSettings: {
        serverName: 'cdn.example.com',
        alpn: ['h2', 'http/1.1'],
        allowInsecure: true, // Xray 26 已移除 → 必须不下发，否则本门 FATAL
        pinnedPeerCertSha256: 'eb02b17c08af74197b80063fadfc9729f92d74bf4c37d81acdb0379a0f903a10',
      },
    }),
    base('vless-raw-reality-vision-enc', {
      encryption: ENC_X25519,
      flow: 'xtls-rprx-vision',
      security: 'reality',
      tlsSettings: { serverName: 'www.example.com', fingerprint: 'safari' },
      realitySettings: { publicKey: PBK, shortId: 'ab' },
    }),
    base('vless-reality-pqv', {
      flow: 'xtls-rprx-vision',
      security: 'reality',
      tlsSettings: { serverName: 'www.example.com' },
      realitySettings: { publicKey: PBK, shortId: '', mldsa65Verify: pqv },
    }),
    base('vless-vision-udp443', {
      flow: 'xtls-rprx-vision-udp443',
      security: 'tls',
      tlsSettings: { serverName: 'v.example.com', fingerprint: 'none' },
    }),
    base('vless-xhttp-ech', {
      network: 'xhttp',
      security: 'tls',
      tlsSettings: {
        serverName: 'e.example.com',
        ech: true,
        echConfig: 'https://1.1.1.1/dns-query',
      },
    }),
    base('vmess-xhttp-tls', {
      protocol: 'vmess',
      vmessSecurity: 'auto',
      network: 'xhttp',
      security: 'tls',
      xhttpSettings: { path: '/vm', mode: 'stream-one' },
      tlsSettings: { serverName: 'vm.example.com', alpn: ['h2'] },
    }),
    base('trojan-xhttp-reality', {
      protocol: 'trojan',
      uuid: undefined,
      password: 'pw',
      network: 'xhttp',
      security: 'reality',
      xhttpSettings: { path: '/tj', mode: 'stream-up' },
      tlsSettings: { serverName: 'www.apple.com' },
      realitySettings: { publicKey: PBK, shortId: '01' },
    }),
    base('ss2022-forced', {
      protocol: 'shadowsocks',
      uuid: undefined,
      useXrayCore: true,
      shadowsocksSettings: {
        method: '2022-blake3-aes-128-gcm',
        password: 'AAAAAAAAAAAAAAAAAAAAAA==',
      },
    }),
    base('vless-ws-forced', {
      useXrayCore: true,
      network: 'ws',
      security: 'tls',
      wsSettings: { path: '/ws?ed=2048', headers: { Host: 'w.example.com' } },
      tlsSettings: { serverName: 'w.example.com' },
    }),
    {
      id: 'custom-xhttp-split',
      name: 'custom-xhttp-split',
      protocol: 'custom',
      address: '',
      port: 0,
      customSettings: {
        engine: 'xray',
        outbound: {
          protocol: 'vless',
          settings: {
            vnext: [
              { address: 'up.example.com', port: 443, users: [{ id: UUID, encryption: 'none' }] },
            ],
          },
          streamSettings: {
            network: 'xhttp',
            security: 'reality',
            realitySettings: {
              serverName: 'www.microsoft.com',
              publicKey: PBK,
              fingerprint: 'chrome',
            },
            xhttpSettings: {
              path: '/up',
              mode: 'packet-up',
              extra: {
                downloadSettings: {
                  address: 'down.example.com',
                  port: 443,
                  network: 'xhttp',
                  security: 'tls',
                  tlsSettings: { serverName: 'down.example.com' },
                  xhttpSettings: { path: '/down' },
                },
              },
            },
          },
        },
      },
    } as ServerConfig,
    // 前置代理链：Xray 节点 → sing-box 原生节点（hy2）；Xray 节点 → Xray 节点。
    {
      id: 'hy2-hop',
      name: 'hy2-hop',
      protocol: 'hysteria2',
      address: 'hop.example.com',
      port: 443,
      password: 'p',
      security: 'tls',
    } as ServerConfig,
    base('xhttp-via-hy2', {
      network: 'xhttp',
      security: 'tls',
      tlsSettings: { serverName: 'c.example.com' },
      detour: 'hy2-hop',
    }),
    base('xhttp-via-xray', {
      network: 'xhttp',
      security: 'tls',
      tlsSettings: { serverName: 'd.example.com' },
      detour: 'vless-xhttp-reality-enc',
    }),
  ];
}

function userConfig(servers: ServerConfig[]): UserConfig {
  return {
    subscriptions: [],
    servers,
    selectedServerId: servers[0].id,
    proxyMode: 'smart',
    proxyModeType: 'systemProxy',
    tunConfig: { mtu: 1350, stack: 'auto', autoRoute: true, strictRoute: true },
    customRules: [],
    appRules: [],
    customAppPresets: [],
    autoStart: false,
    silentStart: false,
    autoConnect: false,
    minimizeToTray: false,
    mixedPort: 7890,
    logLevel: 'info',
    clashApiSecret: 'testsecret',
  } as unknown as UserConfig;
}

jest.setTimeout(120_000);

let PQV = '';
beforeAll(() => {
  const r = run(XRAY, ['mldsa65']);
  const m = /Verify:\s*(\S+)/.exec(r.out);
  if (!m) throw new Error(`xray mldsa65 输出无法解析：${r.out}`);
  PQV = m[1];
});

afterAll(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('Xray 真核门 — 前置', () => {
  it('随包 Xray 与 sing-box 存在且可执行（缺失即硬 fail）', () => {
    expect(present(XRAY)).toBe(true);
    expect(present(SINGBOX)).toBe(true);
    expect(run(XRAY, ['version']).out).toMatch(/^Xray \d+\.\d+\.\d+/m);
  });
});

describe('Xray 侧：xray run -test', () => {
  it('全语料（含前置代理链 dialer）整份配置通过', () => {
    const servers = corpus(PQV);
    const xrayNodes = servers.filter((s) => requiresXrayCore(s));
    expect(xrayNodes.map((s) => s.id)).not.toContain('hy2-hop');
    const plan = planXrayBridge({
      candidates: xrayNodes,
      allServers: servers,
      ports: xrayNodes.map((_, i) => 30000 + i).concat(31000),
      secret: () => 's3cret',
    });
    // 自检：前置链确实进了规划（否则「通过」不含 dialer 形态）。
    expect(plan.detourOf.get('xhttp-via-hy2')).toBe('hy2-hop');
    expect(plan.detourOf.get('xhttp-via-xray')).toBe('vless-xhttp-reality-enc');
    expect(plan.dialers.map((d) => d.tag)).toEqual([
      'flowz-dialer',
      'flowz-dialer-via-0',
      'flowz-dialer-via-1',
    ]);
    const cfg = buildXrayConfig({
      servers: new Map(servers.map((s) => [s.id, s])),
      nodes: plan.nodes,
      dialers: plan.dialers,
      logLevel: 'warning',
    });
    const r = xrayTest(cfg, 'corpus');
    if (r.code !== 0) throw new Error(`xray run -test 未通过：\n${r.out}`);
  });
});

describe('sing-box 侧：完整 generateSingBoxConfig + sing-box check', () => {
  it('Xray 节点以 socks 桥出站进入 selector，回环入站/路由引用完整，check 通过', () => {
    const servers = corpus(PQV);
    const svc: any = new ProxyManager(
      undefined,
      undefined,
      path.join(TMP, 'cfg.json'),
      '/fake/sing-box'
    );
    svc.coreVersion = '1.14.0';
    const sb = svc.generateSingBoxConfig(userConfig(servers)) as SingBoxConfig;

    const sel = sb.outbounds.find((o) => o.tag === 'proxy-selector');
    for (const s of servers.filter((x) => requiresXrayCore(x))) {
      const ob = sb.outbounds.find((o) => o.tag === s.name);
      expect(ob?.type).toBe('socks');
      expect(ob?.server).toBe('127.0.0.1');
      expect(sel?.outbounds).toContain(s.name);
    }
    expect(sb.outbounds.find((o) => o.tag === 'hy2-hop')?.type).toBe('hysteria2');
    expect(sb.outbounds.find((o) => o.tag === 'xray-dial-direct')?.type).toBe('direct');
    const dialIn = sb.inbounds.find((i) => i.tag === 'xray-dial-in');
    expect(dialIn?.type).toBe('socks');
    expect(dialIn?.users?.length).toBe(3);
    const dialRules = (sb.route?.rules ?? []).filter((r) =>
      ([] as string[]).concat(r.inbound ?? []).includes('xray-dial-in')
    );
    expect(dialRules.map((r) => r.outbound ?? r.action)).toEqual([
      'xray-dial-direct',
      'hy2-hop',
      'vless-xhttp-reality-enc',
      'reject',
    ]);

    const r = singboxCheck(sb, 'full');
    if (r.code !== 0) throw new Error(`sing-box check 未通过：\n${r.out}`);
  });
});

describe('dialer 接管 / TLS 分片 / 预校验 × 真核', () => {
  it('penetrate + echSockopt.dialerProxy：真 Xray 接受；XHTTP 下行腿与 ECH 查询均经 dialer', () => {
    const servers = corpus(PQV);
    const xrayNodes = servers.filter((s) => requiresXrayCore(s));
    const plan = planXrayBridge({
      candidates: xrayNodes,
      allServers: servers,
      ports: xrayNodes.map((_, i) => 32000 + i).concat(33000),
      secret: () => 's3cret',
    });
    const cfg = buildXrayConfig({
      servers: new Map(servers.map((s) => [s.id, s])),
      nodes: plan.nodes,
      dialers: plan.dialers,
      logLevel: 'warning',
    });
    for (const ob of cfg.outbounds.filter((o) => o.tag.startsWith('n-'))) {
      expect((ob.streamSettings as any).sockopt).toMatchObject({ penetrate: true });
    }
    const ech = cfg.outbounds.find((o) => o.tag === xrayOutboundTag('vless-xhttp-ech'))!;
    expect((ech.streamSettings as any).tlsSettings.echSockopt).toEqual({
      dialerProxy: 'flowz-dialer',
    });
    const r = xrayTest(cfg, 'penetrate-ech');
    if (r.code !== 0) throw new Error(`xray run -test 未通过：\n${r.out}`);
  });

  it('全局 TLS 分片：-frag dialer 用户 + xray-dial-in 路由 tls_fragment，xray -test 与 sing-box check 均通过', () => {
    const servers = corpus(PQV);
    const xrayNodes = servers.filter((s) => requiresXrayCore(s));
    const plan = planXrayBridge({
      candidates: xrayNodes,
      allServers: servers,
      ports: xrayNodes.map((_, i) => 34000 + i).concat(35000),
      secret: () => 's3cret',
      tlsFragment: true,
    });
    expect(plan.dialers.map((d) => d.tag)).toContain('flowz-dialer-frag');
    const xr = xrayTest(
      buildXrayConfig({
        servers: new Map(servers.map((s) => [s.id, s])),
        nodes: plan.nodes,
        dialers: plan.dialers,
        logLevel: 'warning',
      }),
      'frag'
    );
    if (xr.code !== 0) throw new Error(`xray run -test 未通过：\n${xr.out}`);

    const svc: any = new ProxyManager(
      undefined,
      undefined,
      path.join(TMP, 'cfg-frag.json'),
      '/fake/sing-box'
    );
    svc.coreVersion = '1.14.0';
    const sb = svc.generateSingBoxConfig({
      ...userConfig(servers),
      tlsFragment: true,
    }) as SingBoxConfig;
    const fragRules = (sb.route?.rules ?? []).filter((r) => r.tls_fragment === true);
    expect(fragRules.length).toBeGreaterThan(0);
    for (const r of fragRules) {
      expect(r.inbound).toEqual(['xray-dial-in']);
      expect(r.action).toBe('route');
      expect(r.auth_user?.[0]).toMatch(/-frag$/);
    }
    // 非 TLS 节点（ss2022-forced）不分片 → 仍走普通 flowz-dialer
    const ssNode = plan.nodes.find((n) => n.serverId === 'ss2022-forced');
    expect(ssNode?.dialerTag).toBe('flowz-dialer');
    const r = singboxCheck(sb, 'frag');
    if (r.code !== 0) throw new Error(`sing-box check 未通过：\n${r.out}`);
  });

  // 预校验与真核口径对齐：放行的串必须被 Xray 接受；拒收的串在真核上要么 panic 要么报无 tag 的错（正是要拦的）。
  const KEY = 'QxKoobAnmyilC09GlvGiUCWXF1PrxmC7l2lR72ThGSE';
  const vlessOb = (enc: string) => ({
    tag: 'n-enc',
    protocol: 'vless',
    settings: {
      vnext: [{ address: 'a.com', port: 443, users: [{ id: UUID, encryption: enc }] }],
    },
  });
  const ssOb = (method: string, password: string) => ({
    tag: 'n-ss',
    protocol: 'shadowsocks',
    settings: { servers: [{ address: 'a.com', port: 1, method, password }] },
  });
  const bare = (ob: Record<string, unknown>) => ({
    log: { loglevel: 'error' },
    inbounds: [],
    outbounds: [ob, { tag: 'flowz-block', protocol: 'blackhole' }],
  });

  it('VLESS Encryption 预校验：放行 ⇒ 真核接受；拦截 ⇒ 真核 panic / 失败', () => {
    const ok = [
      ENC_X25519,
      ENC_XORPUB_1RTT,
      `mlkem768x25519plus.random.0rtt.${KEY}`,
      `mlkem768x25519plus.native.0rtt.100-111-1111.75-0-111.50-0-3333.${KEY}`,
      `mlkem768x25519plus.native.0rtt.${KEY}.${KEY}`,
      `mlkem768x25519plus.native.1rtt.${Buffer.alloc(1184, 7).toString('base64url')}`,
    ];
    ok.forEach((e, i) => {
      expect(() => validateVlessEncryption(e)).not.toThrow();
      const r = xrayTest(bare(vlessOb(e)), `enc-ok-${i}`);
      if (r.code !== 0) throw new Error(`放行的 ENC 被 Xray 拒收：${e}\n${r.out}`);
    });
    const bad = [
      'mlkem768x25519plus.native.0rtt.',
      'mlkem768x25519plus.native.0rtt.abc',
      'mlkem768x25519plus.native.0rtt.100-111-1111',
      `mlkem768x25519plus.native.0rtt.${KEY}.100-111-1111`,
      `mlkem768x25519plus.native.0rtt.abc.${KEY}`,
    ];
    bad.forEach((e, i) => {
      expect(() => validateVlessEncryption(e)).toThrow(/VLESS Encryption/);
      expect(xrayTest(bare(vlessOb(e)), `enc-bad-${i}`).code).not.toBe(0);
    });
  });

  it('Shadowsocks 2022 预校验：放行 ⇒ 真核接受；拦截 ⇒ 真核报无 tag 的 decode key / bad key', () => {
    const k16 = Buffer.alloc(16, 1).toString('base64');
    const k32 = Buffer.alloc(32, 2).toString('base64');
    const ok: [string, string][] = [
      ['2022-blake3-aes-128-gcm', k16],
      ['2022-blake3-aes-128-gcm', k32],
      ['2022-blake3-aes-128-gcm', `${k16}:${k16}`],
      ['2022-blake3-aes-256-gcm', k32],
      ['2022-blake3-chacha20-poly1305', k32],
    ];
    ok.forEach(([m, p], i) => {
      expect(() => validateShadowsocks2022Password(m, p)).not.toThrow();
      const r = xrayTest(bare(ssOb(m, p)), `ss-ok-${i}`);
      if (r.code !== 0) throw new Error(`放行的 SS2022 密钥被 Xray 拒收：${m} ${p}\n${r.out}`);
    });
    const bad: [string, string][] = [
      ['2022-blake3-aes-128-gcm', 'k'],
      ['2022-blake3-aes-128-gcm', k16.replace(/=+$/, '')],
      ['2022-blake3-aes-256-gcm', k16],
      ['2022-blake3-chacha20-poly1305', `${k32}:${k32}`],
    ];
    bad.forEach(([m, p], i) => {
      expect(() => validateShadowsocks2022Password(m, p)).toThrow(/Shadowsocks 2022/);
      const r = xrayTest(bare(ssOb(m, p)), `ss-bad-${i}`);
      expect(r.code).not.toBe(0);
      expect(parseXrayFailedOutboundTag(r.out)).toBeNull(); // 无 tag → 正是需要预校验的原因
    });
  });

  it('downloadSettings 缺 address/port：真核 -test 照样通过（故必须由构造期预校验拦截）', () => {
    const ob = {
      tag: 'n-ds',
      protocol: 'vless',
      settings: {
        vnext: [{ address: 'a.com', port: 443, users: [{ id: UUID, encryption: 'none' }] }],
      },
      streamSettings: {
        network: 'xhttp',
        xhttpSettings: { path: '/', extra: { downloadSettings: { network: 'xhttp' } } },
      },
    };
    expect(xrayTest(bare(ob), 'ds-missing').code).toBe(0);
    expect(() =>
      buildXrayOutbound(
        {
          id: 'ds',
          name: 'ds',
          protocol: 'custom',
          address: '',
          port: 0,
          customSettings: { engine: 'xray', outbound: ob },
        } as ServerConfig,
        'n-ds',
        { dialerTag: 'flowz-dialer' }
      )
    ).toThrow(/downloadSettings/);
  });
});

describe('Xray JSON 订阅（v2ray-json 配置数组）解析产物 × 真核', () => {
  it('语料本身是 Xray 接受的客户端配置；订阅解析出的节点 → xray run -test + sing-box check 均通过', async () => {
    // 前提：语料逐份原样交真核（去 remarks、错开入站端口）——证明是 Xray 26 真实可用的 v2ray-json，而非臆造形态。
    v2rayJsonSubscription().forEach((cfg, i) => {
      const raw = JSON.parse(JSON.stringify(cfg)) as Record<string, any>;
      delete raw.remarks;
      raw.inbounds[0].port = 36000 + i;
      const r = xrayTest(raw, `sub-raw-${i}`);
      if (r.code !== 0) throw new Error(`语料第 ${i} 份配置被 Xray 拒收：\n${r.out}`);
    });

    // 走订阅解析主路径（parseSubscriptionContent → parseXrayJson → gate → subscriptionId）。
    const sub = new SubscriptionService(new ProtocolParser(), { addLog: () => {} } as never);
    const { servers } = (await (sub as any).parseSubscriptionContent(
      JSON.stringify(v2rayJsonSubscription()),
      'sub-xray',
      { allowProviders: true, viaProxy: false, userAgent: 'ua' }
    )) as { servers: ServerConfig[] };
    expect(servers.map((s) => s.name)).toEqual(V2RAY_JSON_NODE_NAMES);
    const byName = new Map(servers.map((s) => [s.name, s]));
    const us = byName.get('🇺🇸 US · proxy')!;
    const relay = byName.get('🇺🇸 US · relay')!;
    expect(us.detour).toBe(relay.id);

    // Xray 侧：全部节点交 Xray（结构化节点按「使用 Xray 内核」强制，透传节点本就 Xray）——覆盖每个解析产物，
    // 含 Xray→Xray 前置链（US → relay）。
    expect(servers.every((s) => requiresXrayCore(s) || canUseXrayCore(s))).toBe(true);
    const plan = planXrayBridge({
      candidates: servers,
      allServers: servers,
      ports: servers.map((_, i) => 37000 + i).concat(38000),
      secret: () => 's3cret',
    });
    expect(plan.detourOf.get(us.id)).toBe(relay.id);
    const cfg = buildXrayConfig({
      servers: new Map(servers.map((s) => [s.id, s])),
      nodes: plan.nodes,
      dialers: plan.dialers,
      logLevel: 'warning',
    });
    expect(cfg.outbounds.filter((o) => o.tag.startsWith('n-'))).toHaveLength(servers.length);
    const xr = xrayTest(cfg, 'sub-v2ray-json');
    if (xr.code !== 0) throw new Error(`xray run -test 未通过：\n${xr.out}`);

    // sing-box 侧（真实分工）：需 Xray 的节点（mKCP / sockopt 透传、XHTTP+ENC）走 socks 桥，其余原生 + 原生 detour。
    const pm: any = new ProxyManager(
      undefined,
      undefined,
      path.join(TMP, 'cfg-sub.json'),
      '/fake/sing-box'
    );
    pm.coreVersion = '1.14.0';
    const sb = pm.generateSingBoxConfig(userConfig(servers)) as SingBoxConfig;
    const xrayNames = servers.filter((s) => requiresXrayCore(s)).map((s) => s.name);
    expect(xrayNames).toEqual(['KCP A', 'KCP B', '3x-ui 分片', 'XHTTP ENC']);
    for (const name of xrayNames) {
      expect(sb.outbounds.find((o) => o.tag === name)?.type).toBe('socks');
    }
    expect(sb.outbounds.find((o) => o.tag === us.name)).toMatchObject({
      type: 'trojan',
      detour: relay.name,
    });
    const sr = singboxCheck(sb, 'sub-v2ray-json');
    if (sr.code !== 0) throw new Error(`sing-box check 未通过：\n${sr.out}`);
  });
});

describe('门自检（变异）', () => {
  it('Xray 拒收的节点 → run -test 失败且可归因到该节点 tag', () => {
    const bad = {
      id: 'bad-kcp-seed',
      name: 'bad',
      protocol: 'custom',
      address: '',
      port: 0,
      customSettings: {
        engine: 'xray',
        // Xray 26 已把 mKCP header/seed 迁到 finalmask：仍用旧字段即 FATAL。
        outbound: {
          protocol: 'vless',
          settings: {
            vnext: [{ address: 'a.com', port: 1, users: [{ id: UUID, encryption: 'none' }] }],
          },
          streamSettings: {
            network: 'kcp',
            kcpSettings: { seed: 'x', header: { type: 'wechat-video' } },
          },
        },
      },
    } as ServerConfig;
    const plan = planXrayBridge({
      candidates: [bad],
      allServers: [bad],
      ports: [30001, 30002],
      secret: () => 's',
    });
    const cfg = buildXrayConfig({
      servers: new Map([[bad.id, bad]]),
      nodes: plan.nodes,
      dialers: plan.dialers,
      logLevel: 'warning',
    });
    const r = xrayTest(cfg, 'mutation');
    expect(r.code).not.toBe(0);
    expect(parseXrayFailedOutboundTag(r.out)).toBe(xrayOutboundTag(bad.id));
  });
});
