/**
 * zip-extract 单测：合成 zip（stored / deflate / 嵌套目录 / 各类损坏与把戏）+ 真实 XTLS 资产（存在才跑）。
 *
 * 为什么要钉这么多反面用例：解出来的文件会被当作 Xray 内核**直接执行**。压缩包摘要虽已校验过，但本模块是
 * 「摘要通过之后」的最后一道结构闸——任何「宽容」都可能让一个畸形包落地成半截/错误的可执行文件。
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';

import { crc32, crc32Js, extractZipEntry, ZipExtractError } from '../zip-extract';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-zip-'));
afterAll(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

interface Entry {
  name: string;
  data: Buffer;
  method?: number; // 0 stored / 8 deflate（缺省 8）
  flags?: number;
  crc?: number; // 覆盖声明 CRC
  size?: number; // 覆盖声明的解压尺寸
  compressed?: Buffer; // 覆盖压缩数据
  localName?: string; // 覆盖本地文件头里的文件名
  extra?: Buffer;
}

/** 生成一个规整 zip（可按条目覆写各字段以构造损坏）。 */
function buildZip(entries: Entry[], opts: { zip64Locator?: boolean; totalOverride?: number } = {}) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const method = e.method ?? 8;
    const flags = e.flags ?? 0x0800;
    const comp = e.compressed ?? (method === 8 ? zlib.deflateRawSync(e.data) : e.data);
    const crc = (e.crc ?? crc32(e.data)) >>> 0;
    const size = e.size ?? e.data.length;
    const name = Buffer.from(e.name, 'utf8');
    const lname = Buffer.from(e.localName ?? e.name, 'utf8');
    const extra = e.extra ?? Buffer.alloc(0);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(size >>> 0, 22);
    lh.writeUInt16LE(lname.length, 26);
    lh.writeUInt16LE(0, 28);
    const local = Buffer.concat([lh, lname, comp]);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x031e, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(size >>> 0, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(extra.length, 30);
    cd.writeUInt32LE((0o100755 << 16) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([cd, name, extra]));
    locals.push(local);
    offset += local.length;
  }
  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  const total = opts.totalOverride ?? entries.length;
  eocd.writeUInt16LE(total, 8);
  eocd.writeUInt16LE(total, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  const parts = [...locals, cdBuf];
  if (opts.zip64Locator) {
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    parts.push(loc); // 定位器紧贴 EOCD 之前（zip64 包的真实布局），只为触发 zip64 判据
  }
  parts.push(eocd);
  return Buffer.concat(parts);
}

let seq = 0;
function writeZip(buf: Buffer): string {
  const p = path.join(TMP, `t${seq++}.zip`);
  fs.writeFileSync(p, buf);
  return p;
}
const dest = () => path.join(TMP, `out${seq++}`, 'xray');

const BIN = Buffer.from('\x7fELF fake xray binary '.repeat(200));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('extractZipEntry：正常路径', () => {
  it('顶层 deflate 条目 → 逐字节一致，POSIX 下 0o755，无 .part 残留', async () => {
    const zip = writeZip(
      buildZip([
        { name: 'geoip.dat', data: Buffer.from('geo') },
        { name: 'xray', data: BIN },
        { name: 'LICENSE', data: Buffer.from('MPL') },
      ])
    );
    const out = dest();
    await extractZipEntry(zip, 'xray', out);
    expect(fs.readFileSync(out)).toEqual(BIN);
    expect(fs.existsSync(`${out}.part`)).toBe(false);
    if (process.platform !== 'win32') expect(fs.statSync(out).mode & 0o777).toBe(0o755);
  });

  it('stored 条目同样可取', async () => {
    const zip = writeZip(buildZip([{ name: 'xray', data: BIN, method: 0 }]));
    const out = dest();
    await extractZipEntry(zip, 'xray', out);
    expect(fs.readFileSync(out)).toEqual(BIN);
  });

  it('下一层目录中的条目可取（Xray-linux-64/xray）', async () => {
    const zip = writeZip(
      buildZip([
        { name: 'Xray-linux-64/', data: Buffer.alloc(0), method: 0 },
        { name: 'Xray-linux-64/xray', data: BIN },
      ])
    );
    const out = dest();
    await extractZipEntry(zip, 'xray', out);
    expect(fs.readFileSync(out)).toEqual(BIN);
  });

  it('顶层优先于下一层', async () => {
    const zip = writeZip(
      buildZip([
        { name: 'sub/xray', data: Buffer.from('nested') },
        { name: 'xray', data: BIN },
      ])
    );
    const out = dest();
    await extractZipEntry(zip, 'xray', out);
    expect(fs.readFileSync(out)).toEqual(BIN);
  });

  it('basename 大小写敏感，且只取完全同名（xray.exe 不匹配 xray）', async () => {
    const zip = writeZip(
      buildZip([
        { name: 'XRAY', data: Buffer.from('upper') },
        { name: 'xray.exe', data: Buffer.from('win') },
      ])
    );
    await expect(extractZipEntry(zip, 'xray', dest())).rejects.toThrow(/没有 xray/);
  });

  it('dest 已存在 → 原子替换为新内容', async () => {
    const zip = writeZip(buildZip([{ name: 'xray', data: BIN }]));
    const out = dest();
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, 'old');
    await extractZipEntry(zip, 'xray', out);
    expect(fs.readFileSync(out)).toEqual(BIN);
  });
});

describe('extractZipEntry：损坏与把戏一律拒绝（且不落地半成品）', () => {
  async function expectReject(buf: Buffer, re: RegExp, name = 'xray') {
    const out = dest();
    const err = await extractZipEntry(writeZip(buf), name, out).catch((e) => e);
    expect(err).toBeInstanceOf(ZipExtractError);
    expect((err as ZipExtractError).code).toBe('EXTRACT_FAILED');
    expect(String((err as Error).message)).toMatch(re);
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.existsSync(`${out}.part`)).toBe(false);
  }

  it('CRC 不符 → 拒绝', async () => {
    await expectReject(buildZip([{ name: 'xray', data: BIN, crc: 0xdeadbeef }]), /CRC/);
  });

  it('声明尺寸与实际解压尺寸不符 → 拒绝', async () => {
    await expectReject(
      buildZip([{ name: 'xray', data: BIN, size: BIN.length - 1 }]),
      /尺寸|解压数据失败/
    );
  });

  it('deflate 数据被截断（尺寸字段自洽）→ 拒绝', async () => {
    const full = zlib.deflateRawSync(BIN);
    await expectReject(
      buildZip([{ name: 'xray', data: BIN, compressed: full.subarray(0, full.length >> 1) }]),
      /解压数据失败|尺寸/
    );
  });

  it('文件被截断（缺 EOCD）→ 拒绝', async () => {
    const buf = buildZip([{ name: 'xray', data: BIN }]);
    await expectReject(buf.subarray(0, buf.length - 10), /结尾记录/);
  });

  it('文件被截断到只剩前半段 → 拒绝', async () => {
    const buf = buildZip([{ name: 'xray', data: BIN }]);
    await expectReject(buf.subarray(0, buf.length >> 1), /结尾记录/);
  });

  it('缺目标条目 → 拒绝', async () => {
    await expectReject(buildZip([{ name: 'geoip.dat', data: Buffer.from('g') }]), /没有 xray/);
  });

  it('只在两层以下 → 视为缺失（不深搜）', async () => {
    await expectReject(buildZip([{ name: 'a/b/xray', data: BIN }]), /没有 xray/);
  });

  it.each([
    ['../xray'],
    ['/xray'],
    ['a/../xray'],
    ['./xray'],
    ['C:/xray'],
    ['a\\xray'],
    ['a//xray'],
  ])('路径把戏条目 %s → 整包拒绝', async (evil) => {
    await expectReject(
      buildZip([
        { name: 'xray', data: BIN },
        { name: evil, data: Buffer.from('evil') },
      ]),
      /不安全/
    );
  });

  it('同名重复条目 → 拒绝', async () => {
    await expectReject(
      buildZip([
        { name: 'xray', data: BIN },
        { name: 'xray', data: Buffer.from('other') },
      ]),
      /重复/
    );
  });

  it('同层多个命中（两个子目录各有 xray）→ 歧义拒绝', async () => {
    await expectReject(
      buildZip([
        { name: 'a/xray', data: BIN },
        { name: 'b/xray', data: BIN },
      ]),
      /多个/
    );
  });

  it('zip64：条目尺寸为 0xFFFFFFFF 标记 → 拒绝', async () => {
    await expectReject(buildZip([{ name: 'xray', data: BIN, size: 0xffffffff }]), /zip64/);
  });

  it('zip64：条目 extra 含 0x0001 字段 → 拒绝', async () => {
    const extra = Buffer.alloc(4 + 8);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(8, 2);
    await expectReject(buildZip([{ name: 'xray', data: BIN, extra }]), /zip64/);
  });

  it('zip64：EOCD 条目数为 0xFFFF → 拒绝', async () => {
    await expectReject(buildZip([{ name: 'xray', data: BIN }], { totalOverride: 0xffff }), /zip64/);
  });

  it('zip64：存在 zip64 EOCD 定位器 → 拒绝', async () => {
    await expectReject(buildZip([{ name: 'xray', data: BIN }], { zip64Locator: true }), /zip64/);
  });

  it('加密条目 → 拒绝', async () => {
    await expectReject(buildZip([{ name: 'xray', data: BIN, flags: 0x0801 }]), /加密/);
  });

  it('不支持的压缩方式（bzip2=12）→ 拒绝', async () => {
    await expectReject(
      buildZip([{ name: 'xray', data: BIN, method: 12, compressed: BIN }]),
      /压缩方式/
    );
  });

  it('本地文件头文件名与中央目录不一致 → 拒绝', async () => {
    await expectReject(buildZip([{ name: 'xray', data: BIN, localName: 'xraz' }]), /不一致/);
  });

  it('entryName 本身含路径分隔符 → 拒绝（调用方误用）', async () => {
    await expectReject(buildZip([{ name: 'a/xray', data: BIN }]), /非法的条目名/, 'a/xray');
  });
});

describe('crc32', () => {
  it('纯 JS 兜底与 zlib 原生实现一致', () => {
    for (const b of [Buffer.alloc(0), Buffer.from('123456789'), BIN]) {
      expect(crc32Js(b)).toBe(crc32(b));
    }
    expect(crc32Js(Buffer.from('123456789'))).toBe(0xcbf43926); // CRC-32/IEEE 标准校验值
  });
});

/**
 * 真实 XTLS 资产（v26.10.10 Xray-linux-64.zip，22MB，**不入库**）：本地有则跑，否则 skip。
 * 钉住「真实官方包（deflate + UT/ux extra 字段 + 平铺结构）能被本实现正确解出」——合成用例覆盖不到真实编码器的细节。
 */
const FIXTURE =
  '/tmp/claude-0/-home-user-FlowZX/1650a525-3709-504c-acf4-71cbe9f2b7d9/scratchpad/xraydl/Xray-linux-64.zip';
const FIXTURE_ZIP_SHA = '72a5fde819713a103c6fc26a87aa025c1518c918a34eba4bc38d64dc0728e5d9';
const FIXTURE_BIN_SHA = '4cca4de3ab8c16b3803a70e9ebe0570d2a72480c716d89aa91603ec568bf0f44';
const fixtureOk = fs.existsSync(FIXTURE) && sha(fs.readFileSync(FIXTURE)) === FIXTURE_ZIP_SHA;
const itFixture = fixtureOk ? it : it.skip;

describe('extractZipEntry：真实 XTLS 资产', () => {
  itFixture('Xray-linux-64.zip（v26.10.10）→ 取出 xray，sha256 与官方包内文件一致', async () => {
    const out = dest();
    await extractZipEntry(FIXTURE, 'xray', out);
    expect(sha(fs.readFileSync(out))).toBe(FIXTURE_BIN_SHA);
    if (process.platform !== 'win32') expect(fs.statSync(out).mode & 0o777).toBe(0o755);
    // 只取 xray：geoip/geosite 等不落地
    expect(fs.readdirSync(path.dirname(out))).toEqual(['xray']);
  });
});
