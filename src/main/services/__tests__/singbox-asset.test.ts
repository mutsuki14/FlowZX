import { findSuitableSingboxAsset, normalizeAssetDigest } from '../singbox-asset';
import { singboxAssetName } from '../../../shared/singbox-release';

const asset = (name: string) => ({ name, browser_download_url: `https://x/${name}` });

describe('findSuitableSingboxAsset', () => {
  it('linux x64 → 匹配 linux+amd64+.tar.gz', () => {
    const a = findSuitableSingboxAsset(
      [
        asset('sing-box-1.13.0-darwin-arm64.tar.gz'),
        asset('sing-box-1.13.0-linux-amd64.tar.gz'),
        asset('sing-box-1.13.0-windows-amd64.zip'),
      ],
      'linux',
      'x64'
    );
    expect(a.name).toBe('sing-box-1.13.0-linux-amd64.tar.gz');
  });

  it('darwin arm64 → 匹配 darwin+arm64', () => {
    const a = findSuitableSingboxAsset(
      [asset('sing-box-1.13.0-darwin-amd64.tar.gz'), asset('sing-box-1.13.0-darwin-arm64.tar.gz')],
      'darwin',
      'arm64'
    );
    expect(a.name).toBe('sing-box-1.13.0-darwin-arm64.tar.gz');
  });

  it('规范资产在场 → 取规范资产（与随包同款），不再让旧时代的 with-naive 变体抢先', () => {
    const a = findSuitableSingboxAsset(
      [
        asset('sing-box-1.13.0-windows-amd64.zip'),
        asset('sing-box-1.13.0-windows-amd64-with-naive.zip'),
      ],
      'win32',
      'x64'
    );
    expect(a.name).toBe('sing-box-1.13.0-windows-amd64.zip');
  });

  it('无规范资产时仍优先含 with-naive / full 的构建（旧发布兼容）', () => {
    const a = findSuitableSingboxAsset(
      [
        asset('sing-box-1.11.0-windows-amd64-legacy-windows-7.zip'),
        asset('sing-box-1.11.0-windows-amd64-with-naive.zip'),
      ],
      'win32',
      'x64'
    );
    expect(a.name).toBe('sing-box-1.11.0-windows-amd64-with-naive.zip');
  });

  it('with-naive 缺失时排除 legacy 取非 legacy', () => {
    const a = findSuitableSingboxAsset(
      [
        asset('sing-box-1.13.0-linux-amd64-legacy.tar.gz'),
        asset('sing-box-1.13.0-linux-amd64.tar.gz'),
      ],
      'linux',
      'x64'
    );
    expect(a.name).toBe('sing-box-1.13.0-linux-amd64.tar.gz');
  });

  it('全为 legacy 时回落首个匹配', () => {
    const a = findSuitableSingboxAsset(
      [asset('sing-box-1.13.0-linux-amd64-legacy.tar.gz')],
      'linux',
      'x64'
    );
    expect(a.name).toBe('sing-box-1.13.0-linux-amd64-legacy.tar.gz');
  });

  it('Windows 接受 .zip 后缀', () => {
    const a = findSuitableSingboxAsset(
      [asset('sing-box-1.13.0-windows-amd64.zip')],
      'win32',
      'x64'
    );
    expect(a.name).toBe('sing-box-1.13.0-windows-amd64.zip');
  });

  it('无平台/架构匹配 → undefined', () => {
    const a = findSuitableSingboxAsset(
      [asset('sing-box-1.13.0-linux-amd64.tar.gz')],
      'darwin',
      'arm64'
    );
    expect(a).toBeUndefined();
  });

  it('空 assets → undefined', () => {
    expect(findSuitableSingboxAsset([], 'linux', 'x64')).toBeUndefined();
  });
});

/**
 * 真实 release 的资产全集（1.14.3 / 1.15.0-alpha.12 经 HEAD 探测核实）。GitHub API 按名字排序列资产，`-glibc` / `-musl`
 * 排在规范名之前（'-' < '.'）——旧逻辑「首个非 legacy」在 Linux 上因此装的是 CGO 的 glibc 构建（不带 libcronet，与随包
 * 的 purego 构建不同）。挑选必须与资产顺序无关地落在规范资产上。
 */
describe('findSuitableSingboxAsset：规范资产优先（与随包同款，绝不挑 -glibc / -musl / -legacy）', () => {
  const realAssets = (v: string) =>
    [
      `SFM-${v}-Universal.pkg`,
      `sing-box-${v}-android-arm64.tar.gz`,
      `sing-box-${v}-darwin-amd64-legacy-macos-10.13.tar.gz`,
      `sing-box-${v}-darwin-amd64.tar.gz`,
      `sing-box-${v}-darwin-arm64.tar.gz`,
      `sing-box-${v}-linux-amd64-glibc.tar.gz`,
      `sing-box-${v}-linux-amd64-musl.tar.gz`,
      `sing-box-${v}-linux-amd64.tar.gz`,
      `sing-box-${v}-linux-arm64-glibc.tar.gz`,
      `sing-box-${v}-linux-arm64-musl.tar.gz`,
      `sing-box-${v}-linux-arm64.tar.gz`,
      `sing-box-${v}-windows-386-legacy-windows-7.zip`,
      `sing-box-${v}-windows-386.zip`,
      `sing-box-${v}-windows-amd64-legacy-windows-7.zip`,
      `sing-box-${v}-windows-amd64.zip`,
      `sing-box-${v}-windows-arm64.zip`,
      `sing-box_${v}_linux_amd64.deb`,
    ]
      .sort()
      .map(asset);

  const cases: Array<[NodeJS.Platform, string, string]> = [
    ['linux', 'x64', 'linux-amd64.tar.gz'],
    ['win32', 'x64', 'windows-amd64.zip'],
    ['darwin', 'x64', 'darwin-amd64.tar.gz'],
    ['darwin', 'arm64', 'darwin-arm64.tar.gz'],
    // 未打包平台：同一命名规则推出规范名
    ['linux', 'arm64', 'linux-arm64.tar.gz'],
    ['win32', 'arm64', 'windows-arm64.zip'],
  ];

  for (const v of ['1.14.3', '1.15.0-alpha.12']) {
    for (const [platform, arch, suffix] of cases) {
      it(`${v} ${platform}-${arch}：名字序 / 逆序都取 sing-box-${v}-${suffix}`, () => {
        const assets = realAssets(v);
        const want = `sing-box-${v}-${suffix}`;
        expect(findSuitableSingboxAsset(assets, platform, arch).name).toBe(want);
        expect(findSuitableSingboxAsset([...assets].reverse(), platform, arch).name).toBe(want);
      });
    }
  }

  it('打包平台的规范名与版本选择（shared/singbox-release 的 singboxAssetName）同一真值', () => {
    for (const [platform, arch] of [
      ['linux', 'x64'],
      ['win32', 'x64'],
      ['darwin', 'x64'],
      ['darwin', 'arm64'],
    ] as Array<[NodeJS.Platform, string]>) {
      const picked = findSuitableSingboxAsset(realAssets('1.14.3'), platform, arch);
      expect(picked.name).toBe(singboxAssetName('1.14.3', platform, arch));
    }
  });

  it('规范资产缺席：先取非变体（非 -glibc / -musl / -legacy），全是变体才回落', () => {
    const v = '1.14.3';
    expect(
      findSuitableSingboxAsset(
        [
          asset(`sing-box-${v}-linux-amd64-glibc.tar.gz`),
          asset(`sing-box-${v}-linux-amd64-musl.tar.gz`),
          asset(`sing-box-${v}-linux-amd64v3.tar.gz`),
        ],
        'linux',
        'x64'
      ).name
    ).toBe(`sing-box-${v}-linux-amd64v3.tar.gz`);
    // 只有变体：仍回落到非 legacy 的首个（保持「有总比没有好」的旧语义）
    expect(
      findSuitableSingboxAsset(
        [
          asset(`sing-box-${v}-linux-amd64-glibc.tar.gz`),
          asset(`sing-box-${v}-linux-amd64-musl.tar.gz`),
        ],
        'linux',
        'x64'
      ).name
    ).toBe(`sing-box-${v}-linux-amd64-glibc.tar.gz`);
  });

  it('形似规范名的冒名资产（版本段后夹带其它词）不算规范资产：与真规范资产同列时恒取后者', () => {
    const lookalike = asset('sing-box-1.14.3-evil-linux-amd64.tar.gz');
    const real = asset('sing-box-1.14.3-linux-amd64.tar.gz');
    expect(findSuitableSingboxAsset([lookalike, real], 'linux', 'x64').name).toBe(real.name);
    expect(findSuitableSingboxAsset([real, lookalike], 'linux', 'x64').name).toBe(real.name);
  });
});

describe('normalizeAssetDigest — 运行期换核的完整性锚', () => {
  const HEX = 'a'.repeat(64);

  it('sha256:<64hex> → 小写裸 hex', () => {
    expect(normalizeAssetDigest({ digest: `sha256:${HEX}` })).toBe(HEX);
    expect(normalizeAssetDigest({ digest: `sha256:${'A'.repeat(64)}` })).toBe(HEX);
    expect(normalizeAssetDigest({ digest: `  sha256:${HEX}  ` })).toBe(HEX);
  });

  /**
   * 形状不符一律 null、**绝不兜底放行**：调用方据 null 拒装。若在此放宽（比如「没有前缀就当 hex 用」），
   * 「拿不到摘要」会静默退化成「不校验」，而运行期换核会回落 gh-proxy 第三方镜像——那正是要防的场景。
   */
  it('缺失 / 非 sha256 / 长度或字符不对 / 非字符串 → null', () => {
    const bad: unknown[] = [
      undefined,
      null,
      {},
      { digest: null },
      { digest: 123 },
      { digest: HEX }, // 裸 hex 无算法前缀：不认
      { digest: `md5:${'a'.repeat(32)}` },
      { digest: `sha256:${'a'.repeat(63)}` },
      { digest: `sha256:${'g'.repeat(64)}` },
      { digest: `sha512:${'a'.repeat(128)}` },
    ];
    for (const a of bad) expect(normalizeAssetDigest(a)).toBeNull();
  });
});
