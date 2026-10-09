/**
 * XrayCoreManager 生命周期语义（注入假 spawn / execFile / 端口探测，零真实进程）：
 *  - 就绪后意外退出 → 自愈重拉；预算（60s 内 3 次）耗尽 → onFatal；
 *  - **启动期**就退出 → start() 抛错且不在后台重拉（已知起不来的配置不反复拉）；
 *  - 就绪须经首个入站的 SOCKS5 凭据握手且子进程仍存活（端口被外部进程抢占时不误判就绪，bind 失败原因上抛）；
 *  - stop() 幂等、不触发自愈；
 *  - 孤儿回收仅在 PID 的进程名确为 xray 时才杀（防 PID 复用误杀）。
 */
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { XrayCoreManager, parseXrayLogLine, parseXrayVersion } from '../XrayCoreManager';
import type { XrayConfig } from '../xray-config-builder';
import { system32 } from '../../utils/win-system32';
import { withPlatformAsync } from './platform-test-utils';

class FakeChild extends EventEmitter {
  static nextPid = 5000;
  pid = FakeChild.nextPid++;
  exitCode: number | null = null;
  killed = false;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill(): boolean {
    if (this.exitCode === null) this.exit(0);
    this.killed = true;
    return true;
  }
  exit(code: number): void {
    this.exitCode = code;
    this.emit('exit', code, null);
    this.emit('close', code, null);
  }
}

const CFG: XrayConfig = {
  log: { loglevel: 'warning' },
  inbounds: [{ tag: 'in-a', listen: '127.0.0.1', port: 30001, protocol: 'socks', settings: {} }],
  outbounds: [],
  routing: { rules: [] },
};

function setup(
  opts: {
    ready?: () => boolean;
    behavior?: (c: FakeChild) => void;
    probeReady?: (port: number, user?: string, pass?: string) => Promise<boolean>;
  } = {}
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcm-'));
  const children: FakeChild[] = [];
  const logs: string[] = [];
  const spawnFn = jest.fn(() => {
    const c = new FakeChild();
    children.push(c);
    opts.behavior?.(c);
    return c;
  });
  const mgr = new XrayCoreManager({
    getXrayPath: () => '/fake/xray',
    hasXrayCore: () => true,
    configPath: path.join(dir, 'xray_config.json'),
    pidPath: path.join(dir, 'xray.pid'),
    log: (_l, m) => logs.push(m),
    spawnFn: spawnFn as never,
    execFileFn: ((
      _f: string,
      _a: string[],
      _o: unknown,
      cb: (e: Error | null, out: string) => void
    ) => cb(null, '')) as never,
    probeReady: opts.probeReady ?? (async () => (opts.ready ? opts.ready() : true)),
    readyTimeoutMs: 400,
  });
  return { mgr, children, logs, spawnFn, dir };
}

const waitFor = async (pred: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('XrayCoreManager', () => {
  it('start：写 0600 配置 + PID 文件，就绪后 isRunning', async () => {
    const { mgr, dir } = setup();
    await mgr.start(CFG);
    expect(mgr.isRunning()).toBe(true);
    const st = fs.statSync(path.join(dir, 'xray_config.json'));
    if (process.platform !== 'win32') expect(st.mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'xray.pid'), 'utf-8')).pid).toBe(mgr.getPid());
    await mgr.stop();
    expect(mgr.isRunning()).toBe(false);
    expect(fs.existsSync(path.join(dir, 'xray.pid'))).toBe(false);
  });

  it('就绪后意外退出 → 约 1s 后自愈重拉（新 pid）', async () => {
    const { mgr, children } = setup();
    await mgr.start(CFG);
    const first = children[0];
    first.exit(2);
    await waitFor(() => children.length === 2 && mgr.isRunning());
    expect(mgr.getPid()).toBe(children[1].pid);
    await mgr.stop();
  });

  it('自愈预算耗尽（60s 内第 4 次崩溃）→ onFatal，不再重拉', async () => {
    const { mgr, children, logs } = setup();
    const fatal = jest.fn();
    mgr.onFatal = fatal;
    await mgr.start(CFG);
    const started = () => logs.filter((l) => l.includes('Xray 内核已启动')).length;
    for (let i = 0; i < 3; i++) {
      children[children.length - 1].exit(1);
      // 等重拉的进程通过就绪探测（就绪前即崩溃的按「重启失败」上报、不再循环）
      await waitFor(() => children.length === i + 2 && started() === i + 2);
    }
    children[children.length - 1].exit(1);
    await new Promise((r) => setTimeout(r, 1300));
    expect(children).toHaveLength(4);
    expect(fatal).toHaveBeenCalledTimes(1);
    await mgr.stop();
  }, 15_000);

  it('启动期退出 → start 抛错且不在后台重拉', async () => {
    const { mgr, children } = setup({
      ready: () => false,
      behavior: (c) => setTimeout(() => c.exit(23), 30),
    });
    await expect(mgr.start(CFG)).rejects.toThrow(/启动失败/);
    await new Promise((r) => setTimeout(r, 1300));
    expect(children).toHaveLength(1);
  });

  it('启动超时 → 杀掉半起进程、抛错、不重拉', async () => {
    const { mgr, children } = setup({ ready: () => false });
    await expect(mgr.start(CFG)).rejects.toThrow(/超时/);
    expect(children[0].killed).toBe(true);
    await new Promise((r) => setTimeout(r, 1300));
    expect(children).toHaveLength(1);
  });

  it('stop 幂等且不触发自愈', async () => {
    const { mgr, children } = setup();
    await mgr.start(CFG);
    await mgr.stop();
    await mgr.stop();
    await new Promise((r) => setTimeout(r, 1300));
    expect(children).toHaveLength(1);
  });

  it('孤儿回收：进程名不是 xray → 不杀（防 PID 复用误杀），并清 PID 文件', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcm-'));
    const pidPath = path.join(dir, 'xray.pid');
    fs.writeFileSync(pidPath, JSON.stringify({ pid: 999999 }));
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
    const mgr = new XrayCoreManager({
      getXrayPath: () => '/fake/xray',
      hasXrayCore: () => true,
      configPath: path.join(dir, 'c.json'),
      pidPath,
      log: () => {},
      execFileFn: ((
        _f: string,
        _a: string[],
        _o: unknown,
        cb: (e: Error | null, out: string) => void
      ) => cb(null, process.platform === 'win32' ? '"chrome.exe","999999"' : 'chrome')) as never,
    });
    await mgr.killOrphan();
    expect(killSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(pidPath)).toBe(false);

    fs.writeFileSync(pidPath, JSON.stringify({ pid: 999998 }));
    const mgr2 = new XrayCoreManager({
      getXrayPath: () => '/fake/xray',
      hasXrayCore: () => true,
      configPath: path.join(dir, 'c.json'),
      pidPath,
      log: () => {},
      execFileFn: ((
        _f: string,
        _a: string[],
        _o: unknown,
        cb: (e: Error | null, out: string) => void
      ) =>
        cb(
          null,
          process.platform === 'win32' ? '"xray.exe","999998"' : '/opt/FlowZ/xray'
        )) as never,
    });
    await mgr2.killOrphan();
    expect(killSpy).toHaveBeenCalledWith(999998, 'SIGKILL');
    killSpy.mockRestore();
  });
});

describe('就绪判据：证明是本子进程（SOCKS5 凭据握手）', () => {
  const CFG_AUTH: XrayConfig = {
    ...CFG,
    inbounds: [
      {
        tag: 'in-a',
        listen: '127.0.0.1',
        port: 30001,
        protocol: 'socks',
        settings: { auth: 'password', accounts: [{ user: 'flowz', pass: 's3cret' }], udp: true },
      },
      { tag: 'in-b', listen: '127.0.0.1', port: 30002, protocol: 'socks', settings: {} },
    ],
  };

  it('探测用首个入站的端口 + 账号', async () => {
    const probe = jest.fn(async () => true);
    const { mgr } = setup({ probeReady: probe });
    await mgr.start(CFG_AUTH);
    expect(probe).toHaveBeenCalledWith(30001, 'flowz', 's3cret');
    await mgr.stop();
  });

  it('端口被外部进程抢占：握手不过、Xray bind 失败退出 → start 抛含 bind 原因的错误，不当成就绪、不自愈重拉', async () => {
    const fatal = jest.fn();
    const { mgr, children } = setup({
      probeReady: async () => false, // 外部监听者不是持有本凭据的 SOCKS5 服务
      behavior: (c) =>
        setTimeout(() => {
          c.stdout.emit(
            'data',
            Buffer.from(
              'Failed to start: main: failed to start server > listen tcp 127.0.0.1:30001: bind: address already in use\n'
            )
          );
          c.exit(255);
        }, 30),
    });
    mgr.onFatal = fatal;
    await expect(mgr.start(CFG_AUTH)).rejects.toThrow(/bind: address already in use/);
    expect(mgr.isRunning()).toBe(false);
    await new Promise((r) => setTimeout(r, 1300));
    expect(children).toHaveLength(1);
    expect(fatal).not.toHaveBeenCalled();
  });

  it('探测通过的同时子进程已退出 → 不算就绪（start 抛错）', async () => {
    let child: FakeChild | null = null;
    const { mgr, children } = setup({
      behavior: (c) => {
        child = c;
      },
      probeReady: async () => {
        child?.exit(255);
        return true;
      },
    });
    await expect(mgr.start(CFG_AUTH)).rejects.toThrow(/启动失败/);
    await new Promise((r) => setTimeout(r, 1300));
    expect(children).toHaveLength(1);
  });

  it('退出原因晚于 exit 到达（stdio 未关）：等 close 后再取输出尾巴', async () => {
    const { mgr } = setup({
      probeReady: async () => false,
      behavior: (c) =>
        setTimeout(() => {
          c.exitCode = 255;
          c.emit('exit', 255, null);
          setTimeout(() => {
            c.stderr.emit(
              'data',
              Buffer.from('listen tcp 127.0.0.1:30001: bind: address in use\n')
            );
            c.emit('close', 255, null);
          }, 50);
        }, 30),
    });
    await expect(mgr.start(CFG_AUTH)).rejects.toThrow(/bind: address in use/);
  });
});

describe('孤儿回收（Windows）', () => {
  it('tasklist 用 System32 绝对路径（不依赖 PATH）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcm-'));
    const pidPath = path.join(dir, 'xray.pid');
    fs.writeFileSync(pidPath, JSON.stringify({ pid: 999997 }));
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
    const files: string[] = [];
    const mgr = new XrayCoreManager({
      getXrayPath: () => 'C:\\FlowZ\\xray.exe',
      hasXrayCore: () => true,
      configPath: path.join(dir, 'c.json'),
      pidPath,
      log: () => {},
      execFileFn: ((
        f: string,
        _a: string[],
        _o: unknown,
        cb: (e: Error | null, out: string) => void
      ) => {
        files.push(f);
        cb(null, '"xray.exe","999997","Console","1","20,000 K"');
      }) as never,
    });
    try {
      await withPlatformAsync('win32', () => mgr.killOrphan());
      expect(files).toEqual([system32('tasklist.exe')]);
      expect(killSpy).toHaveBeenCalledWith(999997, 'SIGKILL');
    } finally {
      killSpy.mockRestore();
    }
  });
});

describe('解析器', () => {
  it('parseXrayLogLine：级别映射 + 去时间戳；非标准行按 info 原样', () => {
    expect(
      parseXrayLogLine('2026/10/09 01:12:21.441981 [Warning] core: Xray 26.3.27 started')
    ).toEqual({
      level: 'warn',
      message: 'core: Xray 26.3.27 started',
    });
    expect(parseXrayLogLine('2026/10/09 01:12:21 [Error] boom')).toEqual({
      level: 'error',
      message: 'boom',
    });
    expect(parseXrayLogLine('Failed to start: x')).toEqual({
      level: 'info',
      message: 'Failed to start: x',
    });
    expect(parseXrayLogLine('   ')).toBeNull();
  });

  it('parseXrayVersion', () => {
    expect(
      parseXrayVersion('Xray 26.3.27 (Xray, Penetrates Everything.) d2758a0 (go1.26.1 linux/amd64)')
    ).toBe('26.3.27');
    expect(parseXrayVersion('nope')).toBeNull();
  });
});
