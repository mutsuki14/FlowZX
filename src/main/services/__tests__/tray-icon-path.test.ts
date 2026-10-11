/**
 * 托盘图标选取：mac / win 优先用按托盘尺寸原生栅格化的专用文件（scripts/generate-icon.js 产出），缺失或 Linux
 * 回退 1024 的 app.png / app-gray.png；mac 专用图已是 18pt（@2x 由 nativeImage 自动加载），不得再 resize。
 *
 * 真实临时目录 + mock electron.app（isPackaged=true → 资源目录 = process.resourcesPath）。
 */
import * as os from 'os';
import * as fsSync from 'fs';
import * as path from 'path';

const ROOT = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-tray-icon-'));
const RESOURCES = path.join(ROOT, 'resources');
Object.defineProperty(process, 'resourcesPath', { value: RESOURCES, configurable: true });

const resize = jest.fn();
const imgStub: any = { resize: (...a: unknown[]) => (resize(...a), imgStub), isEmpty: () => false };
const createFromPath = jest.fn((_p: string) => imgStub);

jest.mock('electron', () => ({
  app: {
    getPath: () => ROOT,
    getVersion: () => '9.9.9',
    isPackaged: true,
    getAppPath: () => ROOT,
    getLocale: () => 'zh-CN',
    getPreferredSystemLanguages: () => ['zh-Hans-CN'],
  },
  BrowserWindow: class {},
  Tray: class {
    setToolTip = jest.fn();
    setImage = jest.fn();
    setContextMenu = jest.fn();
    destroy = jest.fn();
    on = jest.fn();
  },
  Menu: { buildFromTemplate: () => ({}) },
  nativeImage: {
    createFromPath: (p: string) => createFromPath(p),
    createFromDataURL: () => imgStub,
    createFromBuffer: () => imgStub,
    createEmpty: () => imgStub,
  },
  Notification: class {},
  net: {},
  session: {},
  shell: {},
}));

import { ResourceManager } from '../ResourceManager';
import { setPlatform, restorePlatform, REAL_PLATFORM } from './platform-test-utils';

const TRAY_FILES = [
  'app.png',
  'app-gray.png',
  'tray-mac-connected.png',
  'tray-mac-connected@2x.png',
  'tray-mac-idle.png',
  'tray-mac-idle@2x.png',
  'tray-win-connected.ico',
  'tray-win-idle.ico',
];

function seed(files: string[]): void {
  fsSync.rmSync(RESOURCES, { recursive: true, force: true });
  fsSync.mkdirSync(RESOURCES, { recursive: true });
  for (const f of files) fsSync.writeFileSync(path.join(RESOURCES, f), 'x');
}

/** ResourceManager 构造时快照 process.platform → 先 pin 再 new。 */
function rmOn(plat: NodeJS.Platform): ResourceManager {
  setPlatform(plat);
  return new ResourceManager();
}

afterEach(() => {
  restorePlatform();
  resize.mockClear();
  createFromPath.mockClear();
  jest.resetModules();
});

afterAll(() => {
  setPlatform(REAL_PLATFORM);
  fsSync.rmSync(ROOT, { recursive: true, force: true });
});

describe('ResourceManager.getTrayIconPath', () => {
  it('macOS：专用 18pt PNG（连接 / 未连接）', () => {
    seed(TRAY_FILES);
    const rm = rmOn('darwin');
    expect(rm.getTrayIconPath(true)).toBe(path.join(RESOURCES, 'tray-mac-connected.png'));
    expect(rm.getTrayIconPath(false)).toBe(path.join(RESOURCES, 'tray-mac-idle.png'));
  });

  it('Windows：专用多尺寸 .ico（连接 / 未连接）', () => {
    seed(TRAY_FILES);
    const rm = rmOn('win32');
    expect(rm.getTrayIconPath(true)).toBe(path.join(RESOURCES, 'tray-win-connected.ico'));
    expect(rm.getTrayIconPath(false)).toBe(path.join(RESOURCES, 'tray-win-idle.ico'));
  });

  it('Linux：恒用 app.png / app-gray.png', () => {
    seed(TRAY_FILES);
    const rm = rmOn('linux');
    expect(rm.getTrayIconPath(true)).toBe(path.join(RESOURCES, 'app.png'));
    expect(rm.getTrayIconPath(false)).toBe(path.join(RESOURCES, 'app-gray.png'));
  });

  it.each(['darwin', 'win32'] as const)('%s 缺专用文件 → 回退 app.png / app-gray.png', (plat) => {
    seed(['app.png', 'app-gray.png']);
    const rm = rmOn(plat);
    expect(rm.getTrayIconPath(true)).toBe(path.join(RESOURCES, 'app.png'));
    expect(rm.getTrayIconPath(false)).toBe(path.join(RESOURCES, 'app-gray.png'));
  });
});

describe('TrayManager.loadTrayIcon（macOS resize）', () => {
  /** TrayManager 内 require('./ResourceManager') 取单例，单例构造时快照平台 → 先 pin 平台再隔离加载模块。 */
  function loadTrayIcon(state: 'connected' | 'idle'): void {
    jest.isolateModules(() => {
      const { TrayManager } = require('../TrayManager');
      const tm = new TrayManager(null, { addLog: jest.fn() }, {});
      (tm as any).loadTrayIcon(state);
    });
  }

  it('专用 tray-mac-*.png：原样加载、不 resize（保留 @2x）', () => {
    seed(TRAY_FILES);
    setPlatform('darwin');
    loadTrayIcon('connected');
    expect(createFromPath).toHaveBeenCalledWith(path.join(RESOURCES, 'tray-mac-connected.png'));
    expect(resize).not.toHaveBeenCalled();
  });

  it('回退 1024 app.png：缩到 18×18', () => {
    seed(['app.png', 'app-gray.png']);
    setPlatform('darwin');
    loadTrayIcon('idle');
    expect(createFromPath).toHaveBeenCalledWith(path.join(RESOURCES, 'app-gray.png'));
    expect(resize).toHaveBeenCalledWith({ width: 18, height: 18 });
  });

  it('Windows 专用 .ico：不 resize', () => {
    seed(TRAY_FILES);
    setPlatform('win32');
    loadTrayIcon('connected');
    expect(createFromPath).toHaveBeenCalledWith(path.join(RESOURCES, 'tray-win-connected.ico'));
    expect(resize).not.toHaveBeenCalled();
  });
});
