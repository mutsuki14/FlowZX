/**
 * App 自更新指向本分支仓库（mutsuki14/FlowZX）而非上游 dododook/FlowZ。
 *
 * 背景：FlowZX 安装包内置 Xray 内核，上游 FlowZ 安装包不含；更新源若仍指上游，FlowZX 用户会被推上游包当「更新」，
 * 覆盖安装后 Xray 节点不可用。本测钉死：
 *   ① releases API / release 页 URL 均落在 shared/repo 的本仓库坐标；
 *   ② 用 FlowZX 真实发布形态（标题 "Release x.y.z"、FlowZ-<ver>-<平台> 资产名）走完 checkForUpdate；
 *   ③ 「跳过此版本」记录按仓库限定：旧格式（纯版本号，出自指向上游的旧版）/ 他仓库记录不得静默跳过本仓库同号新版。
 */
import * as os from 'os';
import * as path from 'path';
import * as fsSync from 'fs';
import { EventEmitter } from 'events';

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-upd-fork-'));
const SKIP_FILE = path.join(TMP, 'skipped_version.txt');

const mockNetRequest = jest.fn();
const mockAppVersion = { current: '4.3.3' };

jest.mock('electron', () => ({
  app: {
    getPath: () => TMP,
    getVersion: () => mockAppVersion.current,
    isPackaged: false,
    getAppPath: () => TMP,
  },
  shell: { openExternal: jest.fn() },
  BrowserWindow: class {},
  dialog: {},
  net: { request: (...a: unknown[]) => mockNetRequest(...a) },
}));
// userData 固定到临时目录（绕开 paths 的便携 / root 提权探测，skipped_version.txt 落 TMP）。
jest.mock('../../utils/paths', () => ({ getUserDataPath: () => TMP }));

import { shell } from 'electron';
import { UpdateService } from '../UpdateService';
import { findSuitableUpdateAsset } from '../update-asset';
import { REPO_OWNER, REPO_NAME, REPO_URL, REPO_RELEASES_URL } from '../../../shared/repo';

const log = { addLog: () => {} } as any;
const openExternal = shell.openExternal as unknown as jest.Mock;

const DL = 'https://github.com/mutsuki14/FlowZX/releases/download/v4.4.0';
// FlowZX v4.4.0 实际发布的资产名（GitHub Actions 产出，productName 仍为 FlowZ）。
const FLOWZX_ASSETS = [
  'FlowZ-4.4.0-linux-amd64.deb',
  'FlowZ-4.4.0-linux-x86_64.AppImage',
  'FlowZ-4.4.0-mac-arm64.dmg',
  'FlowZ-4.4.0-mac-x64.dmg',
  'FlowZ-4.4.0-win-x64-portable.exe',
  'FlowZ-4.4.0-win-x64-setup.exe',
].map((name, i) => ({ name, size: 1000 + i, browser_download_url: `${DL}/${name}` }));

const FLOWZX_RELEASE = {
  tag_name: 'v4.4.0',
  name: 'Release 4.4.0',
  body: 'notes',
  prerelease: false,
  draft: false,
  published_at: '2026-10-10T00:58:36Z',
  assets: FLOWZX_ASSETS,
};

/** 最小 net.request 桩：end() 后异步回 200 + JSON 载荷（覆盖 fetchReleases 的 response/data/end 路径）。 */
function fakeRequest(payload: unknown): EventEmitter {
  const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
  req.setHeader = jest.fn();
  req.abort = jest.fn();
  req.end = () => {
    const res = new EventEmitter() as EventEmitter & { statusCode: number };
    res.statusCode = 200;
    setImmediate(() => {
      req.emit('response', res);
      res.emit('data', Buffer.from(JSON.stringify(payload)));
      res.emit('end');
    });
  };
  return req;
}

beforeEach(() => {
  mockNetRequest.mockReset();
  mockNetRequest.mockImplementation(() => fakeRequest([FLOWZX_RELEASE]));
  mockAppVersion.current = '4.3.3';
  openExternal.mockClear();
  fsSync.rmSync(SKIP_FILE, { force: true });
});

afterAll(() => {
  fsSync.rmSync(TMP, { recursive: true, force: true });
});

describe('shared/repo 本分支仓库坐标', () => {
  it('owner/repo/URL 指向 mutsuki14/FlowZX', () => {
    expect(REPO_OWNER).toBe('mutsuki14');
    expect(REPO_NAME).toBe('FlowZX');
    expect(REPO_URL).toBe('https://github.com/mutsuki14/FlowZX');
    expect(REPO_RELEASES_URL).toBe('https://github.com/mutsuki14/FlowZX/releases');
  });
});

describe('UpdateService 更新源 = 本分支仓库', () => {
  it('checkForUpdate 请求 api.github.com/repos/mutsuki14/FlowZX/releases（非上游）', async () => {
    await new UpdateService(log).checkForUpdate();
    expect(mockNetRequest).toHaveBeenCalledTimes(1);
    expect(mockNetRequest.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        method: 'GET',
        url: 'https://api.github.com/repos/mutsuki14/FlowZX/releases',
      })
    );
  });

  it('4.3.3 → 发现 FlowZX v4.4.0（标题 "Release 4.4.0"），下载地址在本仓库 release 下', async () => {
    const r = await new UpdateService(log).checkForUpdate();
    expect(r.hasUpdate).toBe(true);
    expect(r.updateInfo).toEqual(
      expect.objectContaining({ version: 'v4.4.0', title: 'Release 4.4.0', isPrerelease: false })
    );
    // 本测跑在 linux、无 APPIMAGE → deb 安装态取 .deb（各平台/形态的选包见下方 findSuitableUpdateAsset 用例）。
    if (process.platform === 'linux' && !process.env.APPIMAGE) {
      expect(r.updateInfo?.fileName).toBe('FlowZ-4.4.0-linux-amd64.deb');
    }
    expect(r.updateInfo?.downloadUrl.startsWith(`${DL}/`)).toBe(true);
  });

  it('已是 4.4.0 → 无更新', async () => {
    mockAppVersion.current = '4.4.0';
    const r = await new UpdateService(log).checkForUpdate();
    expect(r.hasUpdate).toBe(false);
    expect(r.error).toBeUndefined();
  });

  it('openReleasesPage：列表页 / tag 页均在本仓库', () => {
    const svc = new UpdateService(log);
    svc.openReleasesPage();
    svc.openReleasesPage('v4.4.0');
    svc.openReleasesPage('4.4.1');
    expect(openExternal.mock.calls.map((c) => c[0])).toEqual([
      'https://github.com/mutsuki14/FlowZX/releases',
      'https://github.com/mutsuki14/FlowZX/releases/tag/v4.4.0',
      'https://github.com/mutsuki14/FlowZX/releases/tag/v4.4.1',
    ]);
  });
});

describe('「跳过此版本」记录按仓库限定', () => {
  it('skipVersion 写入 `mutsuki14/FlowZX@<版本>`，重启后仍生效（跳过 v4.4.0 → 不再提醒）', async () => {
    new UpdateService(log).skipVersion('v4.4.0');
    expect(fsSync.readFileSync(SKIP_FILE, 'utf-8')).toBe('mutsuki14/FlowZX@4.4.0');
    const r = await new UpdateService(log).checkForUpdate(); // 新实例 = 重启后从文件加载
    expect(r.hasUpdate).toBe(false);
  });

  it('旧格式纯版本号（出自指向上游的旧版，记的是上游 release 号）→ 不得跳过本仓库同号新版', async () => {
    fsSync.writeFileSync(SKIP_FILE, '4.4.0');
    const r = await new UpdateService(log).checkForUpdate();
    expect(r.hasUpdate).toBe(true);
    expect(r.updateInfo?.version).toBe('v4.4.0');
  });

  it('他仓库记录（dododook/FlowZ@4.4.0）→ 不跳过', async () => {
    fsSync.writeFileSync(SKIP_FILE, 'dododook/FlowZ@4.4.0');
    const r = await new UpdateService(log).checkForUpdate();
    expect(r.hasUpdate).toBe(true);
  });
});

describe('findSuitableUpdateAsset × FlowZX v4.4.0 真实资产', () => {
  const pick = (platform: NodeJS.Platform, arch: string, loose: boolean) =>
    findSuitableUpdateAsset(FLOWZX_ASSETS, platform, arch, loose)?.browser_download_url;

  it.each([
    ['win32', 'x64', false, 'FlowZ-4.4.0-win-x64-setup.exe'],
    ['win32', 'x64', true, 'FlowZ-4.4.0-win-x64-portable.exe'],
    ['darwin', 'arm64', false, 'FlowZ-4.4.0-mac-arm64.dmg'],
    ['darwin', 'x64', false, 'FlowZ-4.4.0-mac-x64.dmg'],
    ['linux', 'x64', true, 'FlowZ-4.4.0-linux-x86_64.AppImage'],
    ['linux', 'x64', false, 'FlowZ-4.4.0-linux-amd64.deb'],
  ] as const)('%s/%s loose=%s → %s', (platform, arch, loose, name) => {
    expect(pick(platform, arch, loose)).toBe(`${DL}/${name}`);
  });
});
