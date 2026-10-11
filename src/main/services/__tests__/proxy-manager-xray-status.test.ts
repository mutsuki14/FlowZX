/**
 * ProxyManager × Xray 版本选择：
 *  - getXrayStatus 带出来源（bundled / downloaded / custom）、随包 / 最低版本、belowMinimum；
 *  - configGenerationNorm 排除 xrayIncludePrerelease（纯 UI 偏好，运行中拨开关不得触发重启断流）。
 * 注入假 XrayCoreManager（私有字段 `_xrayManager`），不起任何进程。
 */
const os = require('os');
const path = require('path');
const fsSync = require('fs');
const { createHash } = require('crypto');

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-xray-status-'));

jest.mock('electron', () => ({
  app: { getPath: () => TMP, getVersion: () => '9.9.9', isPackaged: false, getAppPath: () => TMP },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));

import { ProxyManager } from '../ProxyManager';
import { XRAY_MARKER_FILE, clearXrayHashCache } from '../xray-install-marker';
import { resourceManager } from '../ResourceManager';
import coreManifest from '../../../shared/core-manifest.json';
import type { UserConfig } from '../../../shared/types';

afterAll(() => {
  try {
    fsSync.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const BIN = process.platform === 'win32' ? 'xray.exe' : 'xray';
const overrideDir = () => resourceManager.getXrayOverrideDir();

function makeSvc(version: string | null, running = false): any {
  const configPath = path.join(TMP, `sb-${Math.random().toString(36).slice(2)}.json`);
  const svc: any = new ProxyManager(undefined, undefined, configPath, '/fake/sing-box');
  svc._xrayManager = {
    isAvailable: () => true,
    getVersion: async () => version,
    getBinaryPath: () => '/fake/xray',
    isRunning: () => running,
    getPid: () => (running ? 4242 : null),
  };
  svc.xrayRunningNodes = 3;
  return svc;
}

beforeEach(() => {
  clearXrayHashCache();
  fsSync.rmSync(overrideDir(), { recursive: true, force: true });
});

describe('getXrayStatus：来源 / 版本门', () => {
  it('槽位为空 → bundled；带随包与最低版本；随包版本不低于最低', async () => {
    const st = await makeSvc(coreManifest.bundledXrayVersion, true).getXrayStatus();
    expect(st).toMatchObject({
      available: true,
      version: coreManifest.bundledXrayVersion,
      overrideDir: overrideDir(),
      running: true,
      nodes: 3,
      source: 'bundled',
      bundledVersion: coreManifest.bundledXrayVersion,
      minVersion: coreManifest.minXrayVersion,
      belowMinimum: false,
    });
    expect(st.tag).toBeUndefined();
  });

  it('低于最低版本（常见于 custom 文件）→ belowMinimum；版本未知 → false', async () => {
    expect((await makeSvc('25.12.8').getXrayStatus()).belowMinimum).toBe(true);
    expect((await makeSvc(null).getXrayStatus()).belowMinimum).toBe(false);
  });

  it('槽位有文件无标记 → custom', async () => {
    fsSync.mkdirSync(overrideDir(), { recursive: true });
    fsSync.writeFileSync(path.join(overrideDir(), BIN), 'user', { mode: 0o755 });
    expect((await makeSvc('26.10.10').getXrayStatus()).source).toBe('custom');
  });

  it('应用内安装（标记哈希一致）→ downloaded + tag / prerelease / installedAt', async () => {
    fsSync.mkdirSync(overrideDir(), { recursive: true });
    fsSync.writeFileSync(path.join(overrideDir(), BIN), 'bin-26.10.10', { mode: 0o755 });
    fsSync.writeFileSync(
      path.join(overrideDir(), XRAY_MARKER_FILE),
      JSON.stringify({
        tag: 'v26.10.10',
        version: '26.10.10',
        prerelease: true,
        binarySha256: createHash('sha256').update('bin-26.10.10').digest('hex'),
        archiveSha256: 'b'.repeat(64),
        assetName: 'Xray-linux-64.zip',
        installedAt: '2026-10-11T00:00:00.000Z',
      })
    );
    const st = await makeSvc('26.10.10').getXrayStatus();
    expect(st).toMatchObject({
      source: 'downloaded',
      tag: 'v26.10.10',
      prerelease: true,
      installedAt: '2026-10-11T00:00:00.000Z',
      belowMinimum: false,
    });
  });
});

describe('configGenerationNorm：xrayIncludePrerelease 不翻转 norm', () => {
  const base = {
    servers: [],
    selectedServerId: null,
    proxyMode: 'smart',
    proxyModeType: 'systemProxy',
    customRules: [],
    appRules: [],
    logLevel: 'info',
  } as unknown as UserConfig;

  it('拨「含预发布」开关 → norm 不变（运行中切换不重启断流）', () => {
    const svc = makeSvc(null);
    const n0 = svc.configGenerationNorm(base);
    expect(svc.configGenerationNorm({ ...base, xrayIncludePrerelease: true })).toBe(n0);
    expect(svc.configGenerationNorm({ ...base, xrayIncludePrerelease: false })).toBe(n0);
  });

  it('对照：生成相关字段仍翻转 norm（排除项没有放宽成全部忽略）', () => {
    const svc = makeSvc(null);
    expect(svc.configGenerationNorm({ ...base, logLevel: 'debug' })).not.toBe(
      svc.configGenerationNorm(base)
    );
  });
});
