/**
 * config.coreIncludePrerelease（sing-box 版本列表含预发布）sanitize + 持久化单测。
 * 约定：纯 UI 偏好开关，读取端 === true 判定；boolean 原样保留（保存/读回不被剥离），非 boolean 删除（sanitize 不 throw，
 * 同 appRoutingEnabled 标准）；不进新装默认配置（缺省即关）。
 *
 * 测试构造同 config-language.test.ts：validateConfig 公开实例方法；落盘往返经 saveConfig → loadConfig。
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-config-core-pre-'));

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

import { ConfigManager } from '../ConfigManager';
import type { UserConfig } from '../../../shared/types';

afterAll(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeConfig(coreIncludePrerelease: unknown): UserConfig {
  return {
    subscriptions: [],
    servers: [],
    selectedServerId: null,
    proxyMode: 'smart',
    proxyModeType: 'systemProxy',
    mixedPort: 7890,
    tunConfig: { mtu: 1350, stack: 'system', autoRoute: true, strictRoute: true },
    customRules: [],
    autoStart: false,
    silentStart: false,
    autoConnect: false,
    minimizeToTray: false,
    logLevel: 'info',
    dnsConfig: { domesticDns: '', foreignDns: '', enableFakeIp: false },
    coreIncludePrerelease,
  } as unknown as UserConfig;
}

describe('config.coreIncludePrerelease', () => {
  let cm: ConfigManager;
  let file: string;
  beforeEach(() => {
    file = path.join(TMP, `cfg-${Date.now()}-${Math.random()}.json`);
    cm = new ConfigManager(file);
  });

  it.each([true, false])('boolean %p → 原样保留', (v) => {
    const cfg = makeConfig(v);
    cm.validateConfig(cfg);
    expect(cfg.coreIncludePrerelease).toBe(v);
  });

  it('未设 → 保持 undefined（缺省即关）', () => {
    const cfg = makeConfig(undefined);
    cm.validateConfig(cfg);
    expect(cfg.coreIncludePrerelease).toBeUndefined();
  });

  it.each(['true', 1, {}, null])('非 boolean %p → 删除（不 throw，不连累整份配置）', (bad) => {
    const cfg = makeConfig(bad);
    expect(() => cm.validateConfig(cfg)).not.toThrow();
    expect(cfg.coreIncludePrerelease).toBeUndefined();
  });

  it('新装默认配置不含该键（缺省即关）', () => {
    const def = (cm as unknown as { createDefaultConfig: () => UserConfig }).createDefaultConfig();
    expect(def.coreIncludePrerelease).toBeUndefined();
  });

  it('saveConfig → loadConfig 往返：true 被持久化、不被剥离', async () => {
    await cm.saveConfig(makeConfig(true));
    const fresh = new ConfigManager(file);
    const loaded = await fresh.loadConfig();
    expect(loaded.coreIncludePrerelease).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).coreIncludePrerelease).toBe(true);
  });
});
