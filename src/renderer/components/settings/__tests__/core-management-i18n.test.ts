/**
 * 内核管理卡（core-management-card.tsx）的 i18n 护栏：卡片字面量键 + singbox-version-logic 映射出的键都真实存在于
 * en-US（其余 4 个 locale 由 locale-parity.test.ts 保证与 en-US 同键同占位符），且卡片传入的插值变量覆盖每个键的
 * 占位符（漏传变量时 i18next 会把 `{{latest}}` 原样显示给用户，tsc / parity 都拦不住）。
 *
 * 另守「报告问题 / 诊断报告」的简短标注（shared/singbox-release#singboxChannelLabels，中文常量）与 zh-CN 徽章同词。
 */
import * as fs from 'fs';
import * as path from 'path';
import enUS from '../../../i18n/locales/en-US.json';
import zhCN from '../../../i18n/locales/zh-CN.json';
import { singboxChannelLabels } from '../../../../shared/singbox-release';
import {
  SINGBOX_INSTALL_ERROR_CODES,
  SINGBOX_INSTALL_PHASES,
  channelPill,
  confirmReasonKey,
  errorMessageKey,
  phaseKey,
  type SingboxConfirmReason,
} from '../singbox-version-logic';

type Json = { [key: string]: unknown };

function lookup(root: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (acc, seg) => (acc !== null && typeof acc === 'object' ? (acc as Json)[seg] : undefined),
      root
    );
}

const en = (key: string): unknown => lookup(enUS, key);

/** 文案里的 {{var}} 占位符集合。 */
function placeholders(key: string): string[] {
  const v = en(key);
  if (typeof v !== 'string') return [];
  return [...v.matchAll(/\{\{\s*([\w.-]+)/g)].map((m) => m[1]);
}

const CARD_SRC = fs.readFileSync(path.join(__dirname, '..', 'core-management-card.tsx'), 'utf-8');

/** 卡片里 t('<字面量键>' …) 的全部键。 */
const literalKeys = [...CARD_SRC.matchAll(/\bt\(\s*'([A-Za-z0-9_.]+)'/g)].map((m) => m[1]);

const REASONS: SingboxConfirmReason[] = [
  'prerelease',
  'crossBand',
  'downgrade',
  'knownBad',
  'fork',
  'staged',
  'autoUpdate',
  'restart',
];

describe('core-management-card i18n', () => {
  it('every literal key the card passes to t() exists in en-US', () => {
    expect(literalKeys.length).toBeGreaterThan(80);
    const missing = literalKeys.filter((k) => typeof en(k) !== 'string');
    expect(missing).toEqual([]);
  });

  it('the picker keys added for the version selection are used by the card', () => {
    for (const k of [
      'settings.coreManagement.includePrerelease',
      'settings.coreManagement.selectVersion',
      'settings.coreManagement.selectVersionDesc',
      'settings.coreManagement.pinVersion',
      'settings.coreManagement.pinnedNote',
      'settings.coreManagement.unpin',
      'settings.coreManagement.restoreBundled',
      'settings.coreManagement.isCurrent',
      'settings.coreManagement.refreshList',
      'settings.coreManagement.optionKnownBad',
    ]) {
      expect(literalKeys).toContain(k);
    }
    // 被 versionDesc 取代的旧键不再使用（已从 5 个 locale 删除）
    expect(CARD_SRC).not.toContain('coreManagement.sourceDesc');
    expect(en('settings.coreManagement.sourceDesc')).toBeUndefined();
  });

  it('maps every install error code (and the no-rollback variant) to an existing key', () => {
    for (const code of SINGBOX_INSTALL_ERROR_CODES) {
      expect(typeof en(errorMessageKey(code))).toBe('string');
    }
    expect(typeof en(errorMessageKey('START_FAILED', false))).toBe('string');
    expect(typeof en(errorMessageKey('RATE_LIMITED'))).toBe('string');
    expect(typeof en(errorMessageKey('NETWORK'))).toBe('string');
  });

  it('error texts only use the {{bundled}} variable the card passes', () => {
    const codes = [...SINGBOX_INSTALL_ERROR_CODES, 'START_FAILED_NO_ROLLBACK'];
    for (const code of codes) {
      for (const p of placeholders(`settings.coreManagement.errors.${code}`)) {
        expect(['bundled']).toContain(p);
      }
    }
    expect(placeholders('settings.coreManagement.errors.BELOW_MINIMUM')).toEqual(['bundled']);
  });

  it('maps every progress phase (install and reset) to an existing key that only uses {{tag}}', () => {
    for (const phase of SINGBOX_INSTALL_PHASES) {
      for (const kind of ['install', 'reset'] as const) {
        const key = phaseKey({ phase, kind });
        expect(typeof en(key)).toBe('string');
        for (const p of placeholders(key)) expect(p).toBe('tag');
      }
    }
    expect(phaseKey({ phase: 'switching', kind: 'reset' })).toBe(
      'settings.coreManagement.phaseRestoring'
    );
  });

  it('maps every confirm reason (install and restore wording) to an existing key whose variables the card provides', () => {
    // 卡片的 reasonVars 键（见 core-management-card.tsx）
    expect(CARD_SRC).toMatch(
      /const reasonVars = \{\s*version:[^}]*bundled:[^}]*current:[^}]*staged:[^}]*latest:/
    );
    const provided = ['version', 'bundled', 'current', 'staged', 'latest'];
    for (const r of REASONS) {
      for (const action of ['install', 'restore'] as const) {
        const key = confirmReasonKey(r, action);
        expect(typeof en(key)).toBe('string');
        for (const p of placeholders(key)) expect(provided).toContain(p);
      }
    }
    expect(placeholders('settings.coreManagement.confirmAutoUpdate')).toEqual(['latest']);
    expect(placeholders('settings.coreManagement.confirmStaged')).toEqual(['staged']);
    expect(placeholders('settings.coreManagement.confirmForkReset')).toEqual(['current']);
  });

  it('channel pills resolve to existing keys', () => {
    const base = { build: 'official' as const, bundledVersion: '1.14.0-rc.1' };
    const bundled = channelPill({ ...base, currentVersion: '1.14.0-rc.1' });
    const pre = channelPill({ ...base, currentVersion: '1.15.0-alpha.12' });
    expect(bundled && typeof en(bundled.key)).toBe('string');
    expect(pre && typeof en(pre.key)).toBe('string');
  });

  it('report labels (issue report / diagnostics) use the same words as the zh-CN pills', () => {
    const cm = (zhCN as Json).settings as Json;
    const zh = cm.coreManagement as Json;
    expect(singboxChannelLabels('1.14.0-rc.1', { bundledVersion: '1.14.0-rc.1' })).toEqual([
      zh.channelBundled,
    ]);
    expect(singboxChannelLabels('1.15.0-alpha.12', { bundledVersion: '1.14.0-rc.1' })).toEqual([
      zh.channelPrerelease,
    ]);
    expect(singboxChannelLabels('1.14.3', { build: 'fork' })).toEqual([zh.sourceFork]);
    // 「已固定」与固定说明同词
    expect(String(zh.pinnedNote)).toContain(
      singboxChannelLabels('1.14.3', { pinnedVersion: '1.14.3' })[0]
    );
  });
});
