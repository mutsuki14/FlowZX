/**
 * 从 Go 可执行文件内嵌的 build info 中读取某个依赖模块的版本（等价 `go version -m <bin>` 的 dep 行，零 Go 工具链依赖）。
 *
 * Go 链接器把模块信息以纯文本写进二进制（`dep\t<module path>\t<version>\t<h1:sum>\n`），`-s -w` 剥符号也保留，
 * 故可按字节扫描。用途：sing-box 经 purego 动态加载 libcronet，二进制里记着它编译时绑定的
 * `github.com/sagernet/cronet-go/lib/<goos>_<goarch>` 版本——据此判断「这个内核需要哪一版 libcronet」，
 * 避免把别的版本的库配给它（ABI 漂移只在运行期崩溃，`sing-box check` 发现不了）。
 *
 * 按块顺序读（不一次读入 ~80MB），块间保留重叠区防标记被块边界切开；找到第一处即返回。
 */
import { closeSync, openSync, readSync } from 'fs';

const DEFAULT_CHUNK = 4 * 1024 * 1024;
/** 标记之后到行尾（`<后缀>\t<版本>\t<sum>`）的最大字节数；超出视为畸形。 */
const MAX_TAIL = 512;
/** Go 模块伪版本 / 语义化版本的保守形状（同时保证可安全用作目录名）。 */
const VERSION_RE = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface GoDepMatch {
  /** 模块路径中 modulePrefix 之后的部分（如 `windows_amd64`）。 */
  suffix: string;
  /** 依赖版本（如 `v0.0.0-20260912104006-c10c03c318db`）。 */
  version: string;
}

/**
 * 在 filePath 中查找首个 `dep\t<modulePrefix><suffix>\t<version>` 行。
 * @param modulePrefix 模块路径前缀，如 `github.com/sagernet/cronet-go/lib/`
 * @param accept       可选过滤（如只认本平台 suffix）；返回 false 的匹配跳过继续找
 * @returns 匹配结果；文件不可读 / 无该依赖 / 行畸形 → null
 */
export function findGoDepVersion(
  filePath: string,
  modulePrefix: string,
  accept?: (m: GoDepMatch) => boolean,
  chunkSize = DEFAULT_CHUNK
): GoDepMatch | null {
  const marker = Buffer.from(`dep\t${modulePrefix}`, 'utf-8');
  const overlap = marker.length + MAX_TAIL;
  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const chunk = Buffer.alloc(Math.max(chunkSize, overlap * 2));
    let carry = Buffer.alloc(0);
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      const eof = n === 0;
      const buf = eof ? carry : Buffer.concat([carry, chunk.subarray(0, n)]);
      let from = 0;
      for (;;) {
        const at = buf.indexOf(marker, from);
        if (at < 0) break;
        const tailStart = at + marker.length;
        const nl = buf.indexOf(0x0a, tailStart);
        if (nl < 0 || nl - tailStart > MAX_TAIL) {
          // 行尾不在本缓冲：未到 EOF 则留给下一轮（carry 从标记处开始）；已到 EOF 即畸形，跳过。
          if (!eof && buf.length - at <= overlap) break;
          from = tailStart;
          continue;
        }
        const [suffix, version] = buf.subarray(tailStart, nl).toString('utf-8').split('\t');
        const m = { suffix: suffix ?? '', version: version ?? '' };
        if (/^[\w.-]+$/.test(m.suffix) && VERSION_RE.test(m.version) && (!accept || accept(m))) {
          return m;
        }
        from = nl;
      }
      if (eof) return null;
      carry = buf.subarray(Math.max(0, buf.length - overlap));
    }
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

/**
 * 读 Go build info 里的构建设置（`build\t<key>=<value>` 行，等价 `go version -m` 的 build 段），如 key='-tags' 得到
 * 编译 tag 串（`with_quic,with_awg,...`）。用途：不 spawn 内核即可判断它是否编入 AmneziaWG（with_awg）/ gVisor（with_gvisor）。
 * 找不到 / 读失败 → null。
 */
export function findGoBuildSetting(
  filePath: string,
  key: string,
  chunkSize = DEFAULT_CHUNK
): string | null {
  const marker = Buffer.from(`build\t${key}=`, 'utf-8');
  const maxTail = 8192; // tag 串可能较长
  const overlap = marker.length + maxTail;
  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const chunk = Buffer.alloc(Math.max(chunkSize, overlap * 2));
    let carry = Buffer.alloc(0);
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      const eof = n === 0;
      const buf = eof ? carry : Buffer.concat([carry, chunk.subarray(0, n)]);
      const at = buf.indexOf(marker);
      if (at >= 0) {
        const start = at + marker.length;
        const nl = buf.indexOf(0x0a, start);
        if (nl >= 0 && nl - start <= maxTail) return buf.subarray(start, nl).toString('utf-8');
        if (eof || buf.length - at > overlap) return null;
        carry = buf.subarray(at);
        continue;
      }
      if (eof) return null;
      carry = buf.subarray(Math.max(0, buf.length - overlap));
    }
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}
