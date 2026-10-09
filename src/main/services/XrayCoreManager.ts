/**
 * Xray sidecar 进程编排（单实例）：配置校验（xray run -test）/ 起停 / 就绪探测 / 崩溃自愈 / 跨会话孤儿回收 / 日志转发。
 *
 * 与 sing-box 主核的分工见 shared/xray.ts 头注。要点：
 *  - Xray 恒以**普通用户**运行（只监听 127.0.0.1、拨号经 dialerProxy 回环 sing-box），三平台均无需 helper/提权，
 *    TUN 模式下也不经 TUN（loopback），故无回环风险。
 *  - 生命周期绑定主核：ProxyManager 起核前 start、停核时 stop；崩溃在预算内（60s 内 ≤3 次）原配置重拉，
 *    超预算回调 onFatal（ProxyManager 转渲染端错误事件），不拖垮 sing-box 主核（非 Xray 节点照常可用）。
 *
 * 纯 Node（child_process/fs），依赖经构造注入，便于单测替换 spawn/execFile。
 */
import { spawn as nodeSpawn, execFile as nodeExecFile, type ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { LogLevel } from '../../shared/types';
import type { XrayConfig } from './xray-config-builder';
import { probeLoopbackPort } from '../utils/loopback-ports';
import { writeFileAtomic } from '../utils/atomic-write';

type Log = (level: LogLevel, message: string) => void;

export interface XrayCoreManagerDeps {
  getXrayPath: () => string;
  hasXrayCore: () => boolean;
  configPath: string;
  pidPath: string;
  log: Log;
  spawnFn?: typeof nodeSpawn;
  execFileFn?: typeof nodeExecFile;
  probePort?: (port: number) => Promise<boolean>;
  /** 就绪等待上限（ms）。 */
  readyTimeoutMs?: number;
}

export type XrayTestResult = { ok: true } | { failOpen: true; reason: string } | { stderr: string };

/** 崩溃自愈预算：窗口内最多重拉次数。 */
const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS_IN_WINDOW = 3;
const RESTART_DELAY_MS = 1000;

/** Xray 日志行 → FlowZ 日志级别（Xray 行形如 `2026/10/09 01:12:21.441981 [Warning] core: ...`）。 */
export function parseXrayLogLine(line: string): { level: LogLevel; message: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const m = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?\s+\[(\w+)\]\s*(.*)$/.exec(trimmed);
  if (!m) return { level: 'info', message: trimmed };
  const tag = m[1].toLowerCase();
  const level: LogLevel =
    tag === 'error' ? 'error' : tag === 'warning' ? 'warn' : tag === 'debug' ? 'debug' : 'info';
  return { level, message: m[2] };
}

/** `xray version` 首行 → 版本号（如 "Xray 26.3.27 (Xray, Penetrates Everything.) …" → "26.3.27"）。 */
export function parseXrayVersion(stdout: string): string | null {
  const m = /Xray\s+v?(\d+\.\d+\.\d+(?:[-.][\w.]+)?)/i.exec(stdout);
  return m ? m[1] : null;
}

export class XrayCoreManager {
  private proc: ChildProcess | null = null;
  private lastConfig: XrayConfig | null = null;
  private expectedExit = false;
  private restartTimes: number[] = [];
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  // 已通过就绪探测的子进程：只有「跑起来过」的进程意外退出才自愈重拉；启动期就退出的由 start() 的调用方处理
  //（抛错 → 剔除 Xray 节点 / 终止），不在后台拿已知起不来的配置反复重拉。
  private readonly readyChildren = new WeakSet<ChildProcess>();
  private versionCache: { key: string; version: string | null } | null = null;
  /** 崩溃超出自愈预算时回调（ProxyManager 注入：转渲染端错误事件）。 */
  onFatal?: (message: string) => void;

  private readonly spawnFn: typeof nodeSpawn;
  private readonly execFileFn: typeof nodeExecFile;
  private readonly probePort: (port: number) => Promise<boolean>;
  private readonly readyTimeoutMs: number;

  constructor(private readonly deps: XrayCoreManagerDeps) {
    this.spawnFn = deps.spawnFn ?? nodeSpawn;
    this.execFileFn = deps.execFileFn ?? nodeExecFile;
    this.probePort = deps.probePort ?? ((p) => probeLoopbackPort(p));
    this.readyTimeoutMs = deps.readyTimeoutMs ?? 8000;
  }

  isAvailable(): boolean {
    return this.deps.hasXrayCore();
  }

  isRunning(): boolean {
    return !!this.proc && this.proc.exitCode === null && !this.proc.killed;
  }

  getPid(): number | null {
    return this.isRunning() ? (this.proc?.pid ?? null) : null;
  }

  getBinaryPath(): string {
    return this.deps.getXrayPath();
  }

  /** `xray version`（按二进制路径 + mtime 缓存；不可用 → null）。 */
  async getVersion(): Promise<string | null> {
    if (!this.deps.hasXrayCore()) return null;
    const bin = this.deps.getXrayPath();
    let key = bin;
    try {
      const st = await fs.stat(bin);
      key = `${bin}|${st.size}|${Math.round(st.mtimeMs)}`;
    } catch {
      return null;
    }
    if (this.versionCache?.key === key) return this.versionCache.version;
    const version = await new Promise<string | null>((resolve) => {
      this.execFileFn(bin, ['version'], { timeout: 10_000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null);
        resolve(parseXrayVersion(String(stdout)));
      });
    });
    this.versionCache = { key, version };
    return version;
  }

  /**
   * `xray run -test -c <tmp>` 校验配置。
   *  - spawn 层失败 / 超时 → failOpen（与 sing-box gate 同语义：核不可执行不应把启动卡死；真问题会在 start 暴露）；
   *  - 退出码非 0 → { stderr }（调用方据 parseXrayFailedOutboundTag 剔节点）；
   *  - 通过 → ok。
   */
  async test(config: XrayConfig): Promise<XrayTestResult> {
    if (!this.deps.hasXrayCore()) return { failOpen: true, reason: 'xray binary missing' };
    const dir = path.dirname(this.deps.configPath);
    const tmp = path.join(dir, `xray-test-${randomBytes(6).toString('hex')}.json`);
    try {
      await fs.writeFile(tmp, JSON.stringify(config), { mode: 0o600 });
      return await new Promise<XrayTestResult>((resolve) => {
        this.execFileFn(
          this.deps.getXrayPath(),
          ['run', '-test', '-c', tmp],
          { timeout: 15_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
          (err, stdout, stderr) => {
            if (!err) return resolve({ ok: true });
            const e = err as NodeJS.ErrnoException & { killed?: boolean };
            if (e.killed) return resolve({ failOpen: true, reason: 'xray -test timeout' });
            if (typeof e.code === 'string') return resolve({ failOpen: true, reason: e.code });
            resolve({ stderr: `${String(stdout)}\n${String(stderr)}`.trim() });
          }
        );
      });
    } catch (e) {
      return { failOpen: true, reason: (e as Error)?.message ?? String(e) };
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
  }

  /**
   * 写配置（0600，含节点凭据）→ 起 Xray → 等首个入站端口可连。失败 throw（调用方决定降级/终止）。
   * 已有在跑实例先停（配置整体替换，无热加载）。
   */
  async start(config: XrayConfig): Promise<void> {
    await this.stop();
    await this.killOrphan();
    if (!this.deps.hasXrayCore()) throw new Error('未找到 Xray 内核');
    await writeFileAtomic(this.deps.configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    this.lastConfig = config;
    this.restartTimes = [];
    await this.spawnAndWait(config);
  }

  private async spawnAndWait(config: XrayConfig): Promise<void> {
    const bin = this.deps.getXrayPath();
    this.expectedExit = false;
    const child = this.spawnFn(bin, ['run', '-c', this.deps.configPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // 继承环境但钉死资产目录到配置目录：Xray 若被用户 JSON 引用 geo 文件，在此目录找（不落到随包只读目录报错）。
      env: { ...process.env, XRAY_LOCATION_ASSET: path.dirname(this.deps.configPath) },
    });
    this.proc = child;
    let tail = '';
    const onData = (buf: Buffer) => {
      const text = buf.toString();
      tail = (tail + text).slice(-4000);
      for (const line of text.split(/\r?\n/)) {
        const parsed = parseXrayLogLine(line);
        if (parsed) this.deps.log(parsed.level, `[xray] ${parsed.message}`);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', (code, signal) => this.handleExit(child, code, signal));
    child.on('error', (err) => this.deps.log('error', `[xray] 进程错误: ${err.message}`));
    if (child.pid) {
      await fs
        .writeFile(this.deps.pidPath, JSON.stringify({ pid: child.pid, path: bin }))
        .catch(() => {});
    }

    const firstPort = config.inbounds[0]?.port;
    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.killed) {
        throw new Error(`Xray 内核启动失败（退出码 ${child.exitCode}）：${lastLines(tail)}`);
      }
      if (!firstPort || (await this.probePort(firstPort))) {
        this.readyChildren.add(child);
        this.deps.log(
          'info',
          `Xray 内核已启动（pid=${child.pid}，${config.inbounds.length} 个节点入站）`
        );
        return;
      }
      await sleep(100);
    }
    // 超时：回收这个半起的进程（不留孤儿占端口），由调用方决定降级。先摘 this.proc 使 handleExit 视其为已取代。
    if (this.proc === child) this.proc = null;
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已退出 */
    }
    throw new Error(
      `Xray 内核启动超时（${this.readyTimeoutMs}ms 内入站未就绪）：${lastLines(tail)}`
    );
  }

  private handleExit(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    if (this.proc !== child) return; // 已被新实例取代
    this.proc = null;
    if (this.expectedExit) return;
    if (!this.readyChildren.has(child)) return; // 启动期退出：start()/自愈腿各自收口，不在此重拉
    this.deps.log('error', `Xray 内核意外退出（code=${code}, signal=${signal ?? '-'}）`);
    const now = Date.now();
    this.restartTimes = this.restartTimes.filter((t) => now - t < RESTART_WINDOW_MS);
    const cfg = this.lastConfig;
    if (!cfg) return;
    if (this.restartTimes.length >= MAX_RESTARTS_IN_WINDOW) {
      const msg = `Xray 内核在 ${RESTART_WINDOW_MS / 1000}s 内连续崩溃 ${MAX_RESTARTS_IN_WINDOW} 次，已停止自动重启；Xray 节点暂不可用，请查看日志或重新连接。`;
      this.deps.log('error', msg);
      this.onFatal?.(msg);
      return;
    }
    this.restartTimes.push(now);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.lastConfig !== cfg || this.isRunning()) return; // 期间被 stop/重新 start
      this.spawnAndWait(cfg).catch((e) => {
        const msg = `Xray 内核自动重启失败：${(e as Error)?.message ?? e}。Xray 节点暂不可用，请重新连接。`;
        this.deps.log('error', msg);
        this.onFatal?.(msg);
      });
    }, RESTART_DELAY_MS);
  }

  /** 停止 sidecar（幂等）：SIGTERM，2s 未退 → SIGKILL。清 PID 文件。 */
  async stop(): Promise<void> {
    this.lastConfig = null;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.proc;
    this.proc = null;
    if (child && child.exitCode === null) {
      this.expectedExit = true;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* 已退出 */
          }
          resolve();
        }, 2000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        try {
          child.kill('SIGTERM');
        } catch {
          clearTimeout(timer);
          resolve();
        }
      });
    }
    await fs.unlink(this.deps.pidPath).catch(() => {});
  }

  /**
   * 跨会话孤儿回收：上次 FlowZ 崩溃/被杀残留的 xray（PID 文件记录）。仅当该 PID 的进程名确为 xray 时才杀，
   * 防 PID 复用误杀无关进程。best-effort，绝不抛。
   */
  async killOrphan(): Promise<void> {
    let rec: { pid?: number } | null = null;
    try {
      rec = JSON.parse(await fs.readFile(this.deps.pidPath, 'utf-8'));
    } catch {
      return;
    }
    const pid = rec?.pid;
    if (!pid || !Number.isInteger(pid) || pid === this.proc?.pid) {
      await fs.unlink(this.deps.pidPath).catch(() => {});
      return;
    }
    try {
      const name = await this.processName(pid);
      if (name && /^xray(\.exe)?$/i.test(path.basename(name))) {
        process.kill(pid, 'SIGKILL');
        this.deps.log('info', `已回收残留的 Xray 进程（pid=${pid}）`);
      }
    } catch {
      /* 进程已不存在 / 无权限：忽略 */
    }
    await fs.unlink(this.deps.pidPath).catch(() => {});
  }

  private processName(pid: number): Promise<string | null> {
    return new Promise((resolve) => {
      if (process.platform === 'win32') {
        this.execFileFn(
          'tasklist',
          ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
          { timeout: 5000, windowsHide: true },
          (err, stdout) => {
            if (err) return resolve(null);
            const m = /^"([^"]+)"/.exec(String(stdout).trim());
            resolve(m ? m[1] : null);
          }
        );
      } else {
        this.execFileFn(
          'ps',
          ['-p', String(pid), '-o', 'comm='],
          { timeout: 5000 },
          (err, stdout) => {
            if (err) return resolve(null);
            resolve(String(stdout).trim() || null);
          }
        );
      }
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function lastLines(text: string, n = 3): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join(' | ');
}
