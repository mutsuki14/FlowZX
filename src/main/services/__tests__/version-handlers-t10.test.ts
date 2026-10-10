/**
 * T10 — version 迁移单测（version-handlers.ts 的 BUILD_DATE 注入 + core-manifest 读取）。
 *
 * 收敛目标：
 *  1. BUILD_DATE 来自构建时刻注入（src/shared/build-info.ts，scripts/gen-build-info.js 生成），
 *     非 version-handlers 内运行时 new Date()。本测 mock 该模块注入受控值，断言 VersionInfo.buildDate
 *     严格等于注入值且非空——证明「构建期注入」链路通（B-1 修复点）。
 *  2. 内核版本以 core-manifest.json 的 bundledCoreVersion 为权威（构建时随内核打包的真相），
 *     非 package.json.singboxVersion（旧值易漂移）。本测直接读真实 JSON 断言字段存在且非空，
 *     并断言无 coreUpdateService 时 VersionInfo.singBoxVersion 回落该值。
 *
 * 触达路径：registerVersionHandlers 注册 VERSION_GET_INFO 的 IPC handler。
 *   用真实 IpcHandlerRegistry，但 mock electron.ipcMain.handle 捕获注册的 handler，
 *   再直接调用 handler 验证返回的 VersionInfo。
 *
 * 隔离：
 *  - electron：mock app.getVersion/app.isPackaged + ipcMain.handle/removeHandler + shell.openExternal。
 *  - shared/build-info：注入受控 BUILD_DATE（避免依赖磁盘生成文件，CI 环境该文件可能未生成）。
 *  - 每次注册用 jest.isolateModules 拿独立 module → 独立全局 IpcHandlerRegistry，
 *    避免同文件多次注册 VERSION_GET_INFO 触发开发期「同名 channel 二次注册」抛错。
 *  - core-manifest.json：读真实文件（jest.config 已开 resolveJSONModule），断言其字段为权威基准。
 */
import * as actualCoreManifest from '../../../shared/core-manifest.json';

// ---- electron mock（必须在 import 被测模块之前）----
const handleSpy = jest.fn();
const removeHandlerSpy = jest.fn();
const electronMock = {
  app: {
    getVersion: jest.fn().mockReturnValue('1.2.3'),
    isPackaged: false,
  },
  ipcMain: {
    handle: (...args: any[]) => handleSpy(...args),
    removeHandler: (...args: any[]) => removeHandlerSpy(...args),
  },
  shell: {
    openExternal: jest.fn().mockResolvedValue(undefined),
  },
};
jest.mock('electron', () => electronMock);

// ---- shared/build-info mock：注入受控 BUILD_DATE，断言「构建期注入」链路 ----
const MOCK_BUILD_DATE = '2024-01-15';
jest.mock('../../../shared/build-info', () => ({
  BUILD_DATE: MOCK_BUILD_DATE,
}));

// 核心版本 mock 形状（CoreUpdateService 仅用到 getCurrentVersion）
function makeCoreUpdateService(version: string | null) {
  return {
    getCurrentVersion: jest.fn().mockResolvedValue(version),
  } as any;
}

/** 在隔离的 module 作用域内注册 version handlers，返回一个直接调用并解包 ApiResponse.data 的 invoke。
 *  registerIpcHandler 会把 handler 包成 () => ApiResponse<T>（{success,data}），故解包 data 取 VersionInfo。
 *  isolateModules 让每次注册拿到独立全局 IpcHandlerRegistry，避免同文件多次注册 VERSION_GET_INFO
 *  触发开发期「同名 channel 二次注册」抛错。 */
async function registerInfoInvoker(coreUpdateService?: any): Promise<() => Promise<any>> {
  let handler: any;
  jest.isolateModules(() => {
    handleSpy.mockClear();
    const { registerVersionHandlers } = require('../../ipc/handlers/version-handlers');
    registerVersionHandlers(coreUpdateService);
    // VERSION_GET_INFO 是第一个注册的（registerVersionHandlers 内顺序）
    handler = handleSpy.mock.calls[0][1];
  });
  return async () => {
    const res = await handler({}, undefined);
    // ApiResponse 外壳：{ success: true, data: VersionInfo }
    return res.data;
  };
}

beforeEach(() => {
  handleSpy.mockClear();
  removeHandlerSpy.mockClear();
  electronMock.app.getVersion.mockClear().mockReturnValue('1.2.3');
  electronMock.shell.openExternal.mockClear().mockResolvedValue(undefined);
});

describe('T10 core-manifest 权威基准（真实 JSON）', () => {
  it('core-manifest.json 含 bundledCoreVersion 字段且非空', () => {
    const manifest = actualCoreManifest as { bundledCoreVersion?: string };
    expect(manifest.bundledCoreVersion).toBeTruthy();
    expect(typeof manifest.bundledCoreVersion).toBe('string');
    expect(manifest!.bundledCoreVersion!.length).toBeGreaterThan(0);
  });
});

describe('T10 BUILD_DATE 构建期注入（version-handlers）', () => {
  it('VersionInfo.buildDate 严格等于 mock 注入的 BUILD_DATE（非运行时 new Date）', async () => {
    const getInfo = await registerInfoInvoker(undefined);
    const result = await getInfo();
    expect(result.buildDate).toBe(MOCK_BUILD_DATE);
    // 关键不变量：不是「今天」（证明非运行时 new Date().toISOString().split('T')[0]）
    const today = new Date().toISOString().split('T')[0];
    expect(result.buildDate).not.toBe(today);
  });

  it('VersionInfo.buildDate 非空字符串', async () => {
    const getInfo = await registerInfoInvoker(undefined);
    const result = await getInfo();
    expect(typeof result.buildDate).toBe('string');
    expect(result.buildDate.length).toBeGreaterThan(0);
    // 日期格式 YYYY-MM-DD
    expect(result.buildDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('T10 内核版本回落 bundledCoreVersion', () => {
  it('无 coreUpdateService → singBoxVersion 回落 core-manifest.bundledCoreVersion', async () => {
    const getInfo = await registerInfoInvoker(undefined);
    const result = await getInfo();
    expect(result.singBoxVersion).toBe((actualCoreManifest as any).bundledCoreVersion || 'Unknown');
  });

  it('coreUpdateService.getCurrentVersion 返回有效版本 → 采用该版本', async () => {
    const svc = makeCoreUpdateService('1.14.2');
    const getInfo = await registerInfoInvoker(svc);
    const result = await getInfo();
    expect(result.singBoxVersion).toBe('1.14.2');
    expect(svc.getCurrentVersion).toHaveBeenCalledTimes(1);
  });

  it('coreUpdateService.getCurrentVersion 返回 "未知" → 回落 bundledCoreVersion', async () => {
    const svc = makeCoreUpdateService('未知');
    const getInfo = await registerInfoInvoker(svc);
    const result = await getInfo();
    expect(result.singBoxVersion).toBe((actualCoreManifest as any).bundledCoreVersion || 'Unknown');
  });

  it('coreUpdateService.getCurrentVersion 抛错 → 回落 bundledCoreVersion（不崩 handler）', async () => {
    const svc = {
      getCurrentVersion: jest.fn().mockRejectedValue(new Error('core gone')),
    };
    const getInfo = await registerInfoInvoker(svc as any);
    const result = await getInfo();
    expect(result.singBoxVersion).toBe((actualCoreManifest as any).bundledCoreVersion || 'Unknown');
  });
});

describe('T10 VersionInfo 完整结构', () => {
  it('返回对象含全部必填字段且类型正确', async () => {
    const getInfo = await registerInfoInvoker(undefined);
    const result = await getInfo();
    expect(result).toEqual(
      expect.objectContaining({
        appVersion: expect.any(String),
        appName: expect.any(String),
        buildDate: expect.any(String),
        singBoxVersion: expect.any(String),
        copyright: expect.any(String),
        repositoryUrl: expect.any(String),
      })
    );
    expect(result.appVersion).toBe('1.2.3');
    expect(result.appName).toBe('FlowZ');
    expect(result.repositoryUrl).toBe('https://github.com/mutsuki14/FlowZX');
    // copyright 含当前年份
    expect(result.copyright).toContain(String(new Date().getFullYear()));
  });

  it('app.getVersion 变化 → appVersion 跟随', async () => {
    electronMock.app.getVersion.mockReturnValue('9.9.9');
    const getInfo = await registerInfoInvoker(undefined);
    const result = await getInfo();
    expect(result.appVersion).toBe('9.9.9');
  });
});
