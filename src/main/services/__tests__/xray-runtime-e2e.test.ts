/**
 * Xray sidecar 运行时端到端（真 sing-box + 真 Xray，经 ProxyManager.start 全链路）。
 *
 * 拓扑（全部 127.0.0.1，零外网）：
 *   curl/socks 客户端 ─▶ sing-box mixed-in ─▶ proxy-selector ─▶ socks 桥 ─▶ Xray sidecar(节点入站)
 *        ─▶ VLESS outbound ─dialerProxy─▶ sing-box xray-dial-in ─▶ xray-dial-direct / 前置代理
 *        ─▶ 本地 Xray「服务端」(VLESS-XHTTP-REALITY-ENC 等) ─▶ 目标站点
 *
 * 目标域名 e2e-target.flowz.test 只在服务端 Xray 的 dns.hosts 里可解析：本地直连解析不了 → 请求成功 = 流量确实
 * 走了 Xray 节点（不会被 bypass/直连「假绿」）。前置代理用例另起一个 sing-box 作纯 socks 跳板，断言其日志里
 * 出现对节点服务器的连接 = Xray 的出网拨号确实经 sing-box 回环后走了前置代理。
 *
 * 每次 start 后 await whenSelectorSettled：sing-box cache_file 会恢复上一会话的 selector 选择，FlowZ 起核后经管理 API
 * 异步校正回配置选中节点（既有 H3 机制）；不等校正就发请求会走到上一用例的节点。
 *
 * 不在默认 `npm test`（需随包二进制）：`npm run test:xray-e2e`。仅 Linux/macOS（Windows 下 manual 模式起核路径
 * 走 helper/UAC 语义不同，交真机验证）。
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import * as http from 'http';
import * as https from 'https';
import * as dgram from 'dgram';
import { execFileSync, spawn, type ChildProcess } from 'child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-xraye2e-'));
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const PLATFORM_DIR =
  process.platform === 'darwin'
    ? process.arch === 'arm64'
      ? 'resources/mac-arm64'
      : 'resources/mac-x64'
    : 'resources/linux';
const XRAY = path.join(REPO_ROOT, PLATFORM_DIR, 'xray');
const SINGBOX = path.join(REPO_ROOT, PLATFORM_DIR, 'sing-box');

jest.mock('electron', () => ({
  app: {
    getPath: () => TMP,
    getVersion: () => '9.9.9',
    isPackaged: false,
    getAppPath: () => TMP,
    on: () => {},
  },
  BrowserWindow: class {},
  Notification: class {
    static isSupported() {
      return false;
    }
  },
  powerMonitor: { on: () => {}, removeListener: () => {} },
  shell: {},
  net: {},
  session: {},
}));

import { ProxyManager } from '../ProxyManager';
import { SpeedTestService } from '../SpeedTestService';
import type { UserConfig, ServerConfig } from '../../../shared/types';

jest.setTimeout(180_000);

const UUID = '8a502aeb-b677-4fc6-bdbf-0b11435a99ec';
const TARGET_HOST = 'e2e-target.flowz.test';

// ── 工具 ─────────────────────────────────────────────────────────────────────────
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

async function waitPort(port: number, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ok = await new Promise<boolean>((r) => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => {
        s.destroy();
        r(true);
      });
      s.once('error', () => r(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`port ${port} not ready`);
}

/** SOCKS5（用户名/密码可选）CONNECT 后发 HTTP GET，返回响应体。 */
function socksHttpGet(
  proxyPort: number,
  host: string,
  port: number,
  urlPath: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(proxyPort, '127.0.0.1');
    s.setTimeout(15_000, () => {
      s.destroy();
      reject(new Error('socks http timeout'));
    });
    let stage = 0;
    let buf = Buffer.alloc(0);
    s.once('connect', () => s.write(Buffer.from([5, 1, 0])));
    s.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 2) {
        if (buf[1] !== 0) return reject(new Error('socks auth method rejected'));
        buf = buf.subarray(2);
        stage = 1;
        const h = Buffer.from(host);
        s.write(
          Buffer.concat([
            Buffer.from([5, 1, 0, 3, h.length]),
            h,
            Buffer.from([(port >> 8) & 0xff, port & 0xff]),
          ])
        );
      }
      if (stage === 1 && buf.length >= 10) {
        if (buf[1] !== 0) return reject(new Error(`socks connect failed rep=${buf[1]}`));
        buf = buf.subarray(10);
        stage = 2;
        s.write(`GET ${urlPath} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      }
    });
    s.on('end', () => {
      const text = buf.toString();
      const i = text.indexOf('\r\n\r\n');
      resolve(i >= 0 ? text.slice(i + 4) : text);
    });
    s.on('error', reject);
  });
}

/** SOCKS5 UDP ASSOCIATE → 发一个 UDP 包到 host:port（域名），返回回包载荷。 */
function socksUdpEcho(
  proxyPort: number,
  host: string,
  port: number,
  payload: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const ctl = net.connect(proxyPort, '127.0.0.1');
    const udp = dgram.createSocket('udp4');
    const fail = (e: Error) => {
      ctl.destroy();
      udp.close();
      reject(e);
    };
    const timer = setTimeout(() => fail(new Error('socks udp timeout')), 15_000);
    let stage = 0;
    let buf = Buffer.alloc(0);
    ctl.once('connect', () => ctl.write(Buffer.from([5, 1, 0])));
    ctl.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 2) {
        buf = buf.subarray(2);
        stage = 1;
        ctl.write(Buffer.from([5, 3, 0, 1, 0, 0, 0, 0, 0, 0]));
      }
      if (stage === 1 && buf.length >= 10) {
        if (buf[1] !== 0) return fail(new Error(`udp associate rep=${buf[1]}`));
        const relayPort = buf.readUInt16BE(8);
        stage = 2;
        const h = Buffer.from(host);
        const pkt = Buffer.concat([
          Buffer.from([0, 0, 0, 3, h.length]),
          h,
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
          Buffer.from(payload),
        ]);
        udp.on('message', (m) => {
          clearTimeout(timer);
          const atyp = m[3];
          const off = 4 + (atyp === 1 ? 4 : atyp === 4 ? 16 : 1 + m[4]) + 2;
          ctl.destroy();
          udp.close();
          resolve(m.subarray(off).toString());
        });
        udp.send(pkt, relayPort, '127.0.0.1');
      }
    });
    ctl.on('error', fail);
  });
}

// ── 环境：本地服务端全家桶 ──────────────────────────────────────────────────────────
const procs: ChildProcess[] = [];
const servers: { close: () => void }[] = [];
let manager: ProxyManager | null = null;

interface Env {
  ports: { mixed: number; xhttpReality: number; rawVision: number; xhttpTls: number; hop: number };
  certSha: string;
  pbk: string;
  enc: string;
  hopLog: string;
}
let env: Env;

function spawnLogged(bin: string, args: string[], logFile: string): ChildProcess {
  const out = fs.openSync(logFile, 'a');
  const p = spawn(bin, args, { stdio: ['ignore', out, out] });
  procs.push(p);
  return p;
}

beforeAll(async () => {
  for (const b of [XRAY, SINGBOX]) {
    if (!fs.existsSync(b)) throw new Error(`缺少随包内核 ${b}（先 npm run fetch:core）`);
  }
  // 证书（REALITY dest + XHTTP-TLS 服务端共用）
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      path.join(TMP, 'k.pem'),
      '-out',
      path.join(TMP, 'c.pem'),
      '-days',
      '2',
      '-subj',
      '/CN=www.example.com',
      '-addext',
      'subjectAltName=DNS:www.example.com',
    ],
    { stdio: 'ignore' }
  );
  const certSha = /Leaf SHA256:\s*([0-9a-f]{64})/i.exec(
    execFileSync(XRAY, ['tls', 'hash', '--cert', path.join(TMP, 'c.pem')]).toString()
  )![1];
  const keys = execFileSync(XRAY, ['x25519']).toString();
  const priv = /PrivateKey:\s*(\S+)/.exec(keys)![1];
  const pbk = /Password(?: \(PublicKey\))?:\s*(\S+)/.exec(keys)![1];
  const enc = execFileSync(XRAY, ['vlessenc']).toString();
  const dec = /"decryption":\s*"(mlkem768x25519plus\.native\.[^"]+)"/.exec(enc)![1];
  const encCli = /"encryption":\s*"(mlkem768x25519plus\.native\.[^"]+)"/.exec(enc)![1];

  // 目标站点（HTTP + UDP echo）
  const webPort = await freePort();
  const web = http
    .createServer((req, res) => res.end(`TARGET-OK ${req.url}`))
    .listen(webPort, '127.0.0.1');
  servers.push(web);
  const udpPort = await freePort();
  const echo = dgram.createSocket('udp4');
  echo.on('message', (m, r) =>
    echo.send(Buffer.concat([Buffer.from('ECHO:'), m]), r.port, r.address)
  );
  await new Promise<void>((r) => echo.bind(udpPort, '127.0.0.1', () => r()));
  servers.push({ close: () => echo.close() });
  // REALITY dest（TLS1.3 + h2）
  const destPort = await freePort();
  const dest = https
    .createServer(
      {
        key: fs.readFileSync(path.join(TMP, 'k.pem')),
        cert: fs.readFileSync(path.join(TMP, 'c.pem')),
        minVersion: 'TLSv1.3',
        ALPNProtocols: ['h2', 'http/1.1'],
      },
      (_q, s) => s.end('dest')
    )
    .listen(destPort, '127.0.0.1');
  servers.push(dest);

  const p = {
    mixed: await freePort(),
    xhttpReality: await freePort(),
    rawVision: await freePort(),
    xhttpTls: await freePort(),
    hop: await freePort(),
  };
  const reality = {
    target: `127.0.0.1:${destPort}`,
    serverNames: ['www.example.com'],
    privateKey: priv,
    shortIds: ['', '0123abcd'],
  };
  const serverCfg = {
    log: { loglevel: 'warning' },
    dns: { hosts: { [TARGET_HOST]: '127.0.0.1' } },
    inbounds: [
      {
        listen: '127.0.0.1',
        port: p.xhttpReality,
        protocol: 'vless',
        settings: { clients: [{ id: UUID }], decryption: dec },
        streamSettings: {
          network: 'xhttp',
          xhttpSettings: { path: '/xh', mode: 'auto' },
          security: 'reality',
          realitySettings: reality,
        },
      },
      {
        listen: '127.0.0.1',
        port: p.rawVision,
        protocol: 'vless',
        settings: { clients: [{ id: UUID, flow: 'xtls-rprx-vision' }], decryption: dec },
        streamSettings: { network: 'raw', security: 'reality', realitySettings: reality },
      },
      {
        listen: '127.0.0.1',
        port: p.xhttpTls,
        protocol: 'vless',
        settings: { clients: [{ id: UUID }], decryption: 'none' },
        streamSettings: {
          network: 'xhttp',
          xhttpSettings: { path: '/tl', mode: 'packet-up' },
          security: 'tls',
          tlsSettings: {
            certificates: [
              { certificateFile: path.join(TMP, 'c.pem'), keyFile: path.join(TMP, 'k.pem') },
            ],
            alpn: ['h2'],
          },
        },
      },
    ],
    outbounds: [{ protocol: 'freedom', settings: { domainStrategy: 'UseIP' } }],
  };
  fs.writeFileSync(path.join(TMP, 'server.json'), JSON.stringify(serverCfg));
  spawnLogged(XRAY, ['run', '-c', path.join(TMP, 'server.json')], path.join(TMP, 'server.log'));

  // 前置代理跳板：独立 sing-box 纯 socks 服务端（日志记录其转发目标）
  const hopLog = path.join(TMP, 'hop.log');
  fs.writeFileSync(
    path.join(TMP, 'hop.json'),
    JSON.stringify({
      log: { level: 'info' },
      inbounds: [{ type: 'socks', tag: 'hop-in', listen: '127.0.0.1', listen_port: p.hop }],
      outbounds: [{ type: 'direct', tag: 'direct' }],
    })
  );
  spawnLogged(SINGBOX, ['run', '-c', path.join(TMP, 'hop.json')], hopLog);
  await Promise.all([p.xhttpReality, p.hop].map((x) => waitPort(x)));

  env = { ports: p, certSha, pbk, enc: encCli, hopLog };
  // 目标端口供用例使用
  (env as any).webPort = webPort;
  (env as any).udpPort = udpPort;
});

afterAll(async () => {
  try {
    await manager?.stop();
  } catch {
    /* ignore */
  }
  for (const p of procs) p.kill('SIGKILL');
  for (const s of servers) s.close();
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function nodes(): ServerConfig[] {
  const base = (id: string, port: number, over: Partial<ServerConfig>): ServerConfig =>
    ({
      id,
      name: id,
      protocol: 'vless',
      address: '127.0.0.1',
      port,
      uuid: UUID,
      ...over,
    }) as ServerConfig;
  return [
    base('xr1-VLESS-XHTTP-REALITY-ENC', env.ports.xhttpReality, {
      encryption: env.enc,
      network: 'xhttp',
      security: 'reality',
      xhttpSettings: { path: '/xh', mode: 'auto' },
      tlsSettings: { serverName: 'www.example.com', fingerprint: 'chrome' },
      realitySettings: { publicKey: env.pbk, shortId: '0123abcd' },
    }),
    base('xr2-VLESS-RAW-REALITY-VISION-ENC', env.ports.rawVision, {
      encryption: env.enc,
      flow: 'xtls-rprx-vision',
      security: 'reality',
      tlsSettings: { serverName: 'www.example.com', fingerprint: 'chrome' },
      realitySettings: { publicKey: env.pbk, shortId: '0123abcd' },
    }),
    base('xr3-VLESS-XHTTP-TLS-PINNED', env.ports.xhttpTls, {
      network: 'xhttp',
      security: 'tls',
      xhttpSettings: { path: '/tl', mode: 'packet-up' },
      tlsSettings: {
        serverName: 'www.example.com',
        alpn: ['h2'],
        allowInsecure: true,
        pinnedPeerCertSha256: env.certSha,
      },
    }),
    {
      id: 'HOP',
      name: 'HOP',
      protocol: 'socks',
      address: '127.0.0.1',
      port: env.ports.hop,
    } as ServerConfig,
    base('xr4-XHTTP-VIA-HOP', env.ports.xhttpReality, {
      encryption: env.enc,
      network: 'xhttp',
      security: 'reality',
      xhttpSettings: { path: '/xh' },
      tlsSettings: { serverName: 'www.example.com' },
      realitySettings: { publicKey: env.pbk, shortId: '' },
      detour: 'HOP',
    }),
  ];
}

/** Linux/macOS 非 TUN（manual）起核不需提权：注入空操作的 privilegeService（真应用由 index.ts 注入真实现）。 */
function newManager(): ProxyManager {
  const m = new ProxyManager();
  m.setPrivilegeService({
    ensureCapabilities: async () => {},
    killOrphans: async () => {},
    fixFilePermissions: async () => {},
    needsPrivilege: () => false,
    stopElevated: async () => true,
  } as never);
  return m;
}

function userConfig(selected: string): UserConfig {
  return {
    subscriptions: [],
    servers: nodes(),
    selectedServerId: selected,
    proxyMode: 'global',
    proxyModeType: 'manual',
    tunConfig: { mtu: 'auto', stack: 'auto', autoRoute: true, strictRoute: true },
    customRules: [],
    appRules: [],
    customAppPresets: [],
    autoStart: false,
    silentStart: false,
    autoConnect: false,
    minimizeToTray: false,
    mixedPort: env.ports.mixed,
    bypassLAN: false,
    logLevel: 'info',
    clashApiSecret: 'e2e',
    dnsConfig: {
      domesticDns: 'https://223.5.5.5/dns-query',
      foreignDns: 'https://8.8.8.8/dns-query',
      enableFakeIp: false,
    },
  } as unknown as UserConfig;
}

describe('Xray sidecar 端到端（ProxyManager.start）', () => {
  const ids = [
    'xr1-VLESS-XHTTP-REALITY-ENC',
    'xr2-VLESS-RAW-REALITY-VISION-ENC',
    'xr3-VLESS-XHTTP-TLS-PINNED',
  ];

  it.each(ids)('%s：TCP + UDP 经 Xray 节点', async (id) => {
    manager?.removeAllListeners();
    if (manager) await manager.stop();
    manager = newManager();
    await manager.start(userConfig(id));
    await manager.whenSelectorSettled(5000);
    const web = (env as any).webPort as number;
    const udp = (env as any).udpPort as number;
    expect(await socksHttpGet(env.ports.mixed, TARGET_HOST, web, `/via/${id}`)).toBe(
      `TARGET-OK /via/${id}`
    );
    expect(await socksUdpEcho(env.ports.mixed, TARGET_HOST, udp, `udp-${id}`)).toBe(
      `ECHO:udp-${id}`
    );
    // sidecar 进程在跑、且随 stop 回收
    const st = await manager.getXrayStatus();
    expect(st.running).toBe(true);
    expect(st.nodes).toBe(4); // 4 个 Xray 节点（HOP 为 sing-box 原生 socks）
    await manager.stop();
    expect((await manager.getXrayStatus()).running).toBe(false);
  });

  it('测速兜底路径（主核未运行）：临时 Xray + 临时 sing-box 测出 Xray 节点延迟', async () => {
    const pm = newManager();
    const sts = new SpeedTestService(
      { addLog: () => {} } as never,
      (s, tag) => pm.buildSpeedTestOutbound(s, tag) as Record<string, unknown> | null
    );
    sts.setXraySessionFactory((servers) => pm.createXraySpeedTestSession(servers));
    const web = (env as any).webPort as number;
    const targets = nodes().filter((n) => ids.includes(n.id));
    const r = await sts.testAllServers(
      targets,
      undefined,
      undefined,
      `http://${TARGET_HOST}:${web}/generate_204`
    );
    for (const n of targets) {
      const latency = r.results.get(n.id);
      expect(typeof latency).toBe('number');
    }
    // 临时 Xray 会话已随测速结束释放
    expect(fs.readdirSync(TMP).filter((f) => f.startsWith('xray_speedtest_'))).toEqual([]);
  });

  it('测速主核路径（主核运行中）：探测池热切到 Xray 节点的 socks 桥，测出延迟', async () => {
    manager = newManager();
    await manager.start(userConfig(ids[0]));
    await manager.whenSelectorSettled(5000);
    const pm = manager;
    const sts = new SpeedTestService(
      { addLog: () => {} } as never,
      (s, tag) => pm.buildSpeedTestOutbound(s, tag) as Record<string, unknown> | null,
      () => pm.getSpeedTestMainCoreProbe(),
      () => pm.getLifecycleGeneration()
    );
    const web = (env as any).webPort as number;
    const targets = nodes().filter((n) => ids.includes(n.id));
    const r = await sts.testAllServers(
      targets,
      undefined,
      undefined,
      `http://${TARGET_HOST}:${web}/generate_204`
    );
    expect(r.outcome).toBe('completed');
    for (const n of targets) expect(typeof r.results.get(n.id)).toBe('number');
    await manager.stop();
  });

  it('热切换：运行中在 Xray 节点间切换走 selector（不重启内核），新连接立即走新节点', async () => {
    manager = newManager();
    await manager.start(userConfig(ids[0]));
    await manager.whenSelectorSettled(5000);
    const gen = manager.getLifecycleGeneration();
    const web = (env as any).webPort as number;
    expect(await socksHttpGet(env.ports.mixed, TARGET_HOST, web, '/before')).toBe(
      'TARGET-OK /before'
    );
    const before = fs.readFileSync(env.hopLog, 'utf-8').length;
    await manager.switchMode(userConfig('xr4-XHTTP-VIA-HOP'));
    expect(manager.getLifecycleGeneration()).toBe(gen); // 未重启
    expect(await socksHttpGet(env.ports.mixed, TARGET_HOST, web, '/after')).toBe(
      'TARGET-OK /after'
    );
    // 新选中的是经 HOP 的 Xray 节点 → HOP 跳板出现对 Xray 服务端的新连接
    expect(fs.readFileSync(env.hopLog, 'utf-8').slice(before)).toContain(
      `127.0.0.1:${env.ports.xhttpReality}`
    );
    await manager.stop();
  });

  it('崩溃自愈：Xray sidecar 被杀后自动拉起，sing-box 主核不受影响、流量恢复', async () => {
    manager = newManager();
    await manager.start(userConfig(ids[0]));
    await manager.whenSelectorSettled(5000);
    const web = (env as any).webPort as number;
    const pid1 = (await manager.getXrayStatus()).pid;
    expect(pid1).toBeTruthy();
    const gen = manager.getLifecycleGeneration();
    process.kill(pid1!, 'SIGKILL');
    let pid2: number | null = null;
    for (let i = 0; i < 50 && (!pid2 || pid2 === pid1); i++) {
      await new Promise((r) => setTimeout(r, 200));
      pid2 = (await manager.getXrayStatus()).pid;
    }
    try {
      expect(pid2).toBeTruthy();
      expect(pid2).not.toBe(pid1);
      expect(manager.getLifecycleGeneration()).toBe(gen); // sing-box 未重启
      // 拉起后入站绑定需片刻（自愈窗口约 1s 断流，符合预期）：轮询直到流量恢复。
      let body = '';
      for (let i = 0; i < 30 && body !== 'TARGET-OK /healed'; i++) {
        body = await socksHttpGet(env.ports.mixed, TARGET_HOST, web, '/healed').catch(() => '');
        if (body !== 'TARGET-OK /healed') await new Promise((r) => setTimeout(r, 200));
      }
      expect(body).toBe('TARGET-OK /healed');
    } finally {
      await manager.stop();
    }
  });

  it('前置代理：Xray 节点的出网拨号经 sing-box 回环后走 HOP 跳板', async () => {
    manager = newManager();
    const before = fs.readFileSync(env.hopLog, 'utf-8').length;
    await manager.start(userConfig('xr4-XHTTP-VIA-HOP'));
    await manager.whenSelectorSettled(5000);
    const web = (env as any).webPort as number;
    expect(await socksHttpGet(env.ports.mixed, TARGET_HOST, web, '/hop')).toBe('TARGET-OK /hop');
    const hopLog = fs.readFileSync(env.hopLog, 'utf-8').slice(before);
    expect(hopLog).toContain(`127.0.0.1:${env.ports.xhttpReality}`);
    await manager.stop();
  });
});
