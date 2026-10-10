/**
 * 「报告问题」预填 issue —— 纯函数，把当前运行环境拼进 GitHub 新建 issue 的 URL。
 * 无 electron / DOM 依赖，可单测。正文结构与 .github/ISSUE_TEMPLATE/bug_report.md 对齐，
 * 区别仅在「环境」段自动带值（手动走模板时该段为空待填）。
 *
 * 隐私红线：issue 是公开的 → 正文只含「环境形态」（版本 / 平台 / 内核运行态 / 当前节点走哪个内核及原因），
 * 绝不含节点地址、节点名、凭据、本机路径（Xray 状态的 path / overrideDir 带 OS 用户名）等可识别信息。结构性保证：
 *  - 节点只以 describeSelectedNodeCore 产出的闭合枚举进入正文（标签全部来自本文件的常量表）；
 *  - Xray 状态只读 available / version / running / nodes 四个字段（可直接传整份 IPC 结果）；
 *  - 其余自由文本（版本号 / 系统串）一律过 sanitizeField：去控制字符与换行、剥 Markdown 结构字符、限长。
 */
import type { ServerConfig } from '../../shared/types';
import { xrayRequirement, type XrayRequirement } from '../../shared/xray';
import { isDirectSelection } from '../../shared/direct-selection';

/**
 * 预填 URL 总长上限。GitHub 新建 issue 页对超长 query 回 414；Electron shell.openExternal 在各平台都能递交该长度
 *（VS Code 的 issue reporter 同取 7500）。正常环境下正文约 3K，此上限只兜底异常长的字段值。
 */
export const MAX_ISSUE_URL_LENGTH = 7500;

/** 单个环境字段（版本号 / 系统串）的最大字符数：超出截断并以 … 收尾。 */
export const FIELD_MAX_LENGTH = 64;

/** Xray sidecar 状态（KERNEL_XRAY_STATUS 的子集）。可直接传整份 IPC 结果：path / overrideDir / pid 不会进正文。 */
export interface BugReportXrayStatus {
  available: boolean;
  version: string | null;
  running: boolean;
  nodes: number;
}

/** 当前选中出口走哪个内核（闭合枚举，不携带任何节点字段）。 */
export type SelectedNodeCore =
  | { kind: 'none' } // 未选择节点
  | { kind: 'direct' } // 直连哨兵（DIRECT_SERVER_ID）
  | { kind: 'missing' } // selectedServerId 指向已不存在的节点
  | { kind: 'sing-box' }
  | { kind: 'xray'; reason: XrayRequirement };

export interface BugReportEnv {
  /** app.getVersion() */
  appVersion?: string;
  /** process.platform：darwin | win32 | linux */
  platform?: string;
  /** process.arch：arm64 | x64 */
  arch?: string;
  /** os.release()，如 macOS 的 24.5.0 / Windows 的 10.0.22631 */
  osVersion?: string;
  singBoxVersion?: string;
  /** UserConfig.proxyModeType：'systemProxy' | 'tun' */
  proxyModeType?: string;
  /** api.proxy.getXrayStatus()；null / 缺省 = 未取到（该行留空待填）。 */
  xray?: BugReportXrayStatus | null;
  /** describeSelectedNodeCore(config.servers, config.selectedServerId)；缺省 = 配置未加载（留空待填）。 */
  selectedNode?: SelectedNodeCore;
}

const PLATFORM_LABEL: Record<string, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
};

const PROXY_MODE_LABEL: Record<string, string> = {
  systemProxy: '系统代理',
  tun: 'TUN',
};

/** Xray 承载原因 → 中文标签（与 zh-CN servers.xrayReason* 同义）。Record 保证新增原因时编译期必须补标签。 */
const XRAY_REASON_LABEL: Record<XrayRequirement, string> = {
  'custom-xray': '自定义 Xray 出站 JSON',
  xhttp: 'XHTTP 传输',
  'vless-encryption': 'VLESS Encryption 加密',
  'vision-udp443': 'xtls-rprx-vision-udp443 流控',
  'reality-pqv': 'REALITY ML-DSA-65 后量子验证',
  'tls-pinned-cert': '证书 SHA-256 指纹',
  forced: '手动开启',
};

/** 只认常量表自有键（防 toString / constructor 之类原型键把函数源码拼进正文）。 */
function ownLabel<K extends string>(
  map: Readonly<Record<K, string>>,
  key: string
): string | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key as K] : undefined;
}

/**
 * 自由文本字段净化：控制字符 / 换行 → 空格（防伪造正文段落），剥 < > `（防 HTML 注释 / 代码块吞掉后续正文），
 * 折叠空白，超过 max 个字符截断并以 … 收尾（按码点截，不劈开代理对）。null / undefined → 空串。
 */
export function sanitizeField(value: unknown, max: number = FIELD_MAX_LENGTH): string {
  if (value === undefined || value === null) return '';
  const s = String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/[<>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(s);
  return chars.length <= max ? s : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/** process.platform + arch + os.release 拼成可读串，如「macOS arm64 (24.5.0)」。缺项自动略过。 */
export function formatSystemInfo(env: BugReportEnv): string {
  const p = sanitizeField(env.platform);
  const platform = p ? (ownLabel(PLATFORM_LABEL, p) ?? p) : '';
  const head = [platform, sanitizeField(env.arch)].filter(Boolean).join(' ');
  const osVersion = sanitizeField(env.osVersion);
  const rel = osVersion ? ` (${osVersion})` : '';
  return `${head}${rel}`.trim();
}

/** proxyModeType → 中文标签（系统代理 / TUN）；未知值原样返回（经净化），缺省空串。 */
export function formatProxyMode(env: BugReportEnv): string {
  const mode = sanitizeField(env.proxyModeType);
  if (!mode) return '';
  return ownLabel(PROXY_MODE_LABEL, mode) ?? mode;
}

/**
 * Xray sidecar 摘要，与诊断报告同形：「26.3.27（运行中，2 个节点）」/「26.3.27（未运行）」/「缺失」。
 * 只读 available / version / running / nodes；未取到状态 → 空串（留空待填）。
 */
export function formatXrayStatus(env: BugReportEnv): string {
  const x = env.xray;
  if (!x) return '';
  if (!x.available) return '缺失';
  const version = sanitizeField(x.version) || 'unknown';
  if (!x.running) return `${version}（未运行）`;
  const nodes = Number.isFinite(x.nodes) && x.nodes > 0 ? Math.floor(x.nodes) : 0;
  return `${version}（运行中，${nodes} 个节点）`;
}

/** 当前节点内核：「Xray（xhttp：XHTTP 传输）」/「sing-box」/「直连」等。标签全部来自常量表，不回显任何节点数据。 */
export function formatSelectedNodeCore(env: BugReportEnv): string {
  const n = env.selectedNode;
  if (!n) return '';
  switch (n.kind) {
    case 'none':
      return '未选择节点';
    case 'direct':
      return '直连';
    case 'missing':
      return '选中节点已不存在';
    case 'sing-box':
      return 'sing-box';
    case 'xray': {
      // 运行时若混入枚举外的 reason，只报「Xray」，不回显原值。
      const label = ownLabel(XRAY_REASON_LABEL, n.reason);
      return label ? `Xray（${n.reason}：${label}）` : 'Xray';
    }
    default:
      return '';
  }
}

/**
 * 由 app store 的 config.servers + selectedServerId 判定当前出口走哪个内核（单一真值 shared/xray#xrayRequirement）。
 * 返回闭合枚举，节点本身（名称 / 地址 / 凭据）不出此函数。
 */
export function describeSelectedNodeCore(
  servers: readonly ServerConfig[] | null | undefined,
  selectedServerId: string | null | undefined
): SelectedNodeCore {
  if (isDirectSelection(selectedServerId)) return { kind: 'direct' };
  if (!selectedServerId) return { kind: 'none' };
  const server = servers?.find((s) => s.id === selectedServerId);
  if (!server) return { kind: 'missing' };
  const reason = xrayRequirement(server);
  return reason ? { kind: 'xray', reason } : { kind: 'sing-box' };
}

/**
 * 正文精简级别（buildBugReportUrl 超长时逐级降）：
 *  0 = 完整；1 = 去掉 <!-- --> 填写提示；2 = 只留环境段 + 各段标题。
 */
type BodyLevel = 0 | 1 | 2;

const TRIMMED_NOTE =
  '<!-- 正文过长，已自动精简：请参照 .github/ISSUE_TEMPLATE/bug_report.md 补充各段 -->';

function renderBody(env: BugReportEnv, level: BodyLevel): string {
  const hint = (line: string): string[] => (level >= 1 ? [] : [line]);
  const envSection = [
    '## 环境（自动采集，请保留）',
    `- FlowZX 版本：${sanitizeField(env.appVersion)}`,
    `- 系统 + 架构：${formatSystemInfo(env)}`,
    `- sing-box 内核版本：${sanitizeField(env.singBoxVersion)}`,
    `- Xray 内核版本 + 状态：${formatXrayStatus(env)}`,
    `- 当前节点内核：${formatSelectedNodeCore(env)}`,
    `- 代理模式：${formatProxyMode(env)}`,
    '',
  ];
  if (level >= 2) {
    return [
      ...envSection,
      TRIMMED_NOTE,
      '',
      '## 问题描述',
      '',
      '## 复现步骤',
      '',
      '## 预期行为 / 实际行为',
      '',
      '## 原始日志（最关键）',
      '',
    ].join('\n');
  }
  return [
    ...envSection,
    '## 问题描述',
    '',
    '',
    '## 复现步骤',
    '1. ',
    '2. ',
    '3. ',
    '',
    '## 预期行为 / 实际行为',
    '- 预期：',
    '- 实际：',
    '',
    '## 原始日志（最关键）',
    ...hint(
      '<!-- 侧栏「日志」页，复制报错末尾方括号 [...] 内核日志前后几行贴进下方代码块；Xray 内核日志以 [xray] 开头 -->'
    ),
    ...hint(
      '<!-- 更完整：日志 →「日志与诊断」→「导出诊断报告」（密钥 / 节点地址 / 节点名已脱敏），把文件拖进本框作附件 -->'
    ),
    '',
    '```',
    '（在此粘贴日志）',
    '```',
    '',
    '## 旁证（选填，但往往是定位关键）',
    ...hint(
      '<!-- 其他客户端（v2rayN / clash 等）是否正常？是否仅特定节点 / 传输（如 XHTTP、REALITY、Argo / CDN 优选）？地址形态（优选 IP / 优选域名）？是否启用订阅？ -->'
    ),
    '',
  ].join('\n');
}

/** 生成预填的 issue 正文：环境段自动填好，其余段留空待用户补全。 */
export function buildBugReportBody(env: BugReportEnv): string {
  return renderBody(env, 0);
}

function issueUrl(base: string, body: string): string {
  const params = new URLSearchParams({ title: '[Bug] ', labels: 'bug', body });
  return `${base}/issues/new?${params.toString()}`;
}

/**
 * 生成 GitHub 新建 issue 的完整 URL：标题预填 [Bug] 、打 bug 标签、正文为 buildBugReportBody。
 * 总长超过 maxLength 时逐级精简正文（去提示 → 只留环境段），仍超长则按码点截断正文尾部，保证 URL 不超限、
 * 环境段优先保留。
 */
export function buildBugReportUrl(
  repositoryUrl: string,
  env: BugReportEnv,
  maxLength: number = MAX_ISSUE_URL_LENGTH
): string {
  const base = repositoryUrl.replace(/\/+$/, '');
  let body = '';
  for (const level of [0, 1, 2] as const) {
    body = renderBody(env, level);
    const url = issueUrl(base, body);
    if (url.length <= maxLength) return url;
  }
  // 兜底：二分找能放下的最长正文前缀（按码点，不劈开代理对）。连空正文都放不下 → 返回空正文 URL（由 base 决定）。
  const chars = Array.from(body);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (issueUrl(base, chars.slice(0, mid).join('')).length <= maxLength) lo = mid;
    else hi = mid - 1;
  }
  return issueUrl(base, chars.slice(0, lo).join(''));
}
