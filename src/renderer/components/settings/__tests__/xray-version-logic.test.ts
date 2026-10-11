/**
 * Xray 卡纯决策逻辑单测（xray-version-logic.ts）：列表过滤 / 选中保持 / 选项文案 / 动作按钮 / 确认理由 /
 * 徽章 / 警示条 / 进度 / 错误码映射 / `run -test` 输出摘要。
 */
import {
  clipDetail,
  composeOptionLabel,
  confirmReasonKey,
  confirmsNeeded,
  errorMessageKey,
  errorShowsDetail,
  filterReleases,
  isActiveRelease,
  listErrorCode,
  optionLabelParts,
  phaseKey,
  pickSelection,
  progressBarPercent,
  releaseAction,
  releaseDate,
  restoreConfirms,
  runStatePill,
  sourcePill,
  statusNotes,
  summarizeConfigTestDetail,
  type XrayStatusLike,
} from '../xray-version-logic';
import type { XrayInstallErrorCode, XrayRelease } from '../../../../shared/xray-release';
import enUS from '../../../i18n/locales/en-US.json';

const rel = (version: string, over: Partial<XrayRelease> = {}): XrayRelease => ({
  tag: `v${version}`,
  version,
  name: `Xray-core v${version}`,
  prerelease: false,
  draft: false,
  publishedAt: `${version.replace(/^(\d+)\.(\d+)\.(\d+)$/, '20$1-01-01')}T00:00:00Z`,
  htmlUrl: `https://github.com/XTLS/Xray-core/releases/tag/v${version}`,
  assetName: 'Xray-linux-64.zip',
  hasAsset: true,
  belowMinimum: false,
  ...over,
});

const status = (over: Partial<XrayStatusLike> = {}): XrayStatusLike => ({
  available: true,
  version: '26.3.27',
  running: false,
  nodes: 0,
  source: 'bundled',
  bundledVersion: '26.3.27',
  minVersion: '26.1.23',
  belowMinimum: false,
  ...over,
});

const pre1010 = rel('26.10.10', { prerelease: true, publishedAt: '2026-10-10T08:00:00Z' });
const pre913 = rel('26.9.13', { prerelease: true });
const stable327 = rel('26.3.27', { publishedAt: '2026-03-27T12:00:00Z' });
const stable223 = rel('26.2.23');
const list = [pre1010, pre913, stable327, stable223];

/** 按点分路径取 en-US 叶子值（断言映射出的 i18n 键真实存在）。 */
const enValue = (key: string): unknown =>
  key
    .split('.')
    .reduce<unknown>(
      (acc, seg) =>
        acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[seg] : undefined,
      enUS
    );

describe('xray-version-logic', () => {
  describe('isActiveRelease', () => {
    it('matches the running version for bundled and downloaded sources', () => {
      expect(isActiveRelease(stable327, status())).toBe(true);
      expect(
        isActiveRelease(
          pre1010,
          status({ version: '26.10.10', source: 'downloaded', prerelease: true })
        )
      ).toBe(true);
      expect(isActiveRelease(pre913, status())).toBe(false);
    });
    it('never treats a custom file, a missing binary or an unknown version as current', () => {
      expect(isActiveRelease(stable327, status({ source: 'custom' }))).toBe(false);
      expect(isActiveRelease(stable327, status({ available: false }))).toBe(false);
      expect(isActiveRelease(stable327, status({ version: null }))).toBe(false);
      expect(isActiveRelease(stable327, null)).toBe(false);
    });
  });

  describe('filterReleases', () => {
    it('hides pre-releases unless the toggle is on, keeping order', () => {
      expect(filterReleases(list, false, status()).map((r) => r.version)).toEqual([
        '26.3.27',
        '26.2.23',
      ]);
      expect(filterReleases(list, true, status()).map((r) => r.version)).toEqual([
        '26.10.10',
        '26.9.13',
        '26.3.27',
        '26.2.23',
      ]);
    });
    it('keeps the active pre-release visible with the toggle off', () => {
      const active = status({ version: '26.9.13', source: 'downloaded', prerelease: true });
      expect(filterReleases(list, false, active).map((r) => r.version)).toEqual([
        '26.9.13',
        '26.3.27',
        '26.2.23',
      ]);
      // custom 文件不算「当前」→ 同版本预发布仍按开关隐藏
      const custom = status({ version: '26.9.13', source: 'custom' });
      expect(filterReleases(list, false, custom).map((r) => r.version)).toEqual([
        '26.3.27',
        '26.2.23',
      ]);
    });
    it('drops releases without this platform asset, drafts and below-minimum ones', () => {
      const odd = [
        rel('26.4.1', { hasAsset: false, assetName: null }),
        rel('26.4.2', { draft: true }),
        rel('25.12.8', { belowMinimum: true }),
        stable327,
      ];
      expect(filterReleases(odd, true, status()).map((r) => r.version)).toEqual(['26.3.27']);
    });
  });

  describe('pickSelection', () => {
    it('keeps the previous selection when still listed, else falls back to the newest', () => {
      const filtered = filterReleases(list, true, status());
      expect(pickSelection(filtered, 'v26.9.13')).toBe('v26.9.13');
      expect(pickSelection(filtered, 'v1.0.0')).toBe('v26.10.10');
      expect(pickSelection(filtered, '')).toBe('v26.10.10');
      // 关掉预发布后原选中的预发布不在列表里 → 回落最新稳定版
      expect(pickSelection(filterReleases(list, false, status()), 'v26.9.13')).toBe('v26.3.27');
      expect(pickSelection([], 'v26.9.13')).toBe('');
    });
  });

  describe('option label', () => {
    it('extracts the date as YYYY-MM-DD or null', () => {
      expect(releaseDate('2026-10-10T08:00:00Z')).toBe('2026-10-10');
      expect(releaseDate(null)).toBeNull();
      expect(releaseDate('yesterday')).toBeNull();
      expect(releaseDate(undefined)).toBeNull();
    });
    it('marks pre-release, current and bundled', () => {
      const s = status();
      expect(optionLabelParts(pre1010, s)).toEqual({
        tag: 'v26.10.10',
        date: '2026-10-10',
        prerelease: true,
        current: false,
        bundled: false,
      });
      expect(optionLabelParts(stable327, s)).toEqual({
        tag: 'v26.3.27',
        date: '2026-03-27',
        prerelease: false,
        current: true,
        bundled: true,
      });
      // 现役为在线安装的 26.10.10：随包版本不再是「当前」，但仍标「随包」
      const dl = status({ version: '26.10.10', source: 'downloaded', prerelease: true });
      expect(optionLabelParts(stable327, dl)).toMatchObject({ current: false, bundled: true });
      expect(optionLabelParts(pre1010, dl)).toMatchObject({ current: true, bundled: false });
      // 状态未取到：不标当前 / 随包
      expect(optionLabelParts(stable327, null)).toMatchObject({ current: false, bundled: false });
    });
    it('composes the option text with locale-provided suffixes', () => {
      const zh = { prerelease: '（预发布）', current: '（当前）', bundled: '（随包）' };
      expect(composeOptionLabel(optionLabelParts(pre1010, status()), zh)).toBe(
        'v26.10.10 · 2026-10-10（预发布）'
      );
      expect(composeOptionLabel(optionLabelParts(stable327, status()), zh)).toBe(
        'v26.3.27 · 2026-03-27（当前）（随包）'
      );
      const en = { prerelease: ' (pre-release)', current: ' (current)', bundled: ' (bundled)' };
      expect(
        composeOptionLabel(optionLabelParts(rel('26.5.1', { publishedAt: null }), status()), en)
      ).toBe('v26.5.1');
    });
  });

  describe('releaseAction', () => {
    it('is current for the active version', () => {
      expect(releaseAction(stable327, status())).toBe('current');
      const dl = status({ version: '26.10.10', source: 'downloaded', prerelease: true });
      expect(releaseAction(pre1010, dl)).toBe('current');
    });
    it('switches (restore bundled, no download) when picking the bundled version off-bundled', () => {
      const dl = status({ version: '26.10.10', source: 'downloaded' });
      expect(releaseAction(stable327, dl)).toBe('switch');
      expect(releaseAction(stable327, status({ version: '26.3.27', source: 'custom' }))).toBe(
        'switch'
      );
    });
    it('installs everything else', () => {
      expect(releaseAction(pre1010, status())).toBe('install');
      expect(releaseAction(stable223, status())).toBe('install');
      expect(releaseAction(pre913, status({ version: '26.10.10', source: 'downloaded' }))).toBe(
        'install'
      );
      // 随包二进制缺失（开发环境）：选随包版本 → 在线安装
      expect(releaseAction(stable327, status({ available: false, version: null }))).toBe('install');
      expect(releaseAction(pre1010, null)).toBe('install');
    });
  });

  describe('confirmsNeeded', () => {
    it('needs nothing for a newer stable version with the proxy stopped', () => {
      const newer = rel('26.11.1');
      expect(confirmsNeeded(newer, status(), false)).toEqual([]);
      expect(confirmsNeeded(stable327, status(), true)).toEqual([]); // current → no action
    });
    it('collects pre-release, downgrade, custom and restart in order', () => {
      expect(confirmsNeeded(pre1010, status(), false)).toEqual(['prerelease']);
      expect(confirmsNeeded(stable223, status(), false)).toEqual(['downgrade']);
      expect(confirmsNeeded(pre1010, status({ source: 'custom' }), true)).toEqual([
        'prerelease',
        'custom',
        'restart',
      ]);
      expect(
        confirmsNeeded(
          rel('26.2.6', { prerelease: true }),
          status({ version: '26.10.10', source: 'downloaded' }),
          true
        )
      ).toEqual(['prerelease', 'downgrade', 'restart']);
    });
    it('switching back to the bundled version only warns about custom files and restarts', () => {
      const dl = status({ version: '26.10.10', source: 'downloaded', prerelease: true });
      expect(confirmsNeeded(stable327, dl, false)).toEqual([]);
      expect(confirmsNeeded(stable327, dl, true)).toEqual(['restart']);
      expect(
        confirmsNeeded(stable327, status({ version: '26.9.1', source: 'custom' }), true)
      ).toEqual(['custom', 'restart']);
    });
    it('restoreConfirms mirrors custom + restart', () => {
      expect(restoreConfirms(status({ source: 'downloaded' }), false)).toEqual([]);
      expect(restoreConfirms(status({ source: 'custom' }), true)).toEqual(['custom', 'restart']);
      expect(restoreConfirms(null, true)).toEqual(['restart']);
    });
    it('maps every reason to an existing i18n key', () => {
      for (const r of ['prerelease', 'downgrade', 'custom', 'restart'] as const) {
        expect(typeof enValue(confirmReasonKey(r))).toBe('string');
      }
    });
  });

  describe('pills and notes', () => {
    it('run-state pill: missing / running · n / idle', () => {
      expect(runStatePill(status({ available: false }))).toEqual({
        cls: 'warn',
        key: 'settings.xrayCore.missing',
      });
      expect(runStatePill(status({ running: true, nodes: 3 }))).toEqual({
        cls: 'ok',
        key: 'settings.xrayCore.running',
        n: 3,
      });
      expect(runStatePill(status({ running: true, nodes: Number.NaN })).n).toBe(0);
      expect(runStatePill(status())).toEqual({ cls: 'idle', key: 'settings.xrayCore.idle' });
    });
    it('source pill: bundled ok / downloaded info / pre-release warn / custom idle', () => {
      expect(sourcePill(status())).toEqual({ cls: 'ok', key: 'settings.xrayCore.sourceBundled' });
      expect(sourcePill(status({ source: 'downloaded' }))).toEqual({
        cls: 'info',
        key: 'settings.xrayCore.sourceDownloaded',
      });
      expect(sourcePill(status({ source: 'downloaded', prerelease: true }))).toEqual({
        cls: 'warn',
        key: 'settings.xrayCore.sourcePrerelease',
      });
      expect(sourcePill(status({ source: 'custom' }))).toEqual({
        cls: 'idle',
        key: 'settings.xrayCore.sourceCustom',
      });
      for (const s of ['bundled', 'downloaded', 'custom'] as const) {
        expect(typeof enValue(sourcePill(status({ source: s })).key)).toBe('string');
      }
    });
    it('status notes: custom file, below minimum, downloaded older than bundled', () => {
      expect(statusNotes(null)).toEqual([]);
      expect(statusNotes(status())).toEqual([]);
      expect(
        statusNotes(status({ source: 'custom', version: '25.12.8', belowMinimum: true }))
      ).toEqual(['custom', 'belowMinimum']);
      // App 升级后随包变新：在线安装的旧版本提示
      expect(
        statusNotes(
          status({ source: 'downloaded', version: '26.3.27', bundledVersion: '26.10.10' })
        )
      ).toEqual(['olderThanBundled']);
      expect(statusNotes(status({ source: 'downloaded', version: '26.10.10' }))).toEqual([]);
      // custom 旧于随包不算 olderThanBundled（只对在线安装的版本提示）
      expect(statusNotes(status({ source: 'custom', version: '26.2.6' }))).toEqual(['custom']);
    });
  });

  describe('progress', () => {
    it('maps phases to i18n keys (restore switching has its own text)', () => {
      const phases = [
        'downloading',
        'verifying',
        'extracting',
        'testing',
        'switching',
        'restarting',
      ] as const;
      for (const phase of phases) {
        expect(typeof enValue(phaseKey({ phase, kind: 'install' }))).toBe('string');
      }
      expect(phaseKey({ phase: 'switching', kind: 'install' })).toBe(
        'settings.xrayCore.phaseSwitching'
      );
      expect(phaseKey({ phase: 'switching', kind: 'restore' })).toBe(
        'settings.xrayCore.phaseRestoring'
      );
      expect(typeof enValue('settings.xrayCore.phaseRestoring')).toBe('string');
    });
    it('bar width follows the download percent, then stays full', () => {
      expect(progressBarPercent({ phase: 'downloading', percent: 42 })).toBe(42);
      expect(progressBarPercent({ phase: 'downloading' })).toBe(0);
      expect(progressBarPercent({ phase: 'downloading', percent: 180 })).toBe(100);
      expect(progressBarPercent({ phase: 'downloading', percent: Number.NaN })).toBe(0);
      expect(progressBarPercent({ phase: 'testing' })).toBe(100);
    });
  });

  describe('errors', () => {
    const codes: XrayInstallErrorCode[] = [
      'BUSY',
      'PROXY_BUSY',
      'CORE_BUSY',
      'INVALID_TAG',
      'NOT_FOUND',
      'RATE_LIMITED',
      'NETWORK',
      'DRAFT',
      'NO_ASSET',
      'BELOW_MINIMUM',
      'NO_HASH',
      'HASH_MISMATCH',
      'DOWNLOAD_FAILED',
      'EXTRACT_FAILED',
      'VERSION_MISMATCH',
      'CONFIG_TEST_FAILED',
      'IN_USE',
      'START_FAILED',
      'FAILED',
    ];
    it('maps every install error code to its own existing i18n key', () => {
      for (const code of codes) {
        const key = errorMessageKey(code, true);
        expect(key).toBe(`settings.xrayCore.errors.${code}`);
        expect(typeof enValue(key)).toBe('string');
      }
    });
    it('distinguishes a failed rollback and falls back to FAILED for unknown codes', () => {
      expect(errorMessageKey('START_FAILED', false)).toBe(
        'settings.xrayCore.errors.START_FAILED_NO_ROLLBACK'
      );
      expect(typeof enValue(errorMessageKey('START_FAILED', false))).toBe('string');
      expect(errorMessageKey('START_FAILED')).toBe('settings.xrayCore.errors.START_FAILED');
      expect(errorMessageKey('SOMETHING_NEW')).toBe('settings.xrayCore.errors.FAILED');
      expect(errorMessageKey(undefined)).toBe('settings.xrayCore.errors.FAILED');
      expect(errorMessageKey('toString')).toBe('settings.xrayCore.errors.FAILED');
    });
    it('list errors are RATE_LIMITED or NETWORK', () => {
      expect(listErrorCode(Object.assign(new Error('x'), { code: 'RATE_LIMITED' }))).toBe(
        'RATE_LIMITED'
      );
      expect(listErrorCode(Object.assign(new Error('x'), { code: 'NETWORK' }))).toBe('NETWORK');
      expect(listErrorCode(new Error('x'))).toBe('NETWORK');
      expect(listErrorCode(null)).toBe('NETWORK');
    });
    it('only attaches main-process detail where it adds information', () => {
      expect(errorShowsDetail('DOWNLOAD_FAILED')).toBe(true);
      expect(errorShowsDetail('START_FAILED')).toBe(true);
      expect(errorShowsDetail('HASH_MISMATCH')).toBe(false);
      expect(errorShowsDetail('BUSY')).toBe(false);
      expect(clipDetail('  short  ')).toBe('short');
      expect(clipDetail(undefined)).toBe('');
      const long = clipDetail('é'.repeat(500), 10);
      expect(Array.from(long)).toHaveLength(10);
      expect(long.endsWith('…')).toBe(true);
    });
  });

  describe('summarizeConfigTestDetail', () => {
    // 实测 Xray 26.3.27 `run -test` 失败输出（allowInsecure 已移除）
    const real = [
      'Xray 26.3.27 (Xray, Penetrates Everything.) d2758a0 (go1.26.1 linux/amd64)',
      'A unified platform for anti-censorship.',
      '2026/10/11 03:14:21.847919 [Info] infra/conf/serial: Reading config: &{Name:/home/u/.config/FlowZ/xray_config.json Format:json}',
      'Failed to start: main: failed to load config files: [/home/u/.config/FlowZ/xray_config.json] > infra/conf: Failed to build TLS config. > common/errors: The feature "allowInsecure" has been removed and migrated to "pinnedPeerCertSha256".',
      '',
    ].join('\n');
    it('drops the version banner, tagline and info logs', () => {
      const s = summarizeConfigTestDetail(real);
      expect(s.startsWith('Failed to start: main:')).toBe(true);
      expect(s).toContain('allowInsecure');
      expect(s).not.toContain('Penetrates Everything');
      expect(s).not.toContain('anti-censorship');
      expect(s).not.toContain('[Info]');
    });
    it('keeps only the last lines and handles the main-process ellipsis prefix', () => {
      const many = Array.from({ length: 10 }, (_, i) => `err ${i}`).join('\n');
      expect(summarizeConfigTestDetail(`…${many}`, 3)).toBe('err 7\nerr 8\nerr 9');
    });
    it('falls back to the raw text when everything was filtered, and to empty for no detail', () => {
      expect(summarizeConfigTestDetail('A unified platform for anti-censorship.')).toBe(
        'A unified platform for anti-censorship.'
      );
      expect(summarizeConfigTestDetail(undefined)).toBe('');
    });
  });
});
