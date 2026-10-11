/**
 * Xray 槽位来源判定（bundled / downloaded / custom）+ 安装标记解析 + 哈希缓存。
 * 来源判定是「恢复随包会不会删掉用户文件」的依据：判错成 downloaded 会把用户放入的 xray 当成可删的下载件。
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  XRAY_MARKER_FILE,
  clearXrayHashCache,
  detectXraySource,
  parseXrayMarker,
  sha256FileCached,
} from '../xray-install-marker';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-xray-marker-'));
afterAll(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
beforeEach(() => clearXrayHashCache());

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let n = 0;
const newDir = () => {
  const d = path.join(TMP, `d${n++}`);
  fs.mkdirSync(d);
  return d;
};
const marker = (bin: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    tag: 'v26.10.10',
    version: '26.10.10',
    prerelease: true,
    binarySha256: sha(bin),
    archiveSha256: 'a'.repeat(64),
    assetName: 'Xray-linux-64.zip',
    installedAt: '2026-10-11T00:00:00.000Z',
    ...extra,
  });

describe('parseXrayMarker', () => {
  it('合法 → 结构化', () => {
    expect(parseXrayMarker(marker('x'))).toEqual({
      tag: 'v26.10.10',
      version: '26.10.10',
      prerelease: true,
      binarySha256: sha('x'),
      archiveSha256: 'a'.repeat(64),
      assetName: 'Xray-linux-64.zip',
      installedAt: '2026-10-11T00:00:00.000Z',
    });
  });

  it.each([
    ['非 JSON', 'nope'],
    ['数组', '[]'],
    ['缺 tag', marker('x', { tag: undefined })],
    ['binarySha256 非 64 hex', marker('x', { binarySha256: 'abc' })],
    ['archiveSha256 大写（非归一形态）', marker('x', { archiveSha256: 'A'.repeat(64) })],
  ])('%s → null（视为无标记，按 custom 保守处理）', (_l, text) => {
    expect(parseXrayMarker(text)).toBeNull();
  });
});

describe('detectXraySource', () => {
  it('无槽位文件 → bundled', async () => {
    expect(await detectXraySource(newDir(), 'linux')).toEqual({ source: 'bundled' });
  });

  it('槽位有文件、无标记 → custom', async () => {
    const d = newDir();
    fs.writeFileSync(path.join(d, 'xray'), 'user', { mode: 0o755 });
    expect(await detectXraySource(d, 'linux')).toEqual({ source: 'custom' });
  });

  it('标记哈希与槽位一致 → downloaded（附 tag / prerelease / installedAt）', async () => {
    const d = newDir();
    fs.writeFileSync(path.join(d, 'xray'), 'bin-26.10.10', { mode: 0o755 });
    fs.writeFileSync(path.join(d, XRAY_MARKER_FILE), marker('bin-26.10.10'));
    expect(await detectXraySource(d, 'linux')).toEqual({
      source: 'downloaded',
      tag: 'v26.10.10',
      prerelease: true,
      installedAt: '2026-10-11T00:00:00.000Z',
    });
  });

  it('标记在但槽位被换（哈希不符）→ custom', async () => {
    const d = newDir();
    fs.writeFileSync(path.join(d, 'xray'), 'user-replaced', { mode: 0o755 });
    fs.writeFileSync(path.join(d, XRAY_MARKER_FILE), marker('bin-26.10.10'));
    expect((await detectXraySource(d, 'linux')).source).toBe('custom');
  });

  it('标记损坏 → custom', async () => {
    const d = newDir();
    fs.writeFileSync(path.join(d, 'xray'), 'bin', { mode: 0o755 });
    fs.writeFileSync(path.join(d, XRAY_MARKER_FILE), '{broken');
    expect((await detectXraySource(d, 'linux')).source).toBe('custom');
  });

  // 与 ResourceManager.getXrayPath 同判据：POSIX 不可执行的槽位文件不生效 → 实际跑随包核
  (process.platform === 'win32' ? it.skip : it)(
    'POSIX：槽位文件不可执行 → bundled（与 getXrayPath 一致）',
    async () => {
      const d = newDir();
      fs.writeFileSync(path.join(d, 'xray'), 'bin', { mode: 0o644 });
      expect(await detectXraySource(d, 'linux')).toEqual({ source: 'bundled' });
    }
  );

  it('win32 看 xray.exe（只要存在即生效）', async () => {
    const d = newDir();
    fs.writeFileSync(path.join(d, 'xray'), 'posix-name-is-ignored', { mode: 0o755 });
    expect(await detectXraySource(d, 'win32')).toEqual({ source: 'bundled' });
    fs.writeFileSync(path.join(d, 'xray.exe'), 'bin', { mode: 0o644 });
    expect(await detectXraySource(d, 'win32')).toEqual({ source: 'custom' });
  });
});

describe('sha256FileCached（path + size + mtime 缓存）', () => {
  it('同 size + mtime → 命中缓存；mtime 变 → 重算', async () => {
    const d = newDir();
    const f = path.join(d, 'xray');
    fs.writeFileSync(f, 'AAAA');
    const t = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(f, t, t);
    expect(await sha256FileCached(f)).toBe(sha('AAAA'));
    // 同长度改内容并还原 mtime：仍返回缓存值（证明未重读 40MB 二进制）
    fs.writeFileSync(f, 'BBBB');
    fs.utimesSync(f, t, t);
    expect(await sha256FileCached(f)).toBe(sha('AAAA'));
    // mtime 变 → 失效重算
    const t2 = new Date('2026-01-02T00:00:00Z');
    fs.utimesSync(f, t2, t2);
    expect(await sha256FileCached(f)).toBe(sha('BBBB'));
  });

  it('不存在 / 目录 → null', async () => {
    const d = newDir();
    expect(await sha256FileCached(path.join(d, 'missing'))).toBeNull();
    expect(await sha256FileCached(d)).toBeNull();
  });
});
