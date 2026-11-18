/**
 * findGoDepVersion：从 Go 二进制内嵌 build info 读依赖版本（sing-box 绑定的 libcronet 版本据此判定）。
 * 用合成文件承载 `dep\t<path>\t<version>\t<sum>\n` 行（与 `go version -m` 读的同一段明文），覆盖块边界、过滤、畸形行。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findGoDepVersion } from '../go-buildinfo';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-buildinfo-'));
const PREFIX = 'github.com/sagernet/cronet-go/lib/';
const V_NEW = 'v0.0.0-20260912104006-c10c03c318db';
const V_OLD = 'v0.0.0-20260807161529-8d42107dcdfc';

function depLine(suffix: string, version: string): string {
  return `dep\t${PREFIX}${suffix}\t${version}\th1:fKs7KaruaDhStaiYpaqMQXDCmAc4YmNLI/pBkPYvwH8=\n`;
}

function write(name: string, ...parts: Array<string | Buffer>): string {
  const p = path.join(TMP, name);
  fs.writeFileSync(
    p,
    Buffer.concat(parts.map((x) => (typeof x === 'string' ? Buffer.from(x) : x)))
  );
  return p;
}

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('findGoDepVersion', () => {
  it('读出 dep 行的模块后缀与版本', () => {
    const p = write(
      'a.bin',
      Buffer.alloc(1000, 0),
      `path\tgithub.com/sagernet/sing-box/cmd/sing-box\nmod\tgithub.com/sagernet/sing-box\t(devel)\t\n`,
      `dep\tgithub.com/sagernet/cronet-go\tv0.0.0-20260912104727-0d28acc44093\th1:x=\n`,
      depLine('windows_amd64', V_NEW),
      Buffer.alloc(1000, 0xff)
    );
    expect(findGoDepVersion(p, PREFIX)).toEqual({ suffix: 'windows_amd64', version: V_NEW });
  });

  it('标记被块边界切开也能读到（重叠区）', () => {
    const line = depLine('linux_amd64', V_NEW);
    // chunk=64：让 dep 行横跨多个块
    for (const pad of [0, 1, 7, 30, 63, 64, 65, 100]) {
      const p = write(`edge-${pad}.bin`, Buffer.alloc(pad, 0x41), line, Buffer.alloc(50, 0));
      expect(findGoDepVersion(p, PREFIX, undefined, 64)).toEqual({
        suffix: 'linux_amd64',
        version: V_NEW,
      });
    }
  });

  it('accept 过滤：跳过别的平台，返回首个被接受的', () => {
    const p = write('multi.bin', depLine('android_arm64', V_OLD), depLine('windows_amd64', V_NEW));
    expect(findGoDepVersion(p, PREFIX, (m) => m.suffix === 'windows_amd64')).toEqual({
      suffix: 'windows_amd64',
      version: V_NEW,
    });
    expect(findGoDepVersion(p, PREFIX, (m) => m.suffix === 'linux_amd64')).toBeNull();
  });

  it('无该依赖 / 文件不存在 / 版本形状不合法 → null', () => {
    expect(findGoDepVersion(write('none.bin', Buffer.alloc(4096, 0)), PREFIX)).toBeNull();
    expect(findGoDepVersion(path.join(TMP, 'missing.bin'), PREFIX)).toBeNull();
    // 版本里混入路径分隔符（防被当目录名穿越）→ 拒绝
    expect(
      findGoDepVersion(write('bad.bin', depLine('windows_amd64', '../../evil')), PREFIX)
    ).toBeNull();
  });

  it('行尾缺失（截断文件）→ null，不抛', () => {
    const p = write('trunc.bin', `dep\t${PREFIX}windows_amd64\t${V_NEW}`);
    expect(findGoDepVersion(p, PREFIX)).toBeNull();
  });
});
