/**
 * sing-box 内核管理卡「选择版本」纯决策逻辑单测（singbox-version-logic.ts）：现役 / 随包判定 / 跨带 / 列表过滤 /
 * 选项文案 / 动作按钮 / 最新正式版 / 自动更新覆盖 / 确认理由与顺序 / 通道徽章 / 进度与错误码映射 / 失败 detail。
 * 夹具 = 实测上游 tag（≥ 随包 1.14.0-rc.1；rc.3 从未打 tag）。
 */
import {
  autoUpdateSupersedes,
  channelPill,
  clipDetail,
  composeOptionLabel,
  confirmAnyway,
  confirmReasonKey,
  crossBand,
  errorMessageKey,
  errorShowsDetail,
  failureDetail,
  filterSingboxReleases,
  installOptions,
  isActiveSingboxRelease,
  isBundledSingboxRelease,
  isolateLtr,
  latestStable,
  listErrorCode,
  optionParts,
  phaseKey,
  pickSelection,
  progressBarPercent,
  releaseDate,
  SINGBOX_INSTALL_ERROR_CODES,
  SINGBOX_INSTALL_PHASES,
  singboxConfirms,
  singboxReleaseAction,
  type SingboxConfirmReason,
  type SingboxStatusLike,
} from '../singbox-version-logic';
import {
  listableSingboxReleases,
  type SingboxInstallErrorCode,
  type SingboxInstallPhase,
  type SingboxRelease,
} from '../../../../shared/singbox-release';

const BUNDLED = '1.14.0-rc.1';

const rel = (version: string, over: Partial<SingboxRelease> = {}): SingboxRelease => {
  const pre = /-(alpha|beta|rc)\.\d+$/.exec(version);
  return {
    tag: `v${version}`,
    version,
    name: `v${version}`,
    prerelease: !!pre,
    channel: pre ? (pre[1] as SingboxRelease['channel']) : 'stable',
    draft: false,
    publishedAt: null,
    htmlUrl: `https://github.com/SagerNet/sing-box/releases/tag/v${version}`,
    assetName: `sing-box-${version}-linux-amd64.tar.gz`,
    hasAsset: true,
    belowMinimum: false,
    knownBad: false,
    ...over,
  };
};

const status = (over: Partial<SingboxStatusLike> = {}): SingboxStatusLike => ({
  currentVersion: BUNDLED,
  build: 'official',
  bundledVersion: BUNDLED,
  stagedVersion: null,
  autoUpdateEnabled: false,
  ...over,
});

// 主进程 listReleases 的形状：版本号新→旧；1.15 alpha 12 个 + 1.14 正式 4 个 + 1.14 rc 4 个。
const ALPHAS = Array.from({ length: 12 }, (_, i) => `1.15.0-alpha.${12 - i}`);
const VERSIONS = [
  ...ALPHAS,
  '1.14.3',
  '1.14.2',
  '1.14.1',
  '1.14.0',
  '1.14.0-rc.5',
  '1.14.0-rc.4',
  '1.14.0-rc.2',
  BUNDLED,
];
const DATES: Record<string, string> = {
  '1.15.0-alpha.12': '2026-10-11T09:12:40Z',
  '1.14.3': '2026-10-09T04:36:50Z',
  [BUNDLED]: '2026-08-24T10:00:00Z',
};
const list = VERSIONS.map((v) => rel(v, { publishedAt: DATES[v] ?? null }));
const R = (version: string): SingboxRelease => {
  const r = list.find((x) => x.version === version);
  if (!r) throw new Error(`no fixture ${version}`);
  return r;
};
const versionsOf = (rs: readonly SingboxRelease[]) => rs.map((r) => r.version);
const STABLES = ['1.14.3', '1.14.2', '1.14.1', '1.14.0'];

describe('singbox-version-logic', () => {
  describe('isActiveSingboxRelease / isBundledSingboxRelease', () => {
    it('matches the running official (or unknown-build) core by version', () => {
      expect(isActiveSingboxRelease(R(BUNDLED), status())).toBe(true);
      expect(isActiveSingboxRelease(R('1.14.3'), status())).toBe(false);
      expect(isActiveSingboxRelease(R('1.14.3'), status({ currentVersion: '1.14.3' }))).toBe(true);
      expect(isActiveSingboxRelease(R('1.14.3'), status({ currentVersion: 'v1.14.3' }))).toBe(true);
      // unknown 构建按官方处理（主进程同样只拦 fork）
      expect(
        isActiveSingboxRelease(R('1.14.3'), status({ currentVersion: '1.14.3', build: 'unknown' }))
      ).toBe(true);
    });
    it('never treats a fork, an unknown version, a dev build or a missing status as current', () => {
      const fork = status({ currentVersion: '1.14.3-reF1nd', build: 'fork' });
      expect(isActiveSingboxRelease(R('1.14.3'), fork)).toBe(false);
      // fork 的 rc 尾段在 getCoreVersion 被截成官方形：版本相同也不算「当前」
      expect(isActiveSingboxRelease(R(BUNDLED), status({ build: 'fork' }))).toBe(false);
      expect(isActiveSingboxRelease(R(BUNDLED), status({ currentVersion: '未知' }))).toBe(false);
      expect(isActiveSingboxRelease(R(BUNDLED), status({ currentVersion: '' }))).toBe(false);
      expect(isActiveSingboxRelease(R(BUNDLED), status({ currentVersion: null }))).toBe(false);
      // 官方 dev 构建（base + 短 commit）不是该 release 本身 → 可用正式构建替换
      expect(
        isActiveSingboxRelease(R('1.14.3'), status({ currentVersion: '1.14.3-0a1b2c3d' }))
      ).toBe(false);
      expect(isActiveSingboxRelease(R(BUNDLED), null)).toBe(false);
    });
    it('bundled = the manifest version, whatever is running', () => {
      expect(isBundledSingboxRelease(R(BUNDLED), status({ currentVersion: '1.14.3' }))).toBe(true);
      expect(isBundledSingboxRelease(R(BUNDLED), status({ build: 'fork' }))).toBe(true);
      expect(isBundledSingboxRelease(R('1.14.0'), status())).toBe(false);
      expect(isBundledSingboxRelease(R(BUNDLED), null)).toBe(false);
    });
  });

  describe('crossBand', () => {
    it('is true only above the bundled major.minor', () => {
      expect(crossBand('1.15.0-alpha.12', BUNDLED)).toBe(true);
      expect(crossBand('1.15.0', BUNDLED)).toBe(true);
      expect(crossBand('2.0.0', BUNDLED)).toBe(true);
      expect(crossBand('1.14.3', BUNDLED)).toBe(false);
      expect(crossBand('1.14.0-rc.5', BUNDLED)).toBe(false);
      expect(crossBand(BUNDLED, BUNDLED)).toBe(false);
      expect(crossBand('1.13.21', BUNDLED)).toBe(false);
    });
    it('compares minor as an integer, and is false when either side is unparsable', () => {
      expect(crossBand('1.20.0', '1.9.0')).toBe(true);
      expect(crossBand('1.9.0', '1.20.0')).toBe(false);
      expect(crossBand('nightly', BUNDLED)).toBe(false);
      expect(crossBand('1.15.0', '未知')).toBe(false);
      expect(crossBand('1.15.0', '')).toBe(false);
      expect(crossBand('1.15.0', null)).toBe(false);
      expect(crossBand('1.15.0', undefined)).toBe(false);
    });
  });

  describe('filterSingboxReleases', () => {
    it('toggle off: stable releases plus the bundled rc (itself a pre-release); on: everything, order kept', () => {
      expect(versionsOf(filterSingboxReleases(list, false, status()))).toEqual([
        ...STABLES,
        BUNDLED,
      ]);
      expect(versionsOf(filterSingboxReleases(list, true, status()))).toEqual(VERSIONS);
    });
    it('keeps the bundled rc visible when another version is running', () => {
      expect(
        versionsOf(filterSingboxReleases(list, false, status({ currentVersion: '1.14.3' })))
      ).toEqual([...STABLES, BUNDLED]);
    });
    it('keeps the active pre-release visible with the toggle off', () => {
      expect(
        versionsOf(
          filterSingboxReleases(list, false, status({ currentVersion: '1.15.0-alpha.12' }))
        )
      ).toEqual(['1.15.0-alpha.12', ...STABLES, BUNDLED]);
      expect(
        versionsOf(filterSingboxReleases(list, false, status({ currentVersion: '1.14.0-rc.4' })))
      ).toEqual([...STABLES, '1.14.0-rc.4', BUNDLED]);
      // fork 不算「当前」→ 同版本预发布仍按开关隐藏
      const fork = status({ currentVersion: '1.15.0-alpha.12', build: 'fork' });
      expect(versionsOf(filterSingboxReleases(list, false, fork))).toEqual([...STABLES, BUNDLED]);
    });
    it('without status only stable releases survive the toggle', () => {
      expect(versionsOf(filterSingboxReleases(list, false, null))).toEqual(STABLES);
    });
    it('drops releases without this platform asset, drafts and below-minimum ones', () => {
      const odd = [
        rel('1.14.4', { hasAsset: false, assetName: null }),
        rel('1.14.5', { draft: true }),
        rel('1.13.21', { belowMinimum: true }),
        R('1.14.3'),
      ];
      expect(versionsOf(filterSingboxReleases(odd, true, status()))).toEqual(['1.14.3']);
    });
    it('works on the shared normalizer output for interleaved API order', () => {
      // GitHub API 按时间序：1.13.21 补丁夹在 1.14 预发布与正式版之间
      const raw = ['v1.14.0', 'v1.13.21', 'v1.14.0-rc.2', 'v1.15.0-alpha.1', 'v1.14.0-rc.1'].map(
        (tag) => ({
          tag_name: tag,
          draft: false,
          prerelease: tag.includes('-'),
          html_url: `https://github.com/SagerNet/sing-box/releases/tag/${tag}`,
          published_at: '2026-08-30T00:00:00Z',
          assets: [{ name: `sing-box-${tag.slice(1)}-linux-amd64.tar.gz` }],
        })
      );
      const releases = listableSingboxReleases(raw, 'linux', 'x64', BUNDLED);
      expect(versionsOf(filterSingboxReleases(releases, false, status()))).toEqual([
        '1.14.0',
        BUNDLED,
      ]);
      expect(versionsOf(filterSingboxReleases(releases, true, status()))).toEqual([
        '1.15.0-alpha.1',
        '1.14.0',
        '1.14.0-rc.2',
        BUNDLED,
      ]);
    });
  });

  describe('pickSelection (re-exported)', () => {
    it('falls back to the newest entry when the previous pick is filtered out', () => {
      const off = filterSingboxReleases(list, false, status());
      expect(pickSelection(off, 'v1.15.0-alpha.12')).toBe('v1.14.3');
      expect(pickSelection(off, `v${BUNDLED}`)).toBe(`v${BUNDLED}`);
      expect(pickSelection(filterSingboxReleases(list, true, status()), '')).toBe(
        'v1.15.0-alpha.12'
      );
      expect(pickSelection([], 'v1.14.3')).toBe('');
    });
  });

  describe('optionParts + composeOptionLabel', () => {
    const zh = {
      prerelease: '（预发布）',
      current: '（当前）',
      bundled: '（随包）',
      staged: '（待生效）',
      crossBand: '（跨版本带）',
      knownBad: '（曾验证失败）',
    };
    it('returns every flag explicitly', () => {
      expect(optionParts(R(BUNDLED), status())).toEqual({
        tag: `v${BUNDLED}`,
        date: '2026-08-24',
        prerelease: true,
        current: true,
        bundled: true,
        staged: false,
        crossBand: false,
        knownBad: false,
      });
      expect(
        optionParts(rel('1.15.0-alpha.12', { knownBad: true }), status({ stagedVersion: '1.14.3' }))
      ).toEqual({
        tag: 'v1.15.0-alpha.12',
        date: null,
        prerelease: true,
        current: false,
        bundled: false,
        staged: false,
        crossBand: true,
        knownBad: true,
      });
      expect(optionParts(R('1.14.3'), status({ stagedVersion: '1.14.3' }))).toMatchObject({
        date: '2026-10-09',
        prerelease: false,
        staged: true,
      });
      // knownBad 缺省（纯函数产出的 release 不带它）按 false
      expect(optionParts(rel('1.14.2', { knownBad: undefined }), status()).knownBad).toBe(false);
      // fork 运行同版本：不标当前，仍标随包；状态未取到：什么都不标
      expect(optionParts(R(BUNDLED), status({ build: 'fork' }))).toMatchObject({
        current: false,
        bundled: true,
      });
      expect(optionParts(R('1.15.0-alpha.12'), null)).toMatchObject({
        current: false,
        bundled: false,
        staged: false,
        crossBand: false,
      });
    });
    it('composes flags in a fixed order: pre-release, current, bundled, staged, cross-band, known-bad', () => {
      expect(composeOptionLabel(optionParts(R(BUNDLED), status()), zh)).toBe(
        `v${BUNDLED} · 2026-08-24（预发布）（当前）（随包）`
      );
      expect(composeOptionLabel(optionParts(R('1.15.0-alpha.12'), status()), zh)).toBe(
        'v1.15.0-alpha.12 · 2026-10-11（预发布）（跨版本带）'
      );
      expect(
        composeOptionLabel(optionParts(R('1.14.3'), status({ stagedVersion: '1.14.3' })), zh)
      ).toBe('v1.14.3 · 2026-10-09（待生效）');
      const everything = {
        tag: 'v9.9.9',
        date: null,
        prerelease: true,
        current: true,
        bundled: true,
        staged: true,
        crossBand: true,
        knownBad: true,
      };
      expect(composeOptionLabel(everything, zh)).toBe(
        'v9.9.9（预发布）（当前）（随包）（待生效）（跨版本带）（曾验证失败）'
      );
      // 只给三个基础文案（Xray 形状）→ 可选标记不显示
      const en = { prerelease: ' (pre-release)', current: ' (current)', bundled: ' (bundled)' };
      expect(composeOptionLabel(everything, en)).toBe('v9.9.9 (pre-release) (current) (bundled)');
    });
    it('re-exports releaseDate', () => {
      expect(releaseDate('2026-10-11T09:12:40Z')).toBe('2026-10-11');
      expect(releaseDate(null)).toBeNull();
    });
  });

  describe('singboxReleaseAction', () => {
    it('is current for the running official version', () => {
      expect(singboxReleaseAction(R(BUNDLED), status())).toBe('current');
      expect(singboxReleaseAction(R('1.14.3'), status({ currentVersion: '1.14.3' }))).toBe(
        'current'
      );
    });
    it('restores (resetFactory, no download) when picking the bundled version off-bundled', () => {
      expect(singboxReleaseAction(R(BUNDLED), status({ currentVersion: '1.14.3' }))).toBe(
        'restore'
      );
      expect(singboxReleaseAction(R(BUNDLED), status({ currentVersion: '1.15.0-alpha.12' }))).toBe(
        'restore'
      );
      // 同版本 fork 也走恢复随包（用随包官方构建替换 fork）
      expect(singboxReleaseAction(R(BUNDLED), status({ build: 'fork' }))).toBe('restore');
      expect(singboxReleaseAction(R(BUNDLED), status({ currentVersion: '未知' }))).toBe('restore');
    });
    it('installs everything else', () => {
      expect(singboxReleaseAction(R('1.14.3'), status())).toBe('install');
      expect(singboxReleaseAction(R('1.15.0-alpha.12'), status())).toBe('install');
      expect(singboxReleaseAction(R('1.14.1'), status({ currentVersion: '1.14.3' }))).toBe(
        'install'
      );
      // 待生效的就是它：仍是在线安装（主进程作废暂存后重新下载、校验）
      expect(singboxReleaseAction(R('1.14.3'), status({ stagedVersion: '1.14.3' }))).toBe(
        'install'
      );
      expect(
        singboxReleaseAction(R('1.14.3'), status({ currentVersion: '1.14.3', build: 'fork' }))
      ).toBe('install');
      expect(singboxReleaseAction(R(BUNDLED), null)).toBe('install');
    });
  });

  describe('latestStable', () => {
    it('takes the semver maximum, not list order, ignoring pre-releases and drafts', () => {
      const shuffled = [R('1.14.0'), R('1.15.0-alpha.12'), R('1.14.3'), R('1.14.1'), R(BUNDLED)];
      expect(latestStable(shuffled)?.version).toBe('1.14.3');
      expect(latestStable([...shuffled, rel('1.14.4', { draft: true })])?.version).toBe('1.14.3');
      // API 标为预发布的纯 X.Y.Z 也不算正式版（与主进程 checkUpdate 同口径）
      expect(latestStable([...shuffled, rel('1.14.5', { prerelease: true })])?.version).toBe(
        '1.14.3'
      );
      expect(latestStable([rel('1.14.9'), rel('1.14.10')])?.version).toBe('1.14.10');
      expect(latestStable(list)).toBe(R('1.14.3'));
    });
    it('still returns a known-bad maximum (main does not fall back to the next one)', () => {
      expect(latestStable([rel('1.14.3', { knownBad: true }), R('1.14.2')])?.version).toBe(
        '1.14.3'
      );
    });
    it('is null without any stable release', () => {
      expect(latestStable([])).toBeNull();
      expect(latestStable([R('1.15.0-alpha.12'), R(BUNDLED)])).toBeNull();
    });
  });

  describe('autoUpdateSupersedes', () => {
    const on = status({ autoUpdateEnabled: true });
    it('names the newest in-band stable release that auto-update would move the pick to', () => {
      expect(autoUpdateSupersedes(R('1.14.1'), list, on)).toBe('1.14.3');
      expect(autoUpdateSupersedes(R('1.14.0-rc.5'), list, on)).toBe('1.14.3');
      expect(autoUpdateSupersedes(R(BUNDLED), list, on)).toBe('1.14.3');
      // 新 minor 出了正式版：同带的 alpha 会被升上去
      const with150 = [rel('1.15.0'), ...list];
      expect(autoUpdateSupersedes(R('1.15.0-alpha.12'), with150, on)).toBe('1.15.0');
    });
    it('is null when auto-update is off, the pick is already the newest, or it is in another band', () => {
      expect(autoUpdateSupersedes(R('1.14.1'), list, status())).toBeNull();
      expect(
        autoUpdateSupersedes(R('1.14.1'), list, status({ autoUpdateEnabled: undefined }))
      ).toBeNull();
      expect(autoUpdateSupersedes(R('1.14.1'), list, null)).toBeNull();
      expect(autoUpdateSupersedes(R('1.14.3'), list, on)).toBeNull();
      expect(autoUpdateSupersedes(R('1.15.0-alpha.12'), list, on)).toBeNull();
      expect(autoUpdateSupersedes(R('1.14.1'), [], on)).toBeNull();
    });
    it('mirrors main: the global newest stable decides, a known-bad one stops the cycle', () => {
      // 全局最新正式版在 1.15 带：自动轮次只提示跨带、不落位，同带有更新的 1.14.3 也不会被换
      const with150 = [rel('1.15.0'), ...list];
      expect(autoUpdateSupersedes(R('1.14.1'), with150, on)).toBeNull();
      // 最新正式版曾验证失败：主进程整轮跳过，不回退到 1.14.2
      const bad = list.map((r) => (r.version === '1.14.3' ? { ...r, knownBad: true } : r));
      expect(autoUpdateSupersedes(R('1.14.1'), bad, on)).toBeNull();
    });
    it('ignores the current fork state (the install makes the core official)', () => {
      const fork = status({
        autoUpdateEnabled: true,
        currentVersion: '1.14.3-reF1nd',
        build: 'fork',
      });
      expect(autoUpdateSupersedes(R('1.14.2'), list, fork)).toBe('1.14.3');
    });
  });

  describe('singboxConfirms', () => {
    it('needs nothing for a newer stable release with the proxy stopped and auto-update off', () => {
      expect(singboxConfirms(R('1.14.3'), list, status(), false)).toEqual([]);
      expect(singboxConfirms(R('1.14.0'), list, status(), false)).toEqual([]);
    });
    it('needs nothing for the current version, whatever else is true', () => {
      const s = status({
        currentVersion: '1.14.1',
        stagedVersion: '1.14.3',
        autoUpdateEnabled: true,
      });
      expect(singboxConfirms(R('1.14.1'), list, s, true)).toEqual([]);
    });
    it('lists every reason in the spec order', () => {
      const s = status({
        currentVersion: '1.15.0-alpha.12',
        build: 'fork',
        stagedVersion: '1.14.3',
        autoUpdateEnabled: true,
      });
      const releases = [rel('1.15.0'), ...list];
      const pick = rel('1.15.0-alpha.5', { knownBad: true });
      const all: SingboxConfirmReason[] = [
        'prerelease',
        'crossBand',
        'downgrade',
        'knownBad',
        'fork',
        'staged',
        'autoUpdate',
        'restart',
      ];
      expect(singboxConfirms(pick, releases, s, true)).toEqual(all);
    });
    it('collects install reasons individually', () => {
      expect(singboxConfirms(R('1.14.0-rc.5'), list, status(), false)).toEqual(['prerelease']);
      expect(singboxConfirms(R('1.15.0-alpha.12'), list, status(), true)).toEqual([
        'prerelease',
        'crossBand',
        'restart',
      ]);
      expect(
        singboxConfirms(R('1.14.1'), list, status({ currentVersion: '1.14.3' }), false)
      ).toEqual(['downgrade']);
      expect(singboxConfirms(rel('1.14.2', { knownBad: true }), list, status(), false)).toEqual([
        'knownBad',
      ]);
      expect(
        singboxConfirms(
          R('1.14.3'),
          list,
          status({ currentVersion: '1.14.2-reF1nd', build: 'fork' }),
          false
        )
      ).toEqual(['fork']);
      expect(
        singboxConfirms(R('1.14.2'), list, status({ stagedVersion: '1.14.3' }), false)
      ).toEqual(['staged']);
      expect(
        singboxConfirms(R('1.14.1'), list, status({ autoUpdateEnabled: true }), false)
      ).toEqual(['autoUpdate']);
      expect(singboxConfirms(R('1.14.3'), list, status(), true)).toEqual(['restart']);
    });
    it('does not warn about the staged update when installing that very version', () => {
      expect(
        singboxConfirms(R('1.14.3'), list, status({ stagedVersion: '1.14.3' }), false)
      ).toEqual([]);
    });
    it('judges a downgrade against the release the running core is built from', () => {
      // fork 尾段不参与比较：-nekolsd 若按 semver 预发布段比，'rc' > 'nekolsd' 会把 rc.5 误判成更新
      const fork = (currentVersion: string) => status({ currentVersion, build: 'fork' });
      expect(singboxConfirms(R('1.14.0-rc.5'), list, fork('1.14.0-nekolsd'), false)).toEqual([
        'prerelease',
        'downgrade',
        'fork',
      ]);
      expect(singboxConfirms(R('1.14.3'), list, fork('1.14.3-reF1nd'), false)).toEqual(['fork']);
      expect(singboxConfirms(R('1.14.2'), list, fork('1.14.3-reF1nd'), false)).toEqual([
        'downgrade',
        'fork',
      ]);
      // 官方 dev 构建：同 base 不算降级，更旧才算
      const dev = status({ currentVersion: '1.14.3-0a1b2c3d' });
      expect(singboxConfirms(R('1.14.3'), list, dev, false)).toEqual([]);
      expect(singboxConfirms(R('1.14.2'), list, dev, false)).toEqual(['downgrade']);
      // 版本未知：不臆测降级
      expect(singboxConfirms(R('1.14.0'), list, status({ currentVersion: '未知' }), false)).toEqual(
        []
      );
      expect(singboxConfirms(R('1.14.0'), list, status({ currentVersion: null }), false)).toEqual(
        []
      );
    });
    it('restoring the bundled version warns about fork, staged update, auto-update and restart', () => {
      const s = status({
        currentVersion: '1.15.0-alpha.12',
        stagedVersion: '1.14.3',
        autoUpdateEnabled: true,
      });
      // 随包 rc 本身是预发布、比现役旧——恢复随包不提这些；但自动更新稍后会把它升到 1.14.3（恢复还会清掉固定），
      // 照样警示（只是不给「固定此版本」，文案提示先关自动更新）
      expect(singboxConfirms(R(BUNDLED), list, s, true)).toEqual([
        'staged',
        'autoUpdate',
        'restart',
      ]);
      expect(
        singboxConfirms(R(BUNDLED), list, status({ ...s, autoUpdateEnabled: false }), true)
      ).toEqual(['staged', 'restart']);
      expect(singboxConfirms(R(BUNDLED), list, status({ build: 'fork' }), false)).toEqual(['fork']);
      expect(
        singboxConfirms(R(BUNDLED), list, status({ currentVersion: '1.14.3' }), false)
      ).toEqual([]);
    });
    it('without status only the release itself and the restart are judged', () => {
      expect(singboxConfirms(rel('1.15.0-alpha.12', { knownBad: true }), list, null, true)).toEqual(
        ['prerelease', 'knownBad', 'restart']
      );
    });
  });

  describe('confirm dialog helpers', () => {
    it('maps every reason to its key, with dedicated fork / auto-update texts for restore', () => {
      const expected: Record<SingboxConfirmReason, string> = {
        prerelease: 'settings.coreManagement.confirmPrerelease',
        crossBand: 'settings.coreManagement.confirmCrossBand',
        downgrade: 'settings.coreManagement.confirmDowngrade',
        knownBad: 'settings.coreManagement.confirmKnownBad',
        fork: 'settings.coreManagement.confirmFork',
        staged: 'settings.coreManagement.confirmStaged',
        autoUpdate: 'settings.coreManagement.confirmAutoUpdate',
        restart: 'settings.coreManagement.confirmRestart',
      };
      for (const [reason, key] of Object.entries(expected) as [SingboxConfirmReason, string][]) {
        expect(confirmReasonKey(reason)).toBe(key);
        expect(confirmReasonKey(reason, 'install')).toBe(key);
      }
      expect(confirmReasonKey('fork', 'restore')).toBe('settings.coreManagement.confirmForkReset');
      expect(confirmReasonKey('autoUpdate', 'restore')).toBe(
        'settings.coreManagement.confirmAutoUpdateReset'
      );
      // 从第三方内核恢复：自动更新开关被禁用、显示为关 →「先关闭自动更新」做不到，改用恢复后再关的文案
      expect(confirmReasonKey('autoUpdate', 'restore', true)).toBe(
        'settings.coreManagement.confirmAutoUpdateResetFork'
      );
      expect(confirmReasonKey('autoUpdate', 'install', true)).toBe(
        'settings.coreManagement.confirmAutoUpdate'
      );
      expect(confirmReasonKey('fork', 'restore', true)).toBe(
        'settings.coreManagement.confirmForkReset'
      );
      expect(confirmReasonKey('restart', 'restore')).toBe('settings.coreManagement.confirmRestart');
    });
    it('uses the "install anyway" wording only for risk reasons', () => {
      for (const r of ['prerelease', 'crossBand', 'downgrade', 'knownBad', 'fork'] as const) {
        expect(confirmAnyway([r])).toBe(true);
        expect(confirmAnyway(['restart', r])).toBe(true);
      }
      expect(confirmAnyway(['staged', 'autoUpdate', 'restart'])).toBe(false);
      expect(confirmAnyway([])).toBe(false);
    });
    it('sends force only after a fork confirm and pin only for a checked auto-update confirm', () => {
      expect(installOptions([], false)).toEqual({ force: false, pin: false });
      expect(installOptions([], true)).toEqual({ force: false, pin: false });
      expect(installOptions(['fork', 'restart'], false)).toEqual({ force: true, pin: false });
      expect(installOptions(['autoUpdate'], true)).toEqual({ force: false, pin: true });
      expect(installOptions(['autoUpdate'], false)).toEqual({ force: false, pin: false });
      expect(installOptions(['prerelease', 'fork', 'autoUpdate'], true)).toEqual({
        force: true,
        pin: true,
      });
    });
  });

  describe('channelPill', () => {
    it('bundled ok / user-installed pre-release warn / nothing otherwise', () => {
      expect(channelPill(status())).toEqual({
        cls: 'ok',
        key: 'settings.coreManagement.channelBundled',
      });
      expect(channelPill(status({ currentVersion: '1.15.0-alpha.12' }))).toEqual({
        cls: 'warn',
        key: 'settings.coreManagement.channelPrerelease',
      });
      expect(channelPill(status({ currentVersion: '1.14.0-rc.5' }))?.cls).toBe('warn');
      expect(channelPill(status({ currentVersion: '1.14.3' }))).toBeNull();
      expect(channelPill(status({ currentVersion: '1.14.3-0a1b2c3d' }))).toBeNull();
    });
    it('shows nothing for a fork, an unknown build or an unknown version', () => {
      expect(channelPill(status({ build: 'fork' }))).toBeNull();
      expect(channelPill(status({ build: 'fork', currentVersion: '1.15.0-alpha.12' }))).toBeNull();
      expect(channelPill(status({ build: 'unknown' }))).toBeNull();
      expect(channelPill(status({ currentVersion: '未知' }))).toBeNull();
      expect(channelPill(null)).toBeNull();
    });
  });

  describe('progress', () => {
    const PHASE_KEYS: Record<SingboxInstallPhase, string> = {
      downloading: 'settings.coreManagement.phaseDownloading',
      verifying: 'settings.coreManagement.phaseVerifying',
      extracting: 'settings.coreManagement.phaseExtracting',
      testing: 'settings.coreManagement.phaseTesting',
      switching: 'settings.coreManagement.phaseSwitching',
      restarting: 'settings.coreManagement.phaseRestarting',
    };
    it('covers exactly the shared phases', () => {
      expect([...SINGBOX_INSTALL_PHASES].sort()).toEqual(Object.keys(PHASE_KEYS).sort());
    });
    it('maps every phase to its key; switching during a reset reads as restoring', () => {
      for (const [phase, key] of Object.entries(PHASE_KEYS) as [SingboxInstallPhase, string][]) {
        expect(phaseKey({ phase, kind: 'install' })).toBe(key);
        if (phase !== 'switching') expect(phaseKey({ phase, kind: 'reset' })).toBe(key);
      }
      expect(phaseKey({ phase: 'switching', kind: 'reset' })).toBe(
        'settings.coreManagement.phaseRestoring'
      );
      // Xray 的恢复 kind 在这里不算（sing-box 恢复随包的 kind 是 reset）
      expect(phaseKey({ phase: 'switching', kind: 'restore' as unknown as 'reset' })).toBe(
        'settings.coreManagement.phaseSwitching'
      );
    });
    it('falls back to the switching text for an unknown phase', () => {
      for (const phase of ['stopping', 'toString', ''])
        expect(phaseKey({ phase: phase as SingboxInstallPhase, kind: 'install' })).toBe(
          'settings.coreManagement.phaseSwitching'
        );
    });
    it('bar width follows the download percent, then stays full', () => {
      expect(progressBarPercent({ phase: 'downloading', percent: 37.9 })).toBe(37);
      expect(progressBarPercent({ phase: 'downloading' })).toBe(0);
      expect(progressBarPercent({ phase: 'downloading', percent: 250 })).toBe(100);
      expect(progressBarPercent({ phase: 'testing' })).toBe(100);
    });
  });

  describe('errors', () => {
    // Record 键穷举：SingboxInstallErrorCode 增删时本测试编译失败
    const CODES: Record<SingboxInstallErrorCode, true> = {
      BUSY: true,
      XRAY_BUSY: true,
      PROXY_BUSY: true,
      INVALID_TAG: true,
      NOT_FOUND: true,
      RATE_LIMITED: true,
      NETWORK: true,
      DRAFT: true,
      NO_ASSET: true,
      BELOW_MINIMUM: true,
      NO_HASH: true,
      HASH_MISMATCH: true,
      DOWNLOAD_FAILED: true,
      EXTRACT_FAILED: true,
      VERSION_MISMATCH: true,
      NOT_OFFICIAL: true,
      EXEC_FAILED: true,
      PREFLIGHT_FAILED: true,
      GVISOR_MISSING: true,
      HELPER_REQUIRED: true,
      FORK_CONFIRM_REQUIRED: true,
      START_FAILED: true,
      START_BLOCKED: true,
      FAILED: true,
    };
    const codes = Object.keys(CODES) as SingboxInstallErrorCode[];
    it('knows exactly the shared error codes', () => {
      expect(codes).toHaveLength(24);
      expect([...SINGBOX_INSTALL_ERROR_CODES].sort()).toEqual([...codes].sort());
    });
    it('maps every install error code to its own key', () => {
      for (const code of codes) {
        expect(errorMessageKey(code)).toBe(`settings.coreManagement.errors.${code}`);
        expect(errorMessageKey(code, true)).toBe(`settings.coreManagement.errors.${code}`);
      }
    });
    it('distinguishes a failed rollback and falls back to FAILED for unknown codes', () => {
      expect(errorMessageKey('START_FAILED', false)).toBe(
        'settings.coreManagement.errors.START_FAILED_NO_ROLLBACK'
      );
      expect(errorMessageKey('START_FAILED')).toBe('settings.coreManagement.errors.START_FAILED');
      expect(errorMessageKey('PREFLIGHT_FAILED', false)).toBe(
        'settings.coreManagement.errors.PREFLIGHT_FAILED'
      );
      // 环境原因起不来（未回滚、新核留用）有自己的文案，不落到「无法恢复原内核」
      expect(errorMessageKey('START_BLOCKED', false)).toBe(
        'settings.coreManagement.errors.START_BLOCKED'
      );
      for (const odd of ['SOMETHING_NEW', 'toString', 'constructor', '', undefined, null, 42]) {
        expect(errorMessageKey(odd)).toBe('settings.coreManagement.errors.FAILED');
      }
      // Xray 专有码不在 sing-box 集合里
      for (const xrayOnly of ['CORE_BUSY', 'CONFIG_TEST_FAILED', 'IN_USE']) {
        expect(errorMessageKey(xrayOnly)).toBe('settings.coreManagement.errors.FAILED');
      }
    });
    it('list errors are RATE_LIMITED or NETWORK and map into the same table', () => {
      const limited = Object.assign(new Error('x'), { code: 'RATE_LIMITED' });
      expect(errorMessageKey(listErrorCode(limited))).toBe(
        'settings.coreManagement.errors.RATE_LIMITED'
      );
      expect(errorMessageKey(listErrorCode(new Error('x')))).toBe(
        'settings.coreManagement.errors.NETWORK'
      );
      expect(listErrorCode(null)).toBe('NETWORK');
    });
    it('attaches main-process detail only where it adds information', () => {
      const withDetail = [
        'FAILED',
        'NETWORK',
        'DOWNLOAD_FAILED',
        'EXTRACT_FAILED',
        'VERSION_MISMATCH',
        'NOT_OFFICIAL',
        'PREFLIGHT_FAILED',
        'START_FAILED',
        'START_BLOCKED',
      ];
      for (const code of codes) expect(errorShowsDetail(code)).toBe(withDetail.includes(code));
      expect(errorShowsDetail('toString')).toBe(false);
      expect(errorShowsDetail(undefined)).toBe(false);
    });
  });

  describe('failureDetail', () => {
    // 实测 1.15.0-alpha.12 `sing-box check`（stderr 带 ANSI 色码；先打 TUN stack 弃用 WARN，再 FATAL）
    const warnText =
      '[0000] `stack` option in TUN is deprecated in sing-box 1.15.0 and will be removed in sing-box 1.17.0, checkout documentation for migration: https://sing-box.sagernet.org/migration/#migrate-tun-stack';
    const fatalText =
      '[0000] initialize outbound[0]: default domain resolver not found: no-such-tag';
    const ansiOut = `\x1b[33mWARN\x1b[0m${warnText}\n\x1b[31mFATAL\x1b[0m${fatalText}\n`;
    const cleanWarn = `WARN${warnText}`;
    const cleanFatal = `FATAL${fatalText}`;
    it('keeps the last FATAL line of sing-box output (head clipping would only show the WARN)', () => {
      expect(clipDetail(`${cleanWarn}\n${cleanFatal}`)).not.toContain('no-such-tag');
      expect(failureDetail('PREFLIGHT_FAILED', ansiOut)).toBe(cleanFatal);
      // 主进程已剥色码、过长时带「…」前缀取尾
      expect(failureDetail('PREFLIGHT_FAILED', `…${cleanWarn}\n${cleanFatal}`)).toBe(cleanFatal);
      expect(failureDetail('START_FAILED', 'FATAL[0000] a\r\nFATAL[0001] b')).toBe('FATAL[0001] b');
    });
    it('otherwise strips colours and clips', () => {
      expect(
        failureDetail('VERSION_MISMATCH', '  解出的内核报告版本 1.14.2，与所选 1.14.3 不符  ')
      ).toBe('解出的内核报告版本 1.14.2，与所选 1.14.3 不符');
      expect(failureDetail('FAILED', '\x1b[31mboom\x1b[0m')).toBe('boom');
      const long = failureDetail('DOWNLOAD_FAILED', 'é'.repeat(500));
      expect(Array.from(long)).toHaveLength(240);
      expect(long.endsWith('…')).toBe(true);
    });
    it('is empty for codes whose text says it all, or without detail', () => {
      expect(failureDetail('GVISOR_MISSING', '请先在「设置 → 网络」把网络栈改为 System')).toBe('');
      expect(failureDetail('HASH_MISMATCH', 'sha256 不符')).toBe('');
      expect(failureDetail('PREFLIGHT_FAILED', undefined)).toBe('');
      expect(failureDetail('PREFLIGHT_FAILED', '   ')).toBe('');
    });
  });

  describe('isolateLtr（RTL 界面里插进译文的版本号）', () => {
    it('wraps the value in LRI … PDI so `1.14.0-rc.1` is not reordered to `rc.1-1.14.0` in fa', () => {
      expect(isolateLtr('1.14.0-rc.1')).toBe('\u20661.14.0-rc.1\u2069');
      expect(isolateLtr('v1.15.0-alpha.12')).toBe('\u2066v1.15.0-alpha.12\u2069');
      // 去掉控制符即原文：LTR 语言下显示不变
      expect(isolateLtr('1.14.3-fork').replace(/[\u2066\u2069]/g, '')).toBe('1.14.3-fork');
    });

    it('leaves an empty value empty (no stray control characters)', () => {
      expect(isolateLtr('')).toBe('');
    });
  });
});
