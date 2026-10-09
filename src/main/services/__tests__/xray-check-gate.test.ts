/**
 * Xray sidecar 真核门 —— 把「Xray 独有协议组合」节点交**随包 Xray 内核**（`xray run -test`）与**随包 sing-box**
 *（`sing-box check`）双重校验，覆盖单测 toEqual 管不到的值域与跨字段引用：
 *  - Xray 侧：VLESS-XHTTP-REALITY-ENC / RAW-REALITY-Vision-ENC / XHTTP-TLS 证书钉扎 / Reality ML-DSA-65 /
 *    vision-udp443 / VMess-XHTTP / Trojan-XHTTP-REALITY / SS2022 强制 Xray / 自定义 Xray JSON（XHTTP 上下行分离）
 *    + 前置代理链（Xray→sing-box 节点、Xray→Xray 节点）；
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
import { requiresXrayCore } from '../../../shared/xray';
import {
  buildXrayConfig,
  parseXrayFailedOutboundTag,
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
