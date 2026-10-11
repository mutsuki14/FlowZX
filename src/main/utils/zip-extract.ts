/**
 * 纯 Node 的单条目 ZIP 解压（zlib.inflateRaw）——Xray 版本切换只需取 release zip 里的 xray[.exe]。
 *
 * 为什么不复用 CoreDownloader.extractCore：它依赖系统 `unzip`（精简 Linux 发行版可能没有）/ PowerShell
 * Expand-Archive，且整包解出（Xray zip 还带 geoip/geosite 等 ~27MB 无用文件）。本实现零系统工具、零新依赖。
 *
 * 只支持 GitHub release 资产这一种「规整」zip：单卷、非 zip64、未加密、stored(0)/deflate(8)。其余一律拒绝（fail-closed）：
 *  - EOCD / 中央目录 / 本地文件头逐项校验签名与边界（偏移/长度不越界、数据区不与中央目录重叠、两处文件名一致）；
 *  - 解压后长度 == 中央目录声明的 uncompressed size，且 CRC-32 == 声明值（摘要之外的第二道完整性闸）；
 *  - 任一条目名含路径把戏（绝对路径 / 盘符 / 反斜杠 / `.`、`..` 段 / NUL）或同名重复 → 整包拒绝（官方资产从不出现）；
 *  - 匹配：顶层或下一层目录中 basename 等于 entryName 的文件（大小写敏感）；顶层优先；同层多个命中 → 歧义拒绝。
 * 写盘：`<dest>.part`（POSIX 0o755）→ rename 到 dest；失败清理 .part。dest 由调用方给定，条目名从不参与拼路径。
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import * as zlib from 'zlib';

/** 压缩包整体上限（Xray 资产 ~10-25MB；整包读入内存，防被灌 GB 级文件撞 OOM）。 */
export const MAX_ZIP_BYTES = 256 * 1024 * 1024;
/** 单条目解压后上限（xray ~40MB）。 */
export const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_LEN = 22;
const CENTRAL_LEN = 46;
const LOCAL_LEN = 30;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8 = 0x0800;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const ZIP64_EXTRA_ID = 0x0001;

/** 解压失败（code 固定，供调用方映射为 EXTRACT_FAILED）。 */
export class ZipExtractError extends Error {
  readonly code = 'EXTRACT_FAILED';
  constructor(message: string) {
    super(message);
    this.name = 'ZipExtractError';
  }
}

interface CentralEntry {
  name: string;
  nameBytes: Buffer;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

let crcTable: Uint32Array | null = null;

/** CRC-32（IEEE）纯 JS 实现：zlib.crc32 缺席（旧 Node）时的兜底。 */
export function crc32Js(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** CRC-32：优先 zlib.crc32（Node ≥ 20.15 / 22.2，原生实现），否则纯 JS。 */
export function crc32(data: Uint8Array): number {
  return typeof zlib.crc32 === 'function' ? zlib.crc32(data) >>> 0 : crc32Js(data);
}

function inflateRawLimited(data: Buffer, maxOutputLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zlib.inflateRaw(data, { maxOutputLength }, (err, out) => (err ? reject(err) : resolve(out)));
  });
}

/** 条目名是否含路径把戏（任一命中即整包拒绝）。 */
function isUnsafeEntryName(name: string): boolean {
  if (!name || name.includes('\0') || name.includes('\\')) return true;
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return true;
  const segs = name.split('/');
  // 目录条目以 '/' 结尾 → 末段为空串，合法；其余空段（`a//b`）/ `.` / `..` 均拒绝。
  return segs.some(
    (seg, i) => seg === '..' || seg === '.' || (seg === '' && i !== segs.length - 1)
  );
}

function readCentralDirectory(buf: Buffer): { entries: CentralEntry[]; cdOffset: number } {
  if (buf.length < EOCD_LEN) throw new ZipExtractError('不是有效的 ZIP 文件（过短）');
  // EOCD：从尾部往前找签名，且「记录 + 注释」须恰好到文件尾（防误认注释里的伪签名、防尾部夹带数据）。
  let eocd = -1;
  const minPos = Math.max(0, buf.length - EOCD_LEN - 0xffff);
  for (let i = buf.length - EOCD_LEN; i >= minPos; i--) {
    if (
      buf.readUInt32LE(i) === SIG_EOCD &&
      i + EOCD_LEN + buf.readUInt16LE(i + 20) === buf.length
    ) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipExtractError('找不到 ZIP 目录结尾记录（文件被截断或已损坏）');
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === SIG_ZIP64_LOCATOR) {
    throw new ZipExtractError('不支持 zip64 压缩包');
  }
  const diskNo = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const entriesOnDisk = buf.readUInt16LE(eocd + 8);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (
    total === 0xffff ||
    entriesOnDisk === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff
  ) {
    throw new ZipExtractError('不支持 zip64 压缩包');
  }
  if (diskNo !== 0 || cdDisk !== 0 || entriesOnDisk !== total) {
    throw new ZipExtractError('不支持分卷压缩包');
  }
  if (cdOffset + cdSize !== eocd) {
    throw new ZipExtractError('ZIP 中央目录位置与结尾记录不符（文件被截断或已损坏）');
  }

  const entries: CentralEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + CENTRAL_LEN > eocd || buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new ZipExtractError('ZIP 中央目录损坏');
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const diskStart = buf.readUInt16LE(p + 34);
    const localOffset = buf.readUInt32LE(p + 42);
    const nameStart = p + CENTRAL_LEN;
    const extraStart = nameStart + nameLen;
    const next = extraStart + extraLen + commentLen;
    if (next > eocd) throw new ZipExtractError('ZIP 中央目录损坏（条目越界）');
    const nameBytes = buf.subarray(nameStart, extraStart);
    const name = nameBytes.toString(flags & FLAG_UTF8 ? 'utf8' : 'latin1');
    let zip64 =
      compressedSize === 0xffffffff ||
      size === 0xffffffff ||
      localOffset === 0xffffffff ||
      diskStart === 0xffff;
    for (let q = extraStart; q + 4 <= extraStart + extraLen; ) {
      const id = buf.readUInt16LE(q);
      const len = buf.readUInt16LE(q + 2);
      if (id === ZIP64_EXTRA_ID) zip64 = true;
      q += 4 + len;
    }
    if (zip64) throw new ZipExtractError('不支持 zip64 压缩包');
    if (diskStart !== 0) throw new ZipExtractError('不支持分卷压缩包');
    entries.push({ name, nameBytes, flags, method, crc, compressedSize, size, localOffset });
    p = next;
  }
  if (p !== eocd) throw new ZipExtractError('ZIP 中央目录长度与声明不符');
  return { entries, cdOffset };
}

function pickEntry(entries: CentralEntry[], entryName: string): CentralEntry {
  const seen = new Set<string>();
  const top: CentralEntry[] = [];
  const nested: CentralEntry[] = [];
  for (const e of entries) {
    if (isUnsafeEntryName(e.name)) {
      throw new ZipExtractError(`压缩包含不安全的条目路径，已拒绝: ${JSON.stringify(e.name)}`);
    }
    if (seen.has(e.name)) {
      throw new ZipExtractError(`压缩包含重复条目，已拒绝: ${JSON.stringify(e.name)}`);
    }
    seen.add(e.name);
    if (e.name.endsWith('/')) continue; // 目录条目
    const segs = e.name.split('/');
    if (segs.length === 1 && segs[0] === entryName) top.push(e);
    else if (segs.length === 2 && segs[1] === entryName) nested.push(e);
  }
  const pool = top.length > 0 ? top : nested;
  if (pool.length === 0) throw new ZipExtractError(`压缩包中没有 ${entryName}`);
  if (pool.length > 1) throw new ZipExtractError(`压缩包中有多个 ${entryName}，无法确定取哪个`);
  return pool[0];
}

async function inflateEntry(buf: Buffer, e: CentralEntry, cdOffset: number): Promise<Buffer> {
  if (e.flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) {
    throw new ZipExtractError('不支持加密的压缩条目');
  }
  if (e.method !== METHOD_STORED && e.method !== METHOD_DEFLATE) {
    throw new ZipExtractError(`不支持的压缩方式: ${e.method}`);
  }
  if (e.size > MAX_ENTRY_BYTES) throw new ZipExtractError(`条目过大（${e.size} 字节）`);

  const lho = e.localOffset;
  if (lho + LOCAL_LEN > cdOffset || buf.readUInt32LE(lho) !== SIG_LOCAL) {
    throw new ZipExtractError('ZIP 本地文件头损坏');
  }
  const lflags = buf.readUInt16LE(lho + 6);
  const lmethod = buf.readUInt16LE(lho + 8);
  const lnameLen = buf.readUInt16LE(lho + 26);
  const lextraLen = buf.readUInt16LE(lho + 28);
  if (lflags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) {
    throw new ZipExtractError('不支持加密的压缩条目');
  }
  if (lmethod !== e.method) throw new ZipExtractError('ZIP 本地文件头与中央目录不一致（压缩方式）');
  const lnameEnd = lho + LOCAL_LEN + lnameLen;
  if (lnameEnd > cdOffset || !buf.subarray(lho + LOCAL_LEN, lnameEnd).equals(e.nameBytes)) {
    throw new ZipExtractError('ZIP 本地文件头与中央目录不一致（文件名）');
  }
  // 无 data descriptor 时本地头自带 crc/尺寸，须与中央目录一致（有 descriptor 时本地头可为 0，以中央目录为准）。
  if (
    !(lflags & FLAG_DATA_DESCRIPTOR) &&
    (buf.readUInt32LE(lho + 14) !== e.crc ||
      buf.readUInt32LE(lho + 18) !== e.compressedSize ||
      buf.readUInt32LE(lho + 22) !== e.size)
  ) {
    throw new ZipExtractError('ZIP 本地文件头与中央目录不一致（尺寸/CRC）');
  }
  const dataStart = lnameEnd + lextraLen;
  const dataEnd = dataStart + e.compressedSize;
  if (dataEnd > cdOffset) throw new ZipExtractError('ZIP 条目数据越界（文件被截断或已损坏）');
  const compressed = buf.subarray(dataStart, dataEnd);

  let out: Buffer;
  if (e.method === METHOD_STORED) {
    if (e.compressedSize !== e.size) throw new ZipExtractError('ZIP 存储条目尺寸不一致');
    out = compressed;
  } else {
    try {
      out = await inflateRawLimited(compressed, Math.max(1, e.size));
    } catch (err) {
      throw new ZipExtractError(
        `解压数据失败（数据损坏、被截断或尺寸与声明不符）: ${(err as Error)?.message ?? err}`
      );
    }
  }
  if (out.length !== e.size) {
    throw new ZipExtractError(`解压尺寸不符：得到 ${out.length} 字节，声明 ${e.size}`);
  }
  if (crc32(out) !== e.crc) throw new ZipExtractError('CRC-32 校验失败（数据已损坏）');
  return out;
}

/**
 * 从 zipPath 取出名为 entryName 的单个文件（顶层或下一层目录），原子写到 destPath（POSIX 0o755）。
 * 任何结构/校验问题抛 ZipExtractError；dest 不会出现半成品（写 .part 后 rename）。
 */
export async function extractZipEntry(
  zipPath: string,
  entryName: string,
  destPath: string
): Promise<void> {
  if (!entryName || entryName.includes('/') || entryName.includes('\\')) {
    throw new ZipExtractError(`非法的条目名: ${entryName}`);
  }
  const st = await fs.stat(zipPath);
  if (!st.isFile()) throw new ZipExtractError('压缩包不是文件');
  if (st.size > MAX_ZIP_BYTES) throw new ZipExtractError(`压缩包过大（${st.size} 字节）`);
  const buf = await fs.readFile(zipPath);
  const { entries, cdOffset } = readCentralDirectory(buf);
  const entry = pickEntry(entries, entryName);
  const data = await inflateEntry(buf, entry, cdOffset);

  await fs.mkdir(path.dirname(destPath), { recursive: true });
  const part = `${destPath}.part`;
  try {
    await fs.writeFile(part, data, { mode: 0o755 });
    if (process.platform !== 'win32') await fs.chmod(part, 0o755);
    await fs.rename(part, destPath);
  } catch (e) {
    await fs.unlink(part).catch(() => {});
    throw e;
  }
}
