import * as fs from 'fs';
import * as path from 'path';
import {
  formatSystemInfo,
  formatProxyMode,
  formatRoutingMode,
  formatXrayStatus,
  formatSelectedNodeCore,
  describeSelectedNodeCore,
  sanitizeField,
  buildBugReportBody,
  buildBugReportUrl,
  MAX_ISSUE_URL_LENGTH,
  FIELD_MAX_LENGTH,
  type BugReportEnv,
  type SelectedNodeCore,
} from '../issue-report';
import type { ServerConfig } from '../../../shared/types';
import { DIRECT_SERVER_ID } from '../../../shared/direct-selection';

/** 环境段字段标签（顺序即正文 / 模板顺序）。 */
const ENV_LABELS = [
  'FlowZX 版本',
  '系统 + 架构',
  'sing-box 内核版本',
  'Xray 内核版本 + 状态',
  '当前节点内核',
  '代理模式',
  '分流策略',
];

/** 解出 URL 里的 body（URLSearchParams 已还原 + / %XX）。 */
const bodyOf = (url: string): string => new URLSearchParams(url.split('?')[1]).get('body') ?? '';

/** 每个值都带可识别哨兵串：正文里出现任何一个即视为泄露。 */
const SENTINELS = {
  name: 'SENTINEL-NODE-NAME-家里云',
  address: 'sentinel-host.example.org',
  uuid: '11111111-2222-3333-4444-555555555555',
  password: 'SENTINEL_PASSWORD_hunter2',
  sni: 'sentinel-sni.example.net',
  path: '/sentinel-xhttp-path',
  host: 'sentinel-cdn-host.example.com',
  publicKey: 'SENTINELpublicKeyAAAAAAAAAAAAAAAAAAAAAAAAA',
  shortId: 'deadbeefcafe',
  pqv: 'SENTINELmldsa65VerifyValue',
  pin: 'SENTINELpinnedsha256',
  encryption: 'mlkem768x25519plus.native.0rtt.SENTINELENCKEY',
  subscriptionId: 'sub-sentinel-id',
  id: 'node-id-sentinel-42',
};

const xhttpVlessNode: ServerConfig = {
  id: SENTINELS.id,
  name: SENTINELS.name,
  protocol: 'vless',
  address: SENTINELS.address,
  port: 44321,
  uuid: SENTINELS.uuid,
  encryption: SENTINELS.encryption,
  password: SENTINELS.password,
  subscriptionId: SENTINELS.subscriptionId,
  network: 'xhttp',
  security: 'reality',
  tlsSettings: { serverName: SENTINELS.sni, pinnedPeerCertSha256: SENTINELS.pin },
  realitySettings: {
    publicKey: SENTINELS.publicKey,
    shortId: SENTINELS.shortId,
    mldsa65Verify: SENTINELS.pqv,
  },
  xhttpSettings: { path: SENTINELS.path, host: SENTINELS.host, mode: 'auto' },
};

const plainVlessNode: ServerConfig = {
  id: 'plain',
  name: 'plain node',
  protocol: 'vless',
  address: 'plain.example.org',
  port: 443,
  uuid: SENTINELS.uuid,
  network: 'tcp',
  security: 'reality',
  realitySettings: { publicKey: SENTINELS.publicKey },
};

/** sing-box 原生节点（Hysteria2），可挂前置代理。 */
const hy2Node = (id: string, detour?: string): ServerConfig => ({
  id,
  name: `hy2 ${id}`,
  protocol: 'hysteria2',
  address: `${id}.hy2.example.org`,
  port: 8443,
  password: SENTINELS.password,
  ...(detour ? { detour } : {}),
});

/** 完整 IPC 结果（含 path / overrideDir / pid：带 OS 用户名，绝不能进正文）。 */
const fullXrayStatus = {
  available: true,
  version: '26.3.27',
  path: '/home/alice-sentinel/.config/FlowZ/xray_core/xray',
  overrideDir: 'C:\\Users\\alice-sentinel\\AppData\\Roaming\\FlowZ\\xray_core',
  running: true,
  pid: 424242,
  nodes: 3,
};

const fullEnv = (overrides: Partial<BugReportEnv> = {}): BugReportEnv => ({
  appVersion: '4.4.1',
  platform: 'win32',
  arch: 'x64',
  osVersion: '10.0.22631',
  singBoxVersion: '1.14.0-rc.1',
  proxyModeType: 'tun',
  routingMode: 'smart',
  xray: fullXrayStatus,
  selectedNode: describeSelectedNodeCore([plainVlessNode, xhttpVlessNode], SENTINELS.id),
  ...overrides,
});

describe('issue-report', () => {
  describe('formatSystemInfo', () => {
    it('maps platform to friendly name + arch + release', () => {
      expect(formatSystemInfo({ platform: 'darwin', arch: 'arm64', osVersion: '24.5.0' })).toBe(
        'macOS arm64 (24.5.0)'
      );
      expect(formatSystemInfo({ platform: 'win32', arch: 'x64', osVersion: '10.0.22631' })).toBe(
        'Windows x64 (10.0.22631)'
      );
    });

    it('omits missing parts and passes through unknown platform', () => {
      expect(formatSystemInfo({ platform: 'win32', arch: 'x64' })).toBe('Windows x64');
      expect(formatSystemInfo({ platform: 'freebsd', arch: 'x64' })).toBe('freebsd x64');
      expect(formatSystemInfo({})).toBe('');
    });
  });

  describe('formatProxyMode', () => {
    it('maps known modes to Chinese labels', () => {
      expect(formatProxyMode({ proxyModeType: 'systemProxy' })).toBe('系统代理');
      expect(formatProxyMode({ proxyModeType: 'tun' })).toBe('TUN');
      expect(formatProxyMode({ proxyModeType: 'manual' })).toBe('仅本地代理');
    });
    it('returns empty for missing and passes through unknown', () => {
      expect(formatProxyMode({})).toBe('');
      expect(formatProxyMode({ proxyModeType: 'mixed' })).toBe('mixed');
    });
    it('does not resolve prototype keys to functions', () => {
      expect(formatProxyMode({ proxyModeType: 'constructor' })).toBe('constructor');
      expect(formatSystemInfo({ platform: 'toString', arch: 'x64' })).toBe('toString x64');
    });
  });

  describe('formatRoutingMode', () => {
    it('maps every routing strategy to its Chinese label', () => {
      expect(formatRoutingMode({ routingMode: 'smart' })).toBe('智能分流');
      expect(formatRoutingMode({ routingMode: 'global' })).toBe('全局');
      expect(formatRoutingMode({ routingMode: 'direct' })).toBe('直连');
    });
    it('returns empty for missing, passes through unknown (sanitized), ignores prototype keys', () => {
      expect(formatRoutingMode({})).toBe('');
      expect(formatRoutingMode({ routingMode: 'rule\n## 伪造' })).toBe('rule ## 伪造');
      expect(formatRoutingMode({ routingMode: 'hasOwnProperty' })).toBe('hasOwnProperty');
    });
  });

  describe('sanitizeField', () => {
    it('collapses newlines / control chars so a value cannot forge body lines', () => {
      expect(sanitizeField('1.0\n## 问题描述\r\n- 伪造')).toBe('1.0 ## 问题描述 - 伪造');
      expect(sanitizeField('a\u0000b\u2028c\td')).toBe('a b c d');
    });
    it('strips characters that could open an HTML comment / code span', () => {
      expect(sanitizeField('1.2.3<!-- hide')).toBe('1.2.3!-- hide');
      expect(sanitizeField('`x`')).toBe('x');
    });
    it('caps length with an ellipsis without splitting surrogate pairs', () => {
      const long = '😀'.repeat(FIELD_MAX_LENGTH + 10);
      const out = sanitizeField(long);
      expect(Array.from(out)).toHaveLength(FIELD_MAX_LENGTH);
      expect(out.endsWith('…')).toBe(true);
      expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(sanitizeField('x'.repeat(FIELD_MAX_LENGTH))).toBe('x'.repeat(FIELD_MAX_LENGTH));
    });
    it('maps null / undefined to empty', () => {
      expect(sanitizeField(undefined)).toBe('');
      expect(sanitizeField(null)).toBe('');
    });
  });

  describe('formatXrayStatus', () => {
    it('summarises running / idle / missing like the diagnostic report', () => {
      expect(formatXrayStatus({ xray: fullXrayStatus })).toBe('26.3.27（运行中，3 个节点）');
      expect(formatXrayStatus({ xray: { ...fullXrayStatus, running: false, nodes: 0 } })).toBe(
        '26.3.27（未运行）'
      );
      expect(
        formatXrayStatus({ xray: { available: false, version: null, running: false, nodes: 0 } })
      ).toBe('缺失');
    });
    it('falls back to unknown version and sane node counts', () => {
      expect(formatXrayStatus({ xray: { ...fullXrayStatus, version: null } })).toBe(
        'unknown（运行中，3 个节点）'
      );
      expect(formatXrayStatus({ xray: { ...fullXrayStatus, nodes: Number.NaN } })).toBe(
        '26.3.27（运行中，0 个节点）'
      );
      expect(formatXrayStatus({ xray: { ...fullXrayStatus, nodes: -2 } })).toBe(
        '26.3.27（运行中，0 个节点）'
      );
    });
    it('is empty when the status could not be fetched', () => {
      expect(formatXrayStatus({})).toBe('');
      expect(formatXrayStatus({ xray: null })).toBe('');
    });
  });

  describe('describeSelectedNodeCore', () => {
    it('reports Xray with the xrayRequirement reason for the selected node', () => {
      expect(describeSelectedNodeCore([plainVlessNode, xhttpVlessNode], SENTINELS.id)).toEqual({
        kind: 'xray',
        reason: 'xhttp',
      });
      const encNode: ServerConfig = { ...plainVlessNode, encryption: SENTINELS.encryption };
      expect(describeSelectedNodeCore([encNode], 'plain')).toEqual({
        kind: 'xray',
        reason: 'vless-encryption',
      });
      const forced: ServerConfig = { ...plainVlessNode, useXrayCore: true };
      expect(describeSelectedNodeCore([forced], 'plain')).toEqual({
        kind: 'xray',
        reason: 'forced',
      });
      const custom: ServerConfig = {
        ...plainVlessNode,
        protocol: 'custom',
        customSettings: { outbound: { protocol: 'freedom' }, engine: 'xray' },
      };
      expect(describeSelectedNodeCore([custom], 'plain')).toEqual({
        kind: 'xray',
        reason: 'custom-xray',
      });
    });
    it('reports sing-box / direct / none / missing', () => {
      expect(describeSelectedNodeCore([plainVlessNode], 'plain')).toEqual({ kind: 'sing-box' });
      expect(describeSelectedNodeCore([plainVlessNode], DIRECT_SERVER_ID)).toEqual({
        kind: 'direct',
      });
      expect(describeSelectedNodeCore([plainVlessNode], undefined)).toEqual({ kind: 'none' });
      expect(describeSelectedNodeCore([plainVlessNode], null)).toEqual({ kind: 'none' });
      expect(describeSelectedNodeCore([plainVlessNode], 'gone')).toEqual({ kind: 'missing' });
      expect(describeSelectedNodeCore(undefined, 'gone')).toEqual({ kind: 'missing' });
    });
    it('flags a sing-box node whose upstream (detour) chain runs on Xray', () => {
      // 直接前置是 Xray 节点
      const viaXray = hy2Node('a', SENTINELS.id);
      expect(describeSelectedNodeCore([viaXray, xhttpVlessNode], 'a')).toEqual({
        kind: 'sing-box',
        detourXray: 'xhttp',
      });
      // 多级链：a → b(sing-box) → Xray 节点，取链上最近的 Xray 节点
      const servers = [hy2Node('a', 'b'), hy2Node('b', SENTINELS.id), xhttpVlessNode];
      expect(describeSelectedNodeCore(servers, 'a')).toEqual({
        kind: 'sing-box',
        detourXray: 'xhttp',
      });
    });
    it('keeps plain sing-box for native / dangling / cyclic chains, and Xray wins for the node itself', () => {
      expect(describeSelectedNodeCore([hy2Node('a', 'b'), hy2Node('b')], 'a')).toEqual({
        kind: 'sing-box',
      });
      expect(describeSelectedNodeCore([hy2Node('a', 'gone')], 'a')).toEqual({ kind: 'sing-box' });
      // 成环（运行时整条链被忽略）→ 即便环上有 Xray 节点也不报
      const cyclicXray: ServerConfig = { ...xhttpVlessNode, detour: 'a' };
      expect(describeSelectedNodeCore([hy2Node('a', SENTINELS.id), cyclicXray], 'a')).toEqual({
        kind: 'sing-box',
      });
      expect(describeSelectedNodeCore([hy2Node('a', 'a')], 'a')).toEqual({ kind: 'sing-box' });
      // 选中节点本身走 Xray → 报其自身原因（前置是什么不影响）
      const xrayWithDetour: ServerConfig = { ...xhttpVlessNode, detour: 'b' };
      expect(describeSelectedNodeCore([xrayWithDetour, hy2Node('b')], SENTINELS.id)).toEqual({
        kind: 'xray',
        reason: 'xhttp',
      });
    });
  });

  describe('formatSelectedNodeCore', () => {
    it('labels every kind from constants', () => {
      expect(formatSelectedNodeCore({ selectedNode: { kind: 'xray', reason: 'xhttp' } })).toBe(
        'Xray（xhttp：XHTTP 传输）'
      );
      expect(
        formatSelectedNodeCore({ selectedNode: { kind: 'xray', reason: 'tls-pinned-cert' } })
      ).toBe('Xray（tls-pinned-cert：证书 SHA-256 指纹）');
      expect(formatSelectedNodeCore({ selectedNode: { kind: 'sing-box' } })).toBe('sing-box');
      expect(
        formatSelectedNodeCore({ selectedNode: { kind: 'sing-box', detourXray: 'custom-xray' } })
      ).toBe('sing-box（前置代理走 Xray，custom-xray：自定义 Xray 出站 JSON）');
      expect(formatSelectedNodeCore({ selectedNode: { kind: 'direct' } })).toBe('直连');
      expect(formatSelectedNodeCore({ selectedNode: { kind: 'none' } })).toBe('未选择节点');
      expect(formatSelectedNodeCore({ selectedNode: { kind: 'missing' } })).toBe(
        '选中节点已不存在'
      );
      expect(formatSelectedNodeCore({})).toBe('');
    });
    it('never echoes an out-of-enum reason or kind', () => {
      const bogusReason = {
        kind: 'xray',
        reason: SENTINELS.address,
      } as unknown as SelectedNodeCore;
      expect(formatSelectedNodeCore({ selectedNode: bogusReason })).toBe('Xray');
      const proto = { kind: 'xray', reason: 'toString' } as unknown as SelectedNodeCore;
      expect(formatSelectedNodeCore({ selectedNode: proto })).toBe('Xray');
      const bogusKind = { kind: SENTINELS.name } as unknown as SelectedNodeCore;
      expect(formatSelectedNodeCore({ selectedNode: bogusKind })).toBe('');
      const bogusDetour = {
        kind: 'sing-box',
        detourXray: SENTINELS.address,
      } as unknown as SelectedNodeCore;
      expect(formatSelectedNodeCore({ selectedNode: bogusDetour })).toBe(
        'sing-box（前置代理走 Xray）'
      );
    });
  });

  describe('buildBugReportBody', () => {
    it('fills env values and keeps the section scaffold', () => {
      const body = buildBugReportBody({
        appVersion: '4.0.1',
        platform: 'darwin',
        arch: 'arm64',
        osVersion: '24.5.0',
        singBoxVersion: '1.10.0',
        proxyModeType: 'tun',
      });
      expect(body).toContain('- FlowZX 版本：4.0.1');
      expect(body).toContain('- 系统 + 架构：macOS arm64 (24.5.0)');
      expect(body).toContain('- sing-box 内核版本：1.10.0');
      expect(body).toContain('- 代理模式：TUN');
      expect(body).toContain('- 分流策略：\n');
      expect(body).toContain('## 问题描述');
      expect(body).toContain('## 原始日志（最关键）');
      expect(body).toContain('## 旁证（选填，但往往是定位关键）');
    });

    it('fills the Xray status and selected-node core lines', () => {
      const body = buildBugReportBody(fullEnv());
      expect(body).toContain('- Xray 内核版本 + 状态：26.3.27（运行中，3 个节点）');
      expect(body).toContain('- 当前节点内核：Xray（xhttp：XHTTP 传输）');
      expect(body).toContain('- 代理模式：TUN');
      expect(body).toContain('- 分流策略：智能分流');
      // 环境段顺序与 .github/ISSUE_TEMPLATE/bug_report.md 一致
      const order = ENV_LABELS.map((k) => body.indexOf(`- ${k}：`));
      expect(order.every((i) => i >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      // 指向诊断报告，并提醒日志仍可能含访问过的域名 / 订阅服务器域名（未脱敏部分）
      expect(body).toContain('导出诊断报告');
      expect(body).toContain('其它域名');
      expect(body).toContain('订阅服务器域名');
    });

    it('tolerates fully missing env (manual-fill placeholders)', () => {
      const body = buildBugReportBody({});
      expect(body).toContain('- FlowZX 版本：\n');
      expect(body).toContain('- 系统 + 架构：\n');
      expect(body).toContain('- Xray 内核版本 + 状态：\n');
      expect(body).toContain('- 当前节点内核：\n');
      expect(body).toContain('- 代理模式：\n');
      expect(body).toContain('- 分流策略：\n');
    });

    it('keeps the env field labels in sync with the issue template', () => {
      const tpl = fs.readFileSync(
        path.join(__dirname, '../../../../.github/ISSUE_TEMPLATE/bug_report.md'),
        'utf-8'
      );
      for (const label of ENV_LABELS) {
        expect(tpl).toContain(`- ${label}`);
      }
      // 模板的可选值提示覆盖每个枚举值的标签（与预填正文同词）
      const modeLine = tpl.split('\n').find((l) => l.startsWith('- 代理模式')) ?? '';
      for (const m of ['systemProxy', 'tun', 'manual'])
        expect(modeLine).toContain(formatProxyMode({ proxyModeType: m }));
      const routingLine = tpl.split('\n').find((l) => l.startsWith('- 分流策略')) ?? '';
      for (const m of ['smart', 'global', 'direct'])
        expect(routingLine).toContain(formatRoutingMode({ routingMode: m }));
      // Xray 原因在角标悬停提示里（自定义 Xray JSON 等节点没有「使用 Xray 内核」开关）
      expect(tpl).toContain('悬停角标');
      for (const heading of [
        '## 问题描述',
        '## 复现步骤',
        '## 预期行为 / 实际行为',
        '## 原始日志（最关键）',
        '## 旁证（选填，但往往是定位关键）',
      ]) {
        expect(tpl).toContain(heading);
        expect(buildBugReportBody({})).toContain(heading);
      }
      expect(tpl).toContain('导出诊断报告');
      // 隐私提醒不夸大脱敏范围
      expect(tpl).toContain('其它域名');
      expect(tpl).toContain('订阅服务器域名');
    });
  });

  describe('no-PII guarantee', () => {
    it('never leaks node name / address / credentials / ids / local paths into the URL', () => {
      const url = buildBugReportUrl('https://github.com/mutsuki14/FlowZX', fullEnv());
      const decoded = bodyOf(url);
      for (const v of [
        ...Object.values(SENTINELS),
        'alice-sentinel',
        fullXrayStatus.path,
        fullXrayStatus.overrideDir,
        '424242',
        '44321',
        'plain.example.org',
        'plain node',
      ]) {
        expect(decoded).not.toContain(v);
        expect(url).not.toContain(encodeURIComponent(v));
      }
      // 只有 Xray 判定结论进正文
      expect(decoded).toContain('- 当前节点内核：Xray（xhttp：XHTTP 传输）');
    });

    it('never leaks the upstream (detour) node of a sing-box selection', () => {
      const selected = hy2Node('hop', SENTINELS.id);
      const url = buildBugReportUrl(
        'https://github.com/mutsuki14/FlowZX',
        fullEnv({ selectedNode: describeSelectedNodeCore([selected, xhttpVlessNode], 'hop') })
      );
      const decoded = bodyOf(url);
      for (const v of [...Object.values(SENTINELS), 'hop.hy2.example.org', 'hy2 hop', '8443']) {
        expect(decoded).not.toContain(v);
      }
      expect(decoded).toContain('- 当前节点内核：sing-box（前置代理走 Xray，xhttp：XHTTP 传输）');
    });

    it('only the four whitelisted Xray status fields are read', () => {
      const spy = jest.fn();
      const status = new Proxy(fullXrayStatus, {
        get(target, prop, receiver) {
          spy(prop);
          return Reflect.get(target, prop, receiver);
        },
      });
      buildBugReportUrl('https://github.com/mutsuki14/FlowZX', fullEnv({ xray: status }));
      const read = new Set(spy.mock.calls.map((c) => c[0]));
      for (const forbidden of ['path', 'overrideDir', 'pid'])
        expect(read.has(forbidden)).toBe(false);
    });
  });

  describe('buildBugReportUrl', () => {
    it('builds a new-issue URL with title/labels/body and trims trailing slashes', () => {
      const url = buildBugReportUrl('https://github.com/mutsuki14/FlowZX/', {
        appVersion: '4.0.1',
      });
      expect(url.startsWith('https://github.com/mutsuki14/FlowZX/issues/new?')).toBe(true);
      const qs = new URLSearchParams(url.split('?')[1]);
      expect(qs.get('title')).toBe('[Bug] ');
      expect(qs.get('labels')).toBe('bug');
      expect(qs.get('body')).toContain('- FlowZX 版本：4.0.1');
    });

    it('a realistic full report fits well within the URL limit untrimmed', () => {
      const url = buildBugReportUrl('https://github.com/mutsuki14/FlowZX', fullEnv());
      expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL_LENGTH);
      expect(bodyOf(url)).toBe(buildBugReportBody(fullEnv()));
    });

    it('even maximal field values stay within the default limit', () => {
      const huge = 'Ω'.repeat(5000);
      const env = fullEnv({
        appVersion: huge,
        platform: huge,
        arch: huge,
        osVersion: huge,
        singBoxVersion: huge,
        proxyModeType: huge,
        routingMode: huge,
        xray: { ...fullXrayStatus, version: huge, nodes: 1e12 },
      });
      const url = buildBugReportUrl('https://github.com/mutsuki14/FlowZX', env);
      expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL_LENGTH);
      expect(bodyOf(url)).not.toContain('Ω'.repeat(FIELD_MAX_LENGTH));
    });

    it('degrades step by step under a tight limit, keeping the env section first', () => {
      const base = 'https://github.com/mutsuki14/FlowZX';
      const env = fullEnv();
      const full = buildBugReportUrl(base, env, 100_000);
      const fullBody = bodyOf(full);
      expect(fullBody).toContain('<!--');

      // 1) 去掉填写提示
      const noHints = buildBugReportUrl(base, env, full.length - 1);
      expect(noHints.length).toBeLessThan(full.length);
      const noHintsBody = bodyOf(noHints);
      expect(noHintsBody).not.toContain('导出诊断报告');
      expect(noHintsBody).not.toContain('其它域名');
      expect(noHintsBody).toContain('- 分流策略：智能分流');
      expect(noHintsBody).toContain('## 旁证（选填，但往往是定位关键）');
      expect(noHintsBody).toContain('- 当前节点内核：Xray（xhttp：XHTTP 传输）');

      // 2) 只留环境段 + 各段标题 + 精简提示
      const envOnly = buildBugReportUrl(base, env, noHints.length - 1);
      const envOnlyBody = bodyOf(envOnly);
      expect(envOnly.length).toBeLessThan(noHints.length);
      expect(envOnlyBody).toContain('正文过长，已自动精简');
      expect(envOnlyBody).toContain('- Xray 内核版本 + 状态：26.3.27（运行中，3 个节点）');
      expect(envOnlyBody).toContain('- 分流策略：智能分流');
      expect(envOnlyBody).not.toContain('（在此粘贴日志）');

      // 3) 硬截断：正文为精简版的前缀，URL 不超限
      const limit = envOnly.length - 200;
      const cut = buildBugReportUrl(base, env, limit);
      expect(cut.length).toBeLessThanOrEqual(limit);
      const cutBody = bodyOf(cut);
      expect(cutBody.length).toBeGreaterThan(0);
      expect(envOnlyBody.startsWith(cutBody)).toBe(true);
      expect(cutBody.startsWith('## 环境（自动采集，请保留）')).toBe(true);
    });

    it('never exceeds the limit for any budget (monotone, surrogate-safe)', () => {
      const base = 'https://github.com/mutsuki14/FlowZX';
      const env = fullEnv({ osVersion: '😀'.repeat(40) });
      const emptyLen = buildBugReportUrl(base, {}, 0).length;
      for (let limit = emptyLen; limit < 3200; limit += 37) {
        const url = buildBugReportUrl(base, env, limit);
        expect(url.length).toBeLessThanOrEqual(limit);
        // 解码成功即说明未劈开代理对（劈开会产出孤立代理 → URLSearchParams 编码为 %EF%BF%BD）
        expect(url).not.toContain('%EF%BF%BD');
      }
    });
  });
});
