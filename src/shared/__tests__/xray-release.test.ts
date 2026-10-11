import {
  XRAY_ASSET_BY_PLATFORM,
  listableXrayReleases,
  normalizeXrayRelease,
  parseXrayDgst,
  xrayAssetName,
  xrayBinaryName,
  xrayTagVersion,
} from '../xray-release';
import * as manifest from '../core-manifest.json';

const MIN = '26.1.23';

/** 真实 GitHub release JSON 的最小子集（字段名照 REST API）。 */
const rel = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  name: `Xray-core ${tag}`,
  prerelease: false,
  draft: false,
  published_at: '2026-10-10T00:00:00Z',
  html_url: `https://github.com/XTLS/Xray-core/releases/tag/${tag}`,
  assets: [
    { name: 'Xray-linux-64.zip' },
    { name: 'Xray-linux-64.zip.dgst' },
    { name: 'Xray-windows-64.zip' },
    { name: 'Xray-macos-arm64-v8a.zip' },
  ],
  ...extra,
});

describe('xrayAssetName / XRAY_ASSET_BY_PLATFORM', () => {
  it.each([
    ['win32', 'x64', 'Xray-windows-64.zip'],
    ['win32', 'arm64', 'Xray-windows-arm64-v8a.zip'],
    ['darwin', 'x64', 'Xray-macos-64.zip'],
    ['darwin', 'arm64', 'Xray-macos-arm64-v8a.zip'],
    ['linux', 'x64', 'Xray-linux-64.zip'],
    ['linux', 'arm64', 'Xray-linux-arm64-v8a.zip'],
  ])('%s-%s → %s', (platform, arch, asset) => {
    expect(xrayAssetName(platform, arch)).toBe(asset);
  });

  it('未打包的组合 → null', () => {
    expect(xrayAssetName('linux', 'ia32')).toBeNull();
    expect(xrayAssetName('freebsd', 'x64')).toBeNull();
  });

  it('与 scripts/fetch-core.mjs 的随包四平台资产名一致（两处各持一份，须同步）', () => {
    // fetch-core.mjs XRAY_TARGETS：linux / win / mac-x64 / mac-arm64
    expect(XRAY_ASSET_BY_PLATFORM['linux-x64']).toBe('Xray-linux-64.zip');
    expect(XRAY_ASSET_BY_PLATFORM['win32-x64']).toBe('Xray-windows-64.zip');
    expect(XRAY_ASSET_BY_PLATFORM['darwin-x64']).toBe('Xray-macos-64.zip');
    expect(XRAY_ASSET_BY_PLATFORM['darwin-arm64']).toBe('Xray-macos-arm64-v8a.zip');
  });

  it('xrayBinaryName：win32 → xray.exe，其余 → xray（killOrphan 按此进程名确认）', () => {
    expect(xrayBinaryName('win32')).toBe('xray.exe');
    expect(xrayBinaryName('linux')).toBe('xray');
    expect(xrayBinaryName('darwin')).toBe('xray');
  });
});

describe('xrayTagVersion', () => {
  it.each([
    ['v26.10.10', '26.10.10'],
    ['26.3.27', '26.3.27'],
    [' v26.1.23 ', '26.1.23'],
  ])('%s → %s', (tag, v) => {
    expect(xrayTagVersion(tag)).toBe(v);
  });

  it.each([['v26.10'], ['latest'], ['v26.10.10-rc1'], ['v26.10.10/../x'], [''], [null], [42]])(
    '非法 tag %p → null',
    (tag) => {
      expect(xrayTagVersion(tag)).toBeNull();
    }
  );
});

describe('parseXrayDgst', () => {
  const REAL = [
    'MD5= 1af0cedd0e4bcedfae87cd7ffe9235c0',
    'SHA1= ef77e7485ad4165478f65290cc02529716de0b68',
    'SHA2-256= 72a5fde819713a103c6fc26a87aa025c1518c918a34eba4bc38d64dc0728e5d9',
    'SHA2-512= a98587ebc4c7fa15630715fdaa3c93f12a66900937138694eeb3e94201141419b9aac0f5f5f4d275d449a1449b8561a9306743a77d6296d666b899225626b01d',
    '',
  ].join('\n');

  it('真实 .dgst（v26.10.10 Xray-linux-64.zip）→ SHA2-256 小写 hex', () => {
    expect(parseXrayDgst(REAL)).toBe(
      '72a5fde819713a103c6fc26a87aa025c1518c918a34eba4bc38d64dc0728e5d9'
    );
  });

  it('CRLF 与大写 hex 同样可解析，结果归一为小写', () => {
    expect(parseXrayDgst(`SHA2-256= ${'AB'.repeat(32)}\r\n`)).toBe('ab'.repeat(32));
  });

  it('不把 SHA2-512 的前 64 位误当 SHA2-256', () => {
    expect(parseXrayDgst(`SHA2-512= ${'c'.repeat(128)}\n`)).toBeNull();
  });

  it.each([
    ['缺 SHA2-256 行', 'MD5= 00\nSHA1= 11\n'],
    ['长度不足 64', `SHA2-256= ${'a'.repeat(63)}`],
    ['长度超过 64', `SHA2-256= ${'a'.repeat(65)}`],
    ['非 hex', `SHA2-256= ${'g'.repeat(64)}`],
    ['空串', ''],
  ])('%s → null（调用方据此 fail-closed）', (_label, text) => {
    expect(parseXrayDgst(text)).toBeNull();
  });

  it('非字符串 → null', () => {
    expect(parseXrayDgst(undefined)).toBeNull();
    expect(parseXrayDgst(Buffer.from('x'))).toBeNull();
  });
});

describe('normalizeXrayRelease', () => {
  it('稳定版 → 字段齐全，hasAsset 按平台判定', () => {
    const r = normalizeXrayRelease(rel('v26.3.27'), 'linux', 'x64', MIN);
    expect(r).toEqual({
      tag: 'v26.3.27',
      version: '26.3.27',
      name: 'Xray-core v26.3.27',
      prerelease: false,
      draft: false,
      publishedAt: '2026-10-10T00:00:00Z',
      htmlUrl: 'https://github.com/XTLS/Xray-core/releases/tag/v26.3.27',
      assetName: 'Xray-linux-64.zip',
      hasAsset: true,
      belowMinimum: false,
    });
  });

  it('预发布标志只看 API 的 prerelease（tag 是纯数字）', () => {
    expect(
      normalizeXrayRelease(rel('v26.10.10', { prerelease: true }), 'linux', 'x64', MIN)?.prerelease
    ).toBe(true);
  });

  it('本平台无资产 → hasAsset=false（仍列出，UI 禁用安装）', () => {
    const r = normalizeXrayRelease(rel('v26.3.27'), 'darwin', 'x64', MIN);
    expect(r?.assetName).toBe('Xray-macos-64.zip');
    expect(r?.hasAsset).toBe(false);
  });

  it('未打包平台 → assetName=null、hasAsset=false', () => {
    const r = normalizeXrayRelease(rel('v26.3.27'), 'linux', 'ia32', MIN);
    expect(r?.assetName).toBeNull();
    expect(r?.hasAsset).toBe(false);
  });

  it('低于最低版本 → belowMinimum；等于最低版本不算低于', () => {
    expect(normalizeXrayRelease(rel('v25.12.8'), 'linux', 'x64', MIN)?.belowMinimum).toBe(true);
    expect(normalizeXrayRelease(rel('v26.1.23'), 'linux', 'x64', MIN)?.belowMinimum).toBe(false);
  });

  it('html_url 不是 XTLS/Xray-core 的 github 页面 → 按 tag 重建（渲染端会 openExternal）', () => {
    const r = normalizeXrayRelease(
      rel('v26.3.27', { html_url: 'https://evil.example/phish' }),
      'linux',
      'x64',
      MIN
    );
    expect(r?.htmlUrl).toBe('https://github.com/XTLS/Xray-core/releases/tag/v26.3.27');
  });

  it('name 缺失 → 回落 tag；published_at 缺失 → null', () => {
    const r = normalizeXrayRelease(
      rel('v26.3.27', { name: '', published_at: null }),
      'linux',
      'x64',
      MIN
    );
    expect(r?.name).toBe('v26.3.27');
    expect(r?.publishedAt).toBeNull();
  });

  it('非法 tag / 非对象 → null', () => {
    expect(normalizeXrayRelease(rel('nightly'), 'linux', 'x64', MIN)).toBeNull();
    expect(normalizeXrayRelease(null, 'linux', 'x64', MIN)).toBeNull();
    expect(normalizeXrayRelease('v26.3.27', 'linux', 'x64', MIN)).toBeNull();
  });

  it('assets 非数组 → hasAsset=false（不抛）', () => {
    expect(
      normalizeXrayRelease(rel('v26.3.27', { assets: 'x' }), 'linux', 'x64', MIN)?.hasAsset
    ).toBe(false);
  });
});

describe('listableXrayReleases', () => {
  it('剔除草稿 / 低于最低版本 / 非法 tag，按版本号新→旧（26.10.10 > 26.9.30 > 26.3.27）', () => {
    const out = listableXrayReleases(
      [
        rel('v26.3.27'),
        rel('v26.10.10', { prerelease: true }),
        rel('v26.11.1', { draft: true }),
        rel('v25.12.8'),
        rel('v26.9.30', { prerelease: true }),
        { tag_name: 'weird' },
        null,
      ],
      'linux',
      'x64',
      MIN
    );
    expect(out.map((r) => r.tag)).toEqual(['v26.10.10', 'v26.9.30', 'v26.3.27']);
  });

  it('同版本重复（v 前缀有无）只保留首个', () => {
    const out = listableXrayReleases([rel('v26.3.27'), rel('26.3.27')], 'linux', 'x64', MIN);
    expect(out).toHaveLength(1);
    expect(out[0].tag).toBe('v26.3.27');
  });

  it('非数组 → []', () => {
    expect(listableXrayReleases({ message: 'rate limited' }, 'linux', 'x64', MIN)).toEqual([]);
  });

  it('随包版本恒可列出（不低于 manifest.minXrayVersion）', () => {
    const m = manifest as { bundledXrayVersion: string; minXrayVersion: string };
    const out = listableXrayReleases(
      [rel(`v${m.bundledXrayVersion}`)],
      'linux',
      'x64',
      m.minXrayVersion
    );
    expect(out.map((r) => r.version)).toEqual([m.bundledXrayVersion]);
  });
});
