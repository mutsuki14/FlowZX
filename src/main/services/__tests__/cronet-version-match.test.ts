/**
 * libcronet 版本配套（issue：Windows TUN 下 NaiveProxy 一工作 sing-box 就 0xc0000005 崩溃）。
 *
 * 根因：在线安装的 sing-box（如 1.14.4）编译时绑定的 cronet-go/lib 版本与随包 libcronet（随 1.14.0-rc.1）不同，而旧逻辑
 * 安装时丢弃官方压缩包自带的库、启动前还按随包库「自愈」回去——导出符号一致、dlopen 成功，naive 一工作即内存访问违规。
 *
 * 钉住的不变量：
 *  - 内核绑定版本 = 随包版本（或读不出版本）→ 沿用随包库（零回归）；
 *  - 绑定版本 ≠ 随包、库存有 → 以库存库为权威源自愈；
 *  - 绑定版本 ≠ 随包、库存无 → mismatch：不用随包库凑数、不改动 dst、naive 判不可用；
 *  - adoptCronetFromCoreDir 只收「非随包版本 + 目录里确有库」；prune 只留仍被引用的版本。
 *
 * 内核用合成文件承载 Go build info 的 dep 行（与真实二进制同一段明文），零真实 sing-box。
 */
import * as os from 'os';
import * as fsSync from 'fs';
import * as path from 'path';

const ROOT = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-cronet-ver-'));
const RESOURCES = path.join(ROOT, 'resources');
Object.defineProperty(process, 'resourcesPath', { value: RESOURCES, configurable: true });

jest.mock('electron', () => ({
  app: {
    getPath: () => ROOT,
    getVersion: () => '9.9.9',
    isPackaged: true,
    getAppPath: () => ROOT,
  },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));

import { ResourceManager } from '../ResourceManager';
import coreManifest from '../../../shared/core-manifest.json';
import { setPlatform, REAL_PLATFORM } from './platform-test-utils';

const REAL_ARCH = process.arch;
const BUNDLED_V = coreManifest.cronetVersion;
const NEW_V = 'v0.0.0-20260912104006-c10c03c318db';
const OTHER_V = 'v0.0.0-20261001000000-aaaaaaaaaaaa';

function setArch(a: string): void {
  Object.defineProperty(process, 'arch', { value: a, configurable: true });
}

interface Plat {
  platform: NodeJS.Platform;
  goTarget: string;
  bundleDir: string;
  libName: string;
  coreName: string;
}

const PLATS: Plat[] = [
  {
    platform: 'win32',
    goTarget: 'windows_amd64',
    bundleDir: path.join(RESOURCES, 'win'),
    libName: 'libcronet.dll',
    coreName: 'sing-box.exe',
  },
  {
    platform: 'linux',
    goTarget: 'linux_amd64',
    bundleDir: path.join(RESOURCES, 'linux'),
    libName: 'libcronet.so',
    coreName: 'sing-box',
  },
];

const coreDir = () => path.join(ROOT, 'core_update');
const storeLib = (p: Plat, v: string) => path.join(ROOT, 'cronet', v, p.libName);

/** 合成「内核」：含 Go build info dep 行；version=null → 不含（fork / 非 Go / 无 naive）。 */
function coreBytes(p: Plat, version: string | null): Buffer {
  const dep = version
    ? `dep\tgithub.com/sagernet/cronet-go/lib/${p.goTarget}\t${version}\th1:abc=\n`
    : 'not a go binary';
  return Buffer.concat([Buffer.alloc(256, 0x90), Buffer.from(dep), Buffer.alloc(256, 0)]);
}

function writeCore(p: Plat, dir: string, version: string | null): string {
  fsSync.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, p.coreName);
  fsSync.writeFileSync(f, coreBytes(p, version));
  fsSync.chmodSync(f, 0o755);
  return f;
}

function writeFile(f: string, content: string): void {
  fsSync.mkdirSync(path.dirname(f), { recursive: true });
  fsSync.writeFileSync(f, content);
}

beforeEach(() => {
  for (const d of [RESOURCES, coreDir(), path.join(ROOT, 'cronet'), path.join(ROOT, 'src')]) {
    fsSync.rmSync(d, { recursive: true, force: true });
  }
  setArch('x64');
});

afterAll(() => {
  setPlatform(REAL_PLATFORM);
  setArch(REAL_ARCH);
  fsSync.rmSync(ROOT, { recursive: true, force: true });
});

for (const p of PLATS) {
  describe(`platform=${p.platform}`, () => {
    let rm: ResourceManager;
    beforeEach(() => {
      setPlatform(p.platform);
      rm = new ResourceManager(); // 构造函数快照 platform/arch，须在 pin 之后
      writeFile(path.join(p.bundleDir, p.libName), 'BUNDLED-LIB'); // 11 字节
    });

    it('读出内核绑定的 cronet 版本（只认本平台子模块）', () => {
      const core = writeCore(p, coreDir(), NEW_V);
      expect(rm.getRequiredCronetVersion(core)).toBe(NEW_V);
      expect(rm.getRequiredCronetVersion(path.join(coreDir(), 'nope'))).toBeNull();
    });

    it('绑定 = 随包版本 → 随包库为权威源，缺库时从随包恢复', async () => {
      writeCore(p, coreDir(), BUNDLED_V);
      expect(rm.resolveCronetSource(coreDir())).toMatchObject({ kind: 'bundled' });
      expect(rm.getCronetLibStatus()).toBe('copy-failed');
      await expect(rm.ensureCronetHealthy(coreDir())).resolves.toEqual({ action: 'restored' });
      expect(fsSync.readFileSync(path.join(coreDir(), p.libName), 'utf-8')).toBe('BUNDLED-LIB');
      expect(rm.getCronetLibStatus()).toBe('available');
    });

    it('读不出版本（fork / 非 Go 构建）→ 沿用随包库（旧行为零回归）', async () => {
      writeCore(p, coreDir(), null);
      expect(rm.resolveCronetSource(coreDir())).toMatchObject({ kind: 'bundled' });
      await expect(rm.ensureCronetHealthy(coreDir())).resolves.toEqual({ action: 'restored' });
      expect(rm.getCronetLibStatus()).toBe('available');
    });

    it('绑定 ≠ 随包、库存无 → mismatch：不拿随包库凑数，也不改动已有的库', async () => {
      writeCore(p, coreDir(), NEW_V);
      // 用户现场：旧版 FlowZX 在内核旁放了随包旧库（与随包同大小，旧判据会判 available）
      writeFile(path.join(coreDir(), p.libName), 'BUNDLED-LIB');
      expect(rm.getCronetLibStatus()).toBe('mismatch');
      expect(rm.hasCronetLib()).toBe(false);
      await expect(rm.ensureCronetHealthy(coreDir(), { strong: true })).resolves.toEqual({
        action: 'failed',
        reason: 'version-mismatch',
      });
      expect(fsSync.readFileSync(path.join(coreDir(), p.libName), 'utf-8')).toBe('BUNDLED-LIB');
    });

    it('绑定 ≠ 随包、库存有 → 以库存库自愈（覆盖错配的随包旧库）', async () => {
      writeCore(p, coreDir(), NEW_V);
      writeFile(path.join(coreDir(), p.libName), 'BUNDLED-LIB');
      writeFile(storeLib(p, NEW_V), 'NEW-LIB-FROM-ARCHIVE');
      expect(rm.resolveCronetSource(coreDir())).toMatchObject({ kind: 'store', version: NEW_V });
      expect(rm.getCronetLibStatus()).toBe('copy-failed'); // 大小与配套库不符
      await expect(rm.ensureCronetHealthy(coreDir())).resolves.toEqual({ action: 'restored' });
      expect(fsSync.readFileSync(path.join(coreDir(), p.libName), 'utf-8')).toBe(
        'NEW-LIB-FROM-ARCHIVE'
      );
      expect(rm.getCronetLibStatus()).toBe('available');
    });

    it('adoptCronetFromCoreDir：只收非随包版本且目录里确有库；重复收取幂等', async () => {
      const src = path.join(ROOT, 'src');
      writeCore(p, src, NEW_V);
      writeFile(path.join(src, p.libName), 'NEW-LIB-FROM-ARCHIVE');
      await expect(rm.adoptCronetFromCoreDir(src)).resolves.toEqual({
        adopted: true,
        version: NEW_V,
      });
      expect(fsSync.readFileSync(storeLib(p, NEW_V), 'utf-8')).toBe('NEW-LIB-FROM-ARCHIVE');
      await expect(rm.adoptCronetFromCoreDir(src)).resolves.toEqual({
        adopted: true,
        version: NEW_V,
      });

      // 随包版本：不进库存
      const src2 = path.join(ROOT, 'src', 'bundled');
      writeCore(p, src2, BUNDLED_V);
      writeFile(path.join(src2, p.libName), 'BUNDLED-LIB');
      await expect(rm.adoptCronetFromCoreDir(src2)).resolves.toEqual({
        adopted: false,
        version: BUNDLED_V,
      });
      expect(fsSync.existsSync(path.join(ROOT, 'cronet', BUNDLED_V))).toBe(false);

      // 压缩包里没库：不收（naive 届时判 mismatch，被跳过而不是崩）
      const src3 = path.join(ROOT, 'src', 'nolib');
      writeCore(p, src3, OTHER_V);
      await expect(rm.adoptCronetFromCoreDir(src3)).resolves.toEqual({
        adopted: false,
        version: OTHER_V,
      });
    });

    it('adoptCronetFromCoreDir：手动替换时按所选文件（非标准文件名）判定版本', async () => {
      const src = path.join(ROOT, 'src');
      fsSync.mkdirSync(src, { recursive: true });
      const picked = path.join(src, 'my-sing-box-build');
      fsSync.writeFileSync(picked, coreBytes(p, NEW_V));
      writeFile(path.join(src, p.libName), 'NEW-LIB-FROM-ARCHIVE');
      await expect(rm.adoptCronetFromCoreDir(src, picked)).resolves.toEqual({
        adopted: true,
        version: NEW_V,
      });
    });

    it('pruneCronetStore：只留仍被引用（现役 / 备份）的版本', async () => {
      writeFile(storeLib(p, NEW_V), 'NEW');
      writeFile(storeLib(p, OTHER_V), 'OTHER');
      const live = writeCore(p, coreDir(), NEW_V);
      await rm.pruneCronetStore([live, path.join(ROOT, 'missing-backup')]);
      expect(fsSync.existsSync(storeLib(p, NEW_V))).toBe(true);
      expect(fsSync.existsSync(path.join(ROOT, 'cronet', OTHER_V))).toBe(false);
    });
  });
}

describe('macOS：cronet 静态编入 → 版本配套逻辑全部 no-op', () => {
  it('status 恒 available；adopt / prune 不动库存', async () => {
    setPlatform('darwin');
    setArch('arm64');
    const rm = new ResourceManager();
    expect(rm.getCronetLibStatus()).toBe('available');
    const src = path.join(ROOT, 'src');
    fsSync.mkdirSync(src, { recursive: true });
    await expect(rm.adoptCronetFromCoreDir(src)).resolves.toEqual({
      adopted: false,
      version: null,
    });
    writeFile(storeLib(PLATS[1], OTHER_V), 'KEEP');
    await rm.pruneCronetStore([]);
    expect(fsSync.existsSync(storeLib(PLATS[1], OTHER_V))).toBe(true);
  });
});
