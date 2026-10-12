/**
 * WindowsServiceHelper 纯逻辑单测（无 Windows 机/无命名管道）：
 *  - 平台门控：非 win32 安全降级（supported=false / ready=false），绝不触发 SCM/管道。
 *  - 提权脚本生成（runtime 最脆点）：sc create/start、binPath 锁定 exe+flags、token ACL、卸载脚本。
 *  - PowerShell 单引号转义。
 *  - 锁定内核路径漂移：解析 `sc qc` 的 --singbox、与现役核比较（含 OEM 代码页乱码的非 ASCII 路径）、状态里的
 *    pathMismatch / needsRepair、锁定路径缓存与装卸后失效。
 * 真机行为（UAC、sc 引号语义、管道连通）属 Windows 真机必验清单，不在单测范围。
 */
// sc.exe qc 走 child_process.execFile：可替换（其余 API 保持真实实现）。
const mockExecFile = jest.fn();
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: (...a: unknown[]) => mockExecFile(...a),
}));

import {
  WindowsServiceHelper,
  lockedSingboxPathDiffers,
  parseLockedSingboxPath,
} from '../WindowsServiceHelper';
import { resourceManager } from '../ResourceManager';
import { system32 } from '../../utils/win-system32';

// 「非 Windows 安全降级」只在非 Windows 宿主可测：helper 直接读 process.platform（无注入点），
// 在 Windows CI runner（win32）上该降级路径不可达 → 跳过；其逻辑由 macOS/Linux runner 覆盖。
const describeNonWin = process.platform === 'win32' ? describe.skip : describe;

describe('WindowsServiceHelper', () => {
  describeNonWin('非 Windows 平台安全降级', () => {
    // 测试宿主非 Windows（process.platform !== 'win32'）→ 所有方法降级，不连 SCM/管道。
    const helper = new WindowsServiceHelper();

    it('getStatus 返回 supported=false 的空状态', async () => {
      const s = await helper.getStatus();
      expect(s.supported).toBe(false);
      expect(s.installed).toBe(false);
      expect(s.ready).toBe(false);
      expect(s.needsRepair).toBe(false);
      expect(s.backgroundDisabled).toBe(false);
      expect(s.pathMismatch).toBe(false);
      expect(s.loaded).toBeNull();
    });

    it('isReady 返回 false（不尝试连接管道）', async () => {
      await expect(helper.isReady()).resolves.toBe(false);
    });

    it('install/uninstall 在非 Windows 报「仅 Windows 支持」', async () => {
      const i = await helper.install();
      expect(i.success).toBe(false);
      expect(i.error).toContain('Windows');
      const u = await helper.uninstall();
      expect(u.success).toBe(false);
      expect(u.error).toContain('Windows');
    });
  });

  describe('提权脚本生成', () => {
    const helper = new WindowsServiceHelper() as unknown as {
      buildInstallScript(exe: string, sb: string, conf: string, token: string): string;
      buildUninstallScript(): string;
      psq(s: string): string;
    };

    it('psq 转义单引号（PowerShell 双写规则）', () => {
      expect(helper.psq("a'b")).toBe("a''b");
      expect(helper.psq('plain')).toBe('plain');
    });

    it('install 脚本锁定 exe + flags、设 token ACL、sc create LocalSystem auto-start', () => {
      const script = helper.buildInstallScript(
        'C:\\Program Files\\FlowZ\\com.flowz.helper.exe',
        'C:\\Program Files\\FlowZ\\sing-box.exe',
        'C:\\Users\\doveh\\AppData\\Roaming\\FlowZ',
        'deadbeefdeadbeef'
      );
      // New-Service（非 sc create binPath=）：BinaryPathName 单一字符串直达 CreateService，绕开 CommandLineToArgvW 碎裂
      expect(script).toContain('New-Service -Name FlowZHelper -BinaryPathName $bp');
      expect(script).toContain('-StartupType Automatic');
      expect(script).not.toContain('binPath='); // 不得再用 sc create binPath= 的脆弱引号路径
      expect(script).not.toContain('-Credential'); // 锁定默认账户=LocalSystem 不变量（防误加凭据改成 NetworkService）
      // MED-1：sc delete 异步「标记删除」→ 轮询等服务消失 + New-Service 1072 退避重试
      expect(script).toContain('Get-Service');
      expect(script).toContain('1072');
      // 各含空格路径用**真双引号**包裹（非 \"），锁定 exe + 三参
      expect(script).toContain('--singbox "C:\\Program Files\\FlowZ\\sing-box.exe"');
      expect(script).toContain('--confdir "C:\\Users\\doveh\\AppData\\Roaming\\FlowZ"');
      expect(script).toContain('--support');
      // U1 外置：binPath 的引导 exe 必须指向 ProgramData 外置副本、而非 app 安装目录内的 helper.exe（根因修复——
      // 否则服务锁定 app 内文件 → 更新覆盖失败 + 卸载留孤儿）。slash 方向随测试宿主不同，故用 ProgramData 子串判定。
      expect(script).toMatch(/\$bp = '"[^']*ProgramData[^']*com\.flowz\.helper\.exe" --singbox/);
      // 反向不变量：binPath 引导 exe 绝不再是 app 的 Program Files 路径（防回归到「锁 app 内二进制」）。
      expect(script).not.toMatch(/\$bp = '"[^']*Program Files[^']*com\.flowz\.helper\.exe"/);
      // 复制源是 app 内置 helper.exe；目的是 ProgramData\FlowZ；带 -Force 覆盖 + 退避重试兜解锁窗口竞态。
      expect(script).toContain("$helperSrc = 'C:\\Program Files\\FlowZ\\com.flowz.helper.exe'");
      expect(script).toMatch(
        /\$helperDst = '[^']*ProgramData[^']*FlowZ[^']*com\.flowz\.helper\.exe'/
      );
      expect(script).toContain('Copy-Item -LiteralPath $helperSrc -Destination $helperDst -Force');
      expect(script).toContain('复制 helper.exe 到 ProgramData 失败'); // 复制失败 fail-loud（不静默留旧副本）
      // 目录 ACL 硬化（防本地提权 + 闭 token TOCTOU）：去继承 + 仅 SYSTEM/Administrators 完全控制并 (OI)(CI) 下传。
      // ProgramData 默认让 Users 能在子目录建/删文件 → 不锁目录则普通用户可替换以 SYSTEM 运行的 helper.exe（=提权）。
      // icacls 经 System32 绝对路径调（规避 PATH 缺失），PS 调用算子 & '<abs>'
      expect(script).toContain(`& '${system32('icacls.exe')}' $support /inheritance:r`);
      expect(script).toContain(
        `& '${system32('icacls.exe')}' $support /grant:r "SYSTEM:(OI)(CI)(F)" "Administrators:(OI)(CI)(F)"`
      );
      // 外置副本再显式收紧：去继承、仅 SYSTEM/Administrators 完全控制。
      expect(script).toContain(`& '${system32('icacls.exe')}' $helperDst /inheritance:r`);
      expect(script).toContain(
        `& '${system32('icacls.exe')}' $helperDst /grant:r "SYSTEM:(F)" "Administrators:(F)"`
      );
      // 关键不变量：SYSTEM helper 目录/二进制对 Users 零授权（绝不出现 Users 授权 → 杜绝替换/提权）。
      expect(script).not.toContain('Users:(RX)');
      expect(script).not.toContain('"Users');
      // 启动服务（sc.exe 经 System32 绝对路径调）
      expect(script).toContain(`& '${system32('sc.exe')}' start FlowZHelper`);
      // 幂等：重装先停删旧服务
      expect(script).toContain(`& '${system32('sc.exe')}' stop FlowZHelper`);
      expect(script).toContain(`& '${system32('sc.exe')}' delete FlowZHelper`);
      // token 值写入
      expect(script).toContain('deadbeefdeadbeef');
      // 重装可重入：写 token 前先删旧 token（自愈旧版「Admin 只读」残留——否则 Set-Content 覆盖只读文件被拒，真机根因）。
      expect(script).toContain('Remove-Item -Force -Path $tokenFile -ErrorAction SilentlyContinue');
      // 关键不变量：token **绝不**被设成 Admin 只读（机密性靠目录锁，不靠 token 只读；只读会破坏重装覆盖）。
      expect(script).not.toContain('icacls $tokenFile');
      expect(script).not.toContain('SYSTEM:(R)');
      // 删 token 必须在写 token 之前（顺序正确才自愈）。
      expect(script.indexOf('Remove-Item -Force -Path $tokenFile')).toBeLessThan(
        script.indexOf('Set-Content -Path $tokenFile')
      );
      // 受保护目录（默认 ProgramData\FlowZ）
      expect(script).toContain('FlowZ');
    });

    it('uninstall 脚本停 + 删服务 + 清受保护目录', () => {
      const script = helper.buildUninstallScript();
      expect(script).toContain(`& '${system32('sc.exe')}' stop FlowZHelper`);
      expect(script).toContain(`& '${system32('sc.exe')}' delete FlowZHelper`);
      expect(script).toContain('Remove-Item');
      expect(script).toContain('FlowZ');
    });
  });
});

describe('WindowsServiceHelper：服务锁定的 sing-box 路径漂移', () => {
  const BUNDLED = 'C:\\Program Files\\FlowZ\\resources\\win\\sing-box.exe';
  const SLOT = 'C:\\Users\\dove\\AppData\\Roaming\\FlowZ\\core_update\\sing-box.exe';
  const qc = (singbox: string, quoted = true) =>
    [
      '[SC] QueryServiceConfig SUCCESS',
      '',
      'SERVICE_NAME: FlowZHelper',
      '        TYPE               : 10  WIN32_OWN_PROCESS',
      '        START_TYPE         : 2   AUTO_START',
      '        ERROR_CONTROL      : 1   NORMAL',
      `        BINARY_PATH_NAME   : "C:\\ProgramData\\FlowZ\\com.flowz.helper.exe" --singbox ${quoted ? `"${singbox}"` : singbox} --confdir "C:\\Users\\dove\\AppData\\Roaming\\FlowZ" --support "C:\\ProgramData\\FlowZ"`,
      '        LOAD_ORDER_GROUP   :',
      '        DISPLAY_NAME       : FlowZHelper',
      '        SERVICE_START_NAME : LocalSystem',
      '',
    ].join('\r\n');

  describe('parseLockedSingboxPath', () => {
    it('取 BINARY_PATH_NAME 里 --singbox 的值（真双引号 / 无引号形态）', () => {
      expect(parseLockedSingboxPath(qc(BUNDLED))).toBe(BUNDLED);
      expect(parseLockedSingboxPath(qc(SLOT))).toBe(SLOT);
      expect(parseLockedSingboxPath(qc('C:\\FlowZ\\sing-box.exe', false))).toBe(
        'C:\\FlowZ\\sing-box.exe'
      );
    });

    it('取不到（无该行 / 无 --singbox / 空输出）→ null', () => {
      expect(parseLockedSingboxPath('')).toBeNull();
      expect(parseLockedSingboxPath('[SC] OpenService FAILED 1060')).toBeNull();
      expect(
        parseLockedSingboxPath('        BINARY_PATH_NAME   : "C:\\x\\helper.exe" --confdir "C:\\y"')
      ).toBeNull();
    });

    it('非 ASCII 路径按 OEM 代码页输出、被 UTF-8 解码成乱码：引号切分仍取到完整的 --singbox 值', () => {
      // 「张三」的 GBK 字节按 UTF-8 解码 → 替换字符；ASCII 部分与引号原样保留
      const garbled = Buffer.from(
        `        BINARY_PATH_NAME   : "C:\\ProgramData\\FlowZ\\h.exe" --singbox "C:\\Users\\`
      ).toString('latin1');
      const out = Buffer.concat([
        Buffer.from(garbled, 'latin1'),
        Buffer.from([0xd5, 0xc5, 0xc8, 0xfd]),
        Buffer.from('\\AppData\\Roaming\\FlowZ\\core_update\\sing-box.exe" --confdir "C:\\y"'),
      ]).toString('utf8');
      const p = parseLockedSingboxPath(out);
      expect(p).toMatch(
        /^C:\\Users\\\uFFFD+\\AppData\\Roaming\\FlowZ\\core_update\\sing-box\.exe$/
      );
    });
  });

  describe('lockedSingboxPathDiffers', () => {
    it('纯 ASCII：大小写不敏感全路径比较', () => {
      expect(lockedSingboxPathDiffers(BUNDLED, BUNDLED)).toBe(false);
      expect(lockedSingboxPathDiffers(BUNDLED.toUpperCase(), BUNDLED)).toBe(false);
      expect(lockedSingboxPathDiffers(BUNDLED, SLOT)).toBe(true); // 首次核更新 / 版本选择后
      expect(lockedSingboxPathDiffers(SLOT, BUNDLED)).toBe(true);
      expect(lockedSingboxPathDiffers('D:\\FlowZ\\sing-box.exe', BUNDLED)).toBe(true); // 安装目录变了
    });

    it('含非 ASCII（sc 输出已不可信）→ 只比是否为核更新槽位，不因乱码误报', () => {
      const realSlot = 'C:\\Users\\张三\\AppData\\Roaming\\FlowZ\\core_update\\sing-box.exe';
      const garbledSlot =
        'C:\\Users\\\uFFFD\uFFFD\uFFFD\\AppData\\Roaming\\FlowZ\\core_update\\sing-box.exe';
      expect(lockedSingboxPathDiffers(garbledSlot, realSlot)).toBe(false);
      expect(lockedSingboxPathDiffers(BUNDLED, realSlot)).toBe(true);
      expect(
        lockedSingboxPathDiffers('C:\\程序\\FlowZ\\sing-box.exe', 'C:\\程序\\FlowZ\\sing-box.exe')
      ).toBe(false);
    });
  });

  describe('getStatus / 锁定路径缓存（强制 supported，任意宿主可测）', () => {
    type Internals = {
      queryService: () => Promise<{ exists: boolean; running: boolean }>;
      token: () => string;
      sendCommand: (rest: string[], t: number) => Promise<string>;
      queryLockedSingboxPath: () => Promise<string | null>;
    };
    function makeHelper(o: { installed?: boolean; ready?: boolean } = {}) {
      const helper = new WindowsServiceHelper();
      Object.defineProperty(helper, 'supported', { get: () => true });
      const h = helper as unknown as Internals;
      jest
        .spyOn(h, 'queryService')
        .mockResolvedValue({ exists: o.installed ?? true, running: true });
      jest.spyOn(h, 'token').mockReturnValue('tok');
      jest
        .spyOn(h, 'sendCommand')
        .mockImplementation(async () => (o.ready === false ? 'ERR' : 'OK pong uid=0 v1'));
      return { helper, h };
    }
    const scOk = (singbox: string) =>
      mockExecFile.mockImplementation(
        (_f: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string) => void) =>
          cb(null, qc(singbox))
      );

    beforeEach(() => mockExecFile.mockReset());
    afterEach(() => jest.restoreAllMocks());

    it('服务锁定随包核、现役核已是 core_update → pathMismatch + needsRepair，并给出锁定路径', async () => {
      jest.spyOn(resourceManager, 'getSingBoxPath').mockReturnValue(SLOT);
      scOk(BUNDLED);
      const { helper } = makeHelper();
      await expect(helper.getStatus(true)).resolves.toMatchObject({
        installed: true,
        ready: true,
        pathMismatch: true,
        needsRepair: true,
        installedSingboxPath: BUNDLED,
      });
      expect(mockExecFile).toHaveBeenCalledWith(
        system32('sc.exe'),
        ['qc', 'FlowZHelper', '8192'],
        expect.objectContaining({ windowsHide: true }),
        expect.any(Function)
      );
    });

    it('锁定路径与现役核一致 → 不漂移、就绪即不需修复', async () => {
      jest.spyOn(resourceManager, 'getSingBoxPath').mockReturnValue(SLOT);
      scOk(SLOT);
      const { helper } = makeHelper();
      await expect(helper.getStatus(true)).resolves.toMatchObject({
        pathMismatch: false,
        needsRepair: false,
        installedSingboxPath: SLOT,
      });
    });

    it('sc qc 失败 → 无从判断，不报漂移（也不缓存失败，下次重取）', async () => {
      jest.spyOn(resourceManager, 'getSingBoxPath').mockReturnValue(SLOT);
      mockExecFile.mockImplementation(
        (_f: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string) => void) =>
          cb(new Error('timeout'), '')
      );
      const { helper } = makeHelper();
      await expect(helper.getStatus(true)).resolves.toMatchObject({
        pathMismatch: false,
        needsRepair: false,
        installedSingboxPath: null,
      });
      scOk(BUNDLED);
      await expect(helper.getStatus(true)).resolves.toMatchObject({ pathMismatch: true });
    });

    it('未安装 → 不查锁定路径；未就绪 → needsRepair（与路径无关）', async () => {
      const a = makeHelper({ installed: false });
      await expect(a.helper.getStatus(true)).resolves.toMatchObject({
        installed: false,
        pathMismatch: false,
        needsRepair: false,
      });
      expect(mockExecFile).not.toHaveBeenCalled();
      jest.spyOn(resourceManager, 'getSingBoxPath').mockReturnValue(SLOT);
      scOk(SLOT);
      const b = makeHelper({ ready: false });
      await expect(b.helper.getStatus(true)).resolves.toMatchObject({
        ready: false,
        pathMismatch: false,
        needsRepair: true,
      });
    });

    it('锁定路径只查一次（状态高频刷新不反复 spawn sc）；install / uninstall 后作废重查', async () => {
      jest.spyOn(resourceManager, 'getSingBoxPath').mockReturnValue(SLOT);
      scOk(BUNDLED);
      const { helper } = makeHelper();
      await helper.getStatus(true);
      await helper.getStatus(true);
      expect(mockExecFile).toHaveBeenCalledTimes(1);
      // install：helper 二进制缺失即返回，但重新锁定前缓存已作废
      jest.spyOn(resourceManager, 'getWinHelperPath').mockReturnValue('Z:\\no-such-helper.exe');
      scOk(SLOT);
      const r = await helper.install();
      expect(r.success).toBe(false);
      await expect(helper.getStatus(true)).resolves.toMatchObject({ pathMismatch: false });
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });
  });
});
