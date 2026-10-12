import * as fs from 'fs';
import * as path from 'path';

import {
  SINGBOX_ASSET_SUFFIX_BY_PLATFORM,
  SINGBOX_TAG_RE,
  listableSingboxReleases,
  normalizeSingboxRelease,
  parseSingboxBuildTags,
  singboxAssetName,
  singboxChannel,
  singboxChannelLabels,
  singboxTagVersion,
} from '../singbox-release';

const BUNDLED = '1.14.0-rc.1';

/** 一个 release 的全部真实变体资产名（HEAD 探测核实：1.14.3 / 1.15.0-alpha.12 均有这一组）。 */
const allAssets = (v: string) =>
  [
    `sing-box-${v}-linux-amd64.tar.gz`,
    `sing-box-${v}-linux-amd64-glibc.tar.gz`,
    `sing-box-${v}-linux-amd64-musl.tar.gz`,
    `sing-box-${v}-linux-arm64.tar.gz`,
    `sing-box-${v}-darwin-amd64.tar.gz`,
    `sing-box-${v}-darwin-amd64-legacy-macos-10.13.tar.gz`,
    `sing-box-${v}-darwin-arm64.tar.gz`,
    `sing-box-${v}-windows-amd64.zip`,
    `sing-box-${v}-windows-amd64-legacy-windows-7.zip`,
    `sing-box-${v}-windows-arm64.zip`,
    `sing-box_${v}_linux_amd64.deb`,
  ].map((name) => ({ name }));

/** 真实 GitHub release JSON 的最小子集（字段名照 REST API）。 */
const rel = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  name: tag.replace(/^v/, ''),
  prerelease: false,
  draft: false,
  published_at: '2026-10-09T00:00:00Z',
  html_url: `https://github.com/SagerNet/sing-box/releases/tag/${tag}`,
  assets: allAssets(tag.replace(/^v/, '')),
  ...extra,
});

describe('singboxTagVersion / SINGBOX_TAG_RE', () => {
  it.each([
    ['v1.14.3', '1.14.3'],
    ['1.14.3', '1.14.3'],
    ['v1.15.0-alpha.12', '1.15.0-alpha.12'],
    ['v1.14.0-beta.17', '1.14.0-beta.17'],
    ['v1.14.0-rc.1', '1.14.0-rc.1'],
    [' v1.14.0-rc.5 ', '1.14.0-rc.5'],
  ])('%p → %p', (tag, v) => {
    expect(singboxTagVersion(tag)).toBe(v);
  });

  it.each([
    ['latest'],
    ['v1.14'],
    ['v1.14.3-glibc'],
    ['v1.14.3-rc1'],
    ['v1.14.0-alpha.31-abcdef1'], // dev 构建不是 release tag
    ['v1.14.3/../../evil'],
    ['../v1.14.3'],
    ['v1.14.3?x=1'],
    ['v1.14.3#frag'],
    ['v1.14.3 extra'],
    ['v1.14.3%2F..'],
    ['V1.14.3'],
    [''],
    [null],
    [undefined],
    [42],
    [{ toString: () => 'v1.14.3' }],
  ])('非法 / 注入 tag %p → null', (tag) => {
    expect(singboxTagVersion(tag)).toBeNull();
  });

  it('正则锚定整串（拼 URL 前的唯一闸）', () => {
    expect(SINGBOX_TAG_RE.test('xv1.14.3')).toBe(false);
    expect(SINGBOX_TAG_RE.test('v1.14.3x')).toBe(false);
    expect(SINGBOX_TAG_RE.test('v1.14.3\nv1.14.4')).toBe(false);
  });
});

describe('singboxAssetName', () => {
  it.each([
    ['linux', 'x64', 'sing-box-1.14.3-linux-amd64.tar.gz'],
    ['win32', 'x64', 'sing-box-1.14.3-windows-amd64.zip'],
    ['darwin', 'x64', 'sing-box-1.14.3-darwin-amd64.tar.gz'],
    ['darwin', 'arm64', 'sing-box-1.14.3-darwin-arm64.tar.gz'],
  ])('%s-%s → %s（精确名，绝不是 -glibc / -musl / -legacy 变体）', (platform, arch, name) => {
    expect(singboxAssetName('1.14.3', platform, arch)).toBe(name);
  });

  it('预发布版本号原样进名字；带 v 前缀也认', () => {
    expect(singboxAssetName('1.15.0-alpha.12', 'linux', 'x64')).toBe(
      'sing-box-1.15.0-alpha.12-linux-amd64.tar.gz'
    );
    expect(singboxAssetName('v1.14.3', 'win32', 'x64')).toBe('sing-box-1.14.3-windows-amd64.zip');
  });

  it('未打包的平台/架构 → null（NO_ASSET）', () => {
    expect(singboxAssetName('1.14.3', 'linux', 'arm64')).toBeNull();
    expect(singboxAssetName('1.14.3', 'win32', 'arm64')).toBeNull();
    expect(singboxAssetName('1.14.3', 'linux', 'ia32')).toBeNull();
    expect(singboxAssetName('1.14.3', 'freebsd', 'x64')).toBeNull();
  });

  it('版本号形状不符 → null（不拼出任意文件名）', () => {
    expect(singboxAssetName('1.14.3/../../x', 'linux', 'x64')).toBeNull();
    expect(singboxAssetName('', 'linux', 'x64')).toBeNull();
  });

  it('与 scripts/fetch-core.mjs 的随包四平台资产名一致（两处各持一份，须同步）', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../scripts/fetch-core.mjs'), 'utf8');
    for (const suffix of Object.values(SINGBOX_ASSET_SUFFIX_BY_PLATFORM)) {
      expect(src).toContain(`asset: \`sing-box-\${VERSION}-${suffix}\``);
    }
    expect(Object.keys(SINGBOX_ASSET_SUFFIX_BY_PLATFORM).sort()).toEqual(
      ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'].sort()
    );
  });
});

describe('parseSingboxBuildTags', () => {
  // 实测输出（官方 linux-amd64 构建，`sing-box version`）
  const out1143 = [
    'sing-box version 1.14.3',
    '',
    'Environment: go1.26.8 linux/amd64',
    'Tags: with_gvisor,with_quic,with_dhcp,with_wireguard,with_utls,with_acme,with_clash_api,with_tailscale,with_ccm,with_ocm,with_cloudflared,with_naive_outbound,with_usbip,with_openvpn,with_openconnect,badlinkname,tfogo_checklinkname0,with_purego',
    'Revision: 7054cac5124465ffdb145870d7c01885566711b1',
    'CGO: disabled',
    '',
  ].join('\n');
  const outAlpha12 = out1143
    .replace('1.14.3', '1.15.0-alpha.12')
    .replace('Tags: with_gvisor,', 'Tags: ');

  it('1.14.3 含 with_gvisor；1.15.0-alpha.12 不含', () => {
    const t1 = parseSingboxBuildTags(out1143);
    expect(t1).toContain('with_gvisor');
    expect(t1).toContain('with_purego');
    expect(t1).toHaveLength(18);
    const t2 = parseSingboxBuildTags(outAlpha12);
    expect(t2).not.toContain('with_gvisor');
    expect(t2).toContain('with_naive_outbound');
  });

  it('Windows CRLF 输出同样解析（不把 \\r 粘在最后一个 tag 上）', () => {
    const tags = parseSingboxBuildTags(out1143.replace(/\n/g, '\r\n'));
    expect(tags?.[tags.length - 1]).toBe('with_purego');
  });

  it('无 Tags 行 / 非字符串 → null（无从判断）；空 Tags 行 → []', () => {
    expect(parseSingboxBuildTags('sing-box version 1.14.3\n')).toBeNull();
    expect(parseSingboxBuildTags(undefined)).toBeNull();
    expect(parseSingboxBuildTags('sing-box version 1.14.3\nTags: \n')).toEqual([]);
  });
});

describe('singboxChannel', () => {
  it.each([
    ['1.14.3', 'stable'],
    ['1.14.0-rc.5', 'rc'],
    ['1.14.0-beta.17', 'beta'],
    ['1.15.0-alpha.12', 'alpha'],
  ])('%s → %s', (v, ch) => {
    expect(singboxChannel(v)).toBe(ch);
  });
});

describe('singboxChannelLabels（报告问题 / 诊断报告的简短标注）', () => {
  it('随包版本标「随包」（即使它本身是 rc），用户装的预发布标「预发布」，正式版不标', () => {
    expect(singboxChannelLabels('1.14.0-rc.1', { bundledVersion: BUNDLED })).toEqual(['随包']);
    expect(singboxChannelLabels('1.15.0-alpha.12', { bundledVersion: BUNDLED })).toEqual([
      '预发布',
    ]);
    expect(singboxChannelLabels('1.14.0-rc.5', { bundledVersion: BUNDLED })).toEqual(['预发布']);
    expect(singboxChannelLabels('1.14.3', { bundledVersion: BUNDLED })).toEqual([]);
  });

  it('固定的正是现役版本时加「已固定」（顺序：通道在前）', () => {
    expect(
      singboxChannelLabels('1.15.0-alpha.12', {
        bundledVersion: BUNDLED,
        pinnedVersion: '1.15.0-alpha.12',
      })
    ).toEqual(['预发布', '已固定']);
    expect(
      singboxChannelLabels('v1.14.1', { bundledVersion: BUNDLED, pinnedVersion: 'v1.14.1' })
    ).toEqual(['已固定']);
    // 固定位陈旧（现役已被其它途径换掉）→ 不标
    expect(
      singboxChannelLabels('1.14.3', { bundledVersion: BUNDLED, pinnedVersion: '1.14.1' })
    ).toEqual([]);
  });

  it('第三方构建只标「第三方」：截断后的版本号与随包 / 预发布比较无意义', () => {
    expect(
      singboxChannelLabels('1.14.0-rc.1', {
        build: 'fork',
        bundledVersion: BUNDLED,
        pinnedVersion: '1.14.0-rc.1',
      })
    ).toEqual(['第三方']);
    // unknown 构建按官方处理
    expect(
      singboxChannelLabels('1.14.0-rc.1', { build: 'unknown', bundledVersion: BUNDLED })
    ).toEqual(['随包']);
  });

  it('dev 构建的 commit 尾段不参与比较', () => {
    expect(singboxChannelLabels('1.14.0-rc.1-abcdef1', { bundledVersion: BUNDLED })).toEqual([
      '随包',
    ]);
    expect(singboxChannelLabels('1.15.0-alpha.12-abcdef1', { bundledVersion: BUNDLED })).toEqual([
      '预发布',
    ]);
  });

  it('版本未知 / 非版本串 / 参照缺失：不标、不误配', () => {
    for (const v of ['', '未知', 'unknown', null, undefined, '<1.14.0>'])
      expect(singboxChannelLabels(v, { bundledVersion: BUNDLED, pinnedVersion: '1.14.3' })).toEqual(
        []
      );
    expect(singboxChannelLabels('1.14.0-rc.1')).toEqual(['预发布']);
    expect(singboxChannelLabels('0.0.0', { bundledVersion: 'garbage', pinnedVersion: '' })).toEqual(
      []
    );
  });
});

describe('normalizeSingboxRelease', () => {
  it('正式版：字段齐全；本平台精确资产 → hasAsset', () => {
    expect(normalizeSingboxRelease(rel('v1.14.3'), 'linux', 'x64', BUNDLED)).toEqual({
      tag: 'v1.14.3',
      version: '1.14.3',
      name: '1.14.3',
      prerelease: false,
      channel: 'stable',
      draft: false,
      publishedAt: '2026-10-09T00:00:00Z',
      htmlUrl: 'https://github.com/SagerNet/sing-box/releases/tag/v1.14.3',
      assetName: 'sing-box-1.14.3-linux-amd64.tar.gz',
      hasAsset: true,
      belowMinimum: false,
    });
  });

  it('预发布：tag 后缀即算（API 标志漏标也不放过）；API 标志单独为 true 也算', () => {
    const rc = normalizeSingboxRelease(rel('v1.14.0-rc.5'), 'linux', 'x64', BUNDLED);
    expect(rc).toMatchObject({ prerelease: true, channel: 'rc' });
    const alpha = normalizeSingboxRelease(rel('v1.15.0-alpha.12'), 'win32', 'x64', BUNDLED);
    expect(alpha).toMatchObject({
      prerelease: true,
      channel: 'alpha',
      assetName: 'sing-box-1.15.0-alpha.12-windows-amd64.zip',
      hasAsset: true,
    });
    const flagged = normalizeSingboxRelease(
      rel('v1.16.0', { prerelease: true }),
      'linux',
      'x64',
      BUNDLED
    );
    expect(flagged).toMatchObject({ prerelease: true, channel: 'stable' });
  });

  it('只有 -glibc / -musl 变体（缺精确名）→ hasAsset=false', () => {
    const r = rel('v1.14.3', {
      assets: [
        { name: 'sing-box-1.14.3-linux-amd64-glibc.tar.gz' },
        { name: 'sing-box-1.14.3-linux-amd64-musl.tar.gz' },
      ],
    });
    expect(normalizeSingboxRelease(r, 'linux', 'x64', BUNDLED)?.hasAsset).toBe(false);
  });

  it('未打包平台 → assetName null、hasAsset false', () => {
    expect(normalizeSingboxRelease(rel('v1.14.3'), 'linux', 'arm64', BUNDLED)).toMatchObject({
      assetName: null,
      hasAsset: false,
    });
  });

  it('低于随包版本 → belowMinimum；等于随包版本不算', () => {
    expect(normalizeSingboxRelease(rel('v1.13.21'), 'linux', 'x64', BUNDLED)?.belowMinimum).toBe(
      true
    );
    expect(
      normalizeSingboxRelease(rel('v1.14.0-beta.17'), 'linux', 'x64', BUNDLED)?.belowMinimum
    ).toBe(true);
    expect(
      normalizeSingboxRelease(rel('v1.14.0-rc.1'), 'linux', 'x64', BUNDLED)?.belowMinimum
    ).toBe(false);
  });

  it('htmlUrl 只认 SagerNet/sing-box 的 github.com 页面，否则按 tag 重建（渲染端 openExternal）', () => {
    for (const bad of [
      'https://evil.example/releases/tag/v1.14.3',
      'https://github.com/SagerNet/sing-box-fork/releases/tag/v1.14.3',
      'javascript:alert(1)',
      42,
    ]) {
      expect(
        normalizeSingboxRelease(rel('v1.14.3', { html_url: bad }), 'linux', 'x64', BUNDLED)?.htmlUrl
      ).toBe('https://github.com/SagerNet/sing-box/releases/tag/v1.14.3');
    }
  });

  it('name 空 → 回落 tag；published_at 缺 → null', () => {
    const r = normalizeSingboxRelease(
      rel('v1.14.3', { name: '  ', published_at: null }),
      'linux',
      'x64',
      BUNDLED
    );
    expect(r).toMatchObject({ name: 'v1.14.3', publishedAt: null });
  });

  it.each([[null], ['x'], [{}], [{ tag_name: 'latest' }], [{ tag_name: 'v1.14.3-glibc' }]])(
    '畸形输入 %p → null',
    (raw) => {
      expect(normalizeSingboxRelease(raw, 'linux', 'x64', BUNDLED)).toBeNull();
    }
  );
});

describe('listableSingboxReleases', () => {
  // API 按发布时间排：分支交错（1.13.21 补丁夹在 1.14 预发布之间），与版本序不同。
  const apiOrder = [
    rel('v1.15.0-alpha.12', { prerelease: true }),
    rel('v1.15.0-alpha.11', { prerelease: true }),
    rel('v1.14.3'),
    rel('v1.15.0-alpha.10', { prerelease: true }),
    rel('v1.14.2'),
    rel('v1.14.0'),
    rel('v1.14.0-rc.5', { prerelease: true }),
    rel('v1.13.21'),
    rel('v1.14.0-rc.4', { prerelease: true }),
    rel('v1.14.0-rc.3', { prerelease: true, assets: [] }), // 上游无资产
    rel('v1.14.0-rc.2', { prerelease: true }),
    rel('v1.14.0-rc.1', { prerelease: true }),
    rel('v1.14.0-beta.17', { prerelease: true }),
    rel('v1.16.0-alpha.1', { prerelease: true, draft: true }),
    { tag_name: 'nightly' },
    null,
    rel('v1.14.3'), // 重复
  ];

  it('剔除草稿 / 畸形 / 低于随包 / 无本平台资产 / 重复；按 semver 新→旧', () => {
    const list = listableSingboxReleases(apiOrder, 'linux', 'x64', BUNDLED);
    expect(list.map((r) => r.tag)).toEqual([
      'v1.15.0-alpha.12',
      'v1.15.0-alpha.11',
      'v1.15.0-alpha.10',
      'v1.14.3',
      'v1.14.2',
      'v1.14.0',
      'v1.14.0-rc.5',
      'v1.14.0-rc.4',
      'v1.14.0-rc.2',
      'v1.14.0-rc.1',
    ]);
    expect(list.every((r) => r.hasAsset && !r.draft && !r.belowMinimum)).toBe(true);
  });

  it('最低版本 = 传入的随包版本（随 manifest 动态，不硬编码）', () => {
    const list = listableSingboxReleases(apiOrder, 'linux', 'x64', '1.14.2');
    expect(list.map((r) => r.version).pop()).toBe('1.14.2');
  });

  it('未打包平台 → 空列表；非数组 → 空列表', () => {
    expect(listableSingboxReleases(apiOrder, 'linux', 'arm64', BUNDLED)).toEqual([]);
    expect(listableSingboxReleases({ message: 'Not Found' }, 'linux', 'x64', BUNDLED)).toEqual([]);
  });
});
