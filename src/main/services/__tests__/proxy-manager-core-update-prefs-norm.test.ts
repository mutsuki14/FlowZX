/**
 * ProxyManager.configGenerationNorm × sing-box 内核更新偏好：coreIncludePrerelease（版本列表含预发布）/ autoUpdateCore
 * （调度器读）/ restrictCoreUpdateToCompatibleMinor（checkUpdate 读）都不影响 sing-box 生成 → 排除出 norm。
 * 否则运行中拨这三个开关 → CONFIG_CHANGED → switchMode 判 norm 翻转 → 重启内核断流（尤其版本选择的「固定此版本」
 * 与自动更新开关联动时，会和安装自身的停 → 换 → 起撞车）。
 */
const os = require('os');
const path = require('path');
const fsSync = require('fs');

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-core-pref-norm-'));

jest.mock('electron', () => ({
  app: { getPath: () => TMP, getVersion: () => '9.9.9', isPackaged: false, getAppPath: () => TMP },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));

import { ProxyManager } from '../ProxyManager';
import type { UserConfig } from '../../../shared/types';

afterAll(() => {
  try {
    fsSync.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeSvc(): any {
  const configPath = path.join(TMP, `sb-${Math.random().toString(36).slice(2)}.json`);
  return new ProxyManager(undefined, undefined, configPath, '/fake/sing-box');
}

const base = {
  servers: [],
  selectedServerId: null,
  proxyMode: 'smart',
  proxyModeType: 'systemProxy',
  customRules: [],
  appRules: [],
  logLevel: 'info',
} as unknown as UserConfig;

describe('configGenerationNorm：sing-box 内核更新偏好不翻转 norm', () => {
  it.each([
    ['coreIncludePrerelease', true],
    ['coreIncludePrerelease', false],
    ['autoUpdateCore', true],
    ['autoUpdateCore', false],
    ['restrictCoreUpdateToCompatibleMinor', false],
    ['restrictCoreUpdateToCompatibleMinor', true],
  ])('拨 %s=%p → norm 不变（运行中切换不重启断流）', (key, value) => {
    const svc = makeSvc();
    expect(svc.configGenerationNorm({ ...base, [key]: value })).toBe(
      svc.configGenerationNorm(base)
    );
  });

  it('三者同时变化也不翻转；xrayIncludePrerelease 的既有排除不受影响', () => {
    const svc = makeSvc();
    expect(
      svc.configGenerationNorm({
        ...base,
        coreIncludePrerelease: true,
        autoUpdateCore: true,
        restrictCoreUpdateToCompatibleMinor: false,
        xrayIncludePrerelease: true,
      })
    ).toBe(svc.configGenerationNorm(base));
  });

  it('对照：生成相关字段仍翻转 norm（排除项没有放宽成全部忽略）', () => {
    const svc = makeSvc();
    expect(svc.configGenerationNorm({ ...base, logLevel: 'debug' })).not.toBe(
      svc.configGenerationNorm(base)
    );
    expect(
      svc.configGenerationNorm({ ...base, autoUpdateCore: true, proxyMode: 'global' })
    ).not.toBe(svc.configGenerationNorm(base));
  });
});
