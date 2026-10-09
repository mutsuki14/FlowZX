/**
 * 抗封增强字段（ech / multiplex）的共享 zod 片段、默认值与 submit 映射。
 *
 * 各协议表单（vless/trojan/vmess/ss/tuic/hysteria2/anytls）此前各自重复维护这些
 * schema 片段、默认值与 submit 逻辑。此处统一抽取，行为与各表单原实现保持一致：
 *   - schema 字段名 / 校验完全相同
 *   - 默认值完全相同
 *   - 提交的 ServerConfig 形状完全相同
 *
 * 渲染层已在 anti-censor-fields.tsx 共享；本文件补齐 schema / defaults / submit 的复用。
 */
import * as z from 'zod';
import type { ServerConfig } from '@/bridge/types';
import { TLS_SPOOF_METHODS, isValidTlsSpoofMethod, type TlsSpoofMethod } from '@shared/tls-spoof';

/** ECH 字段的 zod 形状（展开进 z.object）。 */
export const echSchemaShape = {
  ech: z.boolean().optional(),
  echConfig: z.string().optional(),
};

/**
 * TLS spoof 字段的 zod 形状（P3a，展开进 z.object）。tlsSpoofMethod + tlsSpoofSni 成对非空才启用（method none→undefined）。
 * 方法仅这三个 + undefined（与 sing-box check 实证一致）；tlsSpoofSni=诱饵 SNI（须为域名、且不同于真 SNI，构建期门控）。
 */
export const tlsSpoofSchemaShape = {
  tlsSpoofMethod: z.enum(TLS_SPOOF_METHODS).optional(),
  tlsSpoofSni: z.string().optional(),
};

/** TLS spoof 字段的新建表单默认值（默认不启用）。 */
export const tlsSpoofDefaults = {
  tlsSpoofMethod: undefined as TlsSpoofMethod | undefined,
  tlsSpoofSni: '',
};

/** 从既有 serverConfig 读取 TLS spoof 默认值（加载分支）。 */
export function readTlsSpoofDefault(serverConfig: ServerConfig) {
  return {
    tlsSpoofMethod: serverConfig.tlsSettings?.spoofMethod,
    tlsSpoofSni: serverConfig.tlsSettings?.spoofSni || '',
  };
}

/**
 * 构造提交用的 TLS spoof 设置片段（注入 tlsSettings 的 spoofMethod + spoofSni）。
 * 方法为空 → 两者都 undefined（不启用）。诱饵 SNI 留空也照传——内核要求成对，但构建期会再做
 * 「非空 / 非 IP / 不同于真 SNI」门控（applyAntiCensorshipOptions），此处只做 trim 透传。
 */
export function buildTlsSpoofSettings(values: { tlsSpoofMethod?: string; tlsSpoofSni?: string }) {
  const m = values.tlsSpoofMethod;
  const valid = isValidTlsSpoofMethod(m);
  return {
    spoofMethod: valid ? m : undefined,
    spoofSni: valid ? values.tlsSpoofSni?.trim() || undefined : undefined,
  };
}

/** Multiplex 字段的 zod 形状（展开进 z.object）。 */
export const multiplexSchemaShape = {
  muxEnabled: z.boolean().optional(),
  muxProtocol: z.enum(['h2mux', 'smux', 'yamux']).optional(),
  // .or(z.literal('')) 容纳清空态哨兵 ''（数字输入清空用 '' 而非 undefined，避免 RHF Controller 回退 defaultValue
  // 把编辑态旧值自动填回，issue #294 同类）。buildMultiplexSettings 提交时 `|| undefined` 归一。
  muxMaxConnections: z.number().optional().or(z.literal('')),
  muxMinStreams: z.number().optional().or(z.literal('')),
  muxPadding: z.boolean().optional(),
};

/** ECH 字段的新建表单默认值。 */
export const echDefaults = {
  ech: false,
  echConfig: '',
};

/** Multiplex 字段的新建表单默认值。 */
export const multiplexDefaults = {
  muxEnabled: false,
  muxProtocol: 'h2mux' as const,
  muxMaxConnections: undefined,
  muxMinStreams: undefined,
  muxPadding: false,
};

/** 从既有 serverConfig 读取 ECH 默认值（加载分支）。 */
export function readEchDefault(serverConfig: ServerConfig) {
  return {
    ech: serverConfig.tlsSettings?.ech === true,
    echConfig: serverConfig.tlsSettings?.echConfig || '',
  };
}

/** 从既有 serverConfig 读取 Multiplex 默认值（加载分支）。 */
export function readMultiplexDefaults(serverConfig: ServerConfig) {
  return {
    muxEnabled: serverConfig.multiplexSettings?.enabled === true,
    muxProtocol:
      (serverConfig.multiplexSettings?.protocol as 'h2mux' | 'smux' | 'yamux') || 'h2mux',
    muxMaxConnections: serverConfig.multiplexSettings?.maxConnections,
    muxMinStreams: serverConfig.multiplexSettings?.minStreams,
    muxPadding: serverConfig.multiplexSettings?.padding === true,
  };
}

interface MultiplexValues {
  muxEnabled?: boolean;
  muxProtocol?: 'h2mux' | 'smux' | 'yamux';
  muxMaxConnections?: number | '';
  muxMinStreams?: number | '';
  muxPadding?: boolean;
  flow?: string;
}

/**
 * 构造提交用的 multiplexSettings 对象（未启用则返回 undefined）。
 * @param opts.skipVisionFlow vless 专用：flow === 'xtls-rprx-vision' 时不启用 mux。
 */
export function buildMultiplexSettings(
  values: MultiplexValues,
  opts?: { skipVisionFlow?: boolean }
) {
  const enabled = opts?.skipVisionFlow
    ? values.muxEnabled && values.flow !== 'xtls-rprx-vision'
    : values.muxEnabled;

  return enabled
    ? {
        enabled: true,
        protocol: values.muxProtocol || 'h2mux',
        // '' / 0（清空或未填）→ undefined 不下发（0 连接/流无意义）。
        maxConnections: values.muxMaxConnections || undefined,
        minStreams: values.muxMinStreams || undefined,
        padding: values.muxPadding === true,
      }
    : undefined;
}

/**
 * 传输层（ws / httpupgrade / http(H2) / grpc）字段的共享 path/Host/serviceName 读写。
 * 三表单（vless/vmess/trojan）此前各自重复构造 wsSettings/httpSettings/grpcSettings 与读取默认值。
 * 渲染层组件在 transport-fields.tsx（WsPathField/WsHostField/GrpcServiceNameField）。
 */
interface TransportValues {
  wsPath?: string;
  wsHost?: string;
  grpcServiceName?: string;
  xhttpPath?: string;
  xhttpHost?: string;
  xhttpMode?: string;
  xhttpExtra?: string;
}

/** 从既有 serverConfig 读取传输字段默认值（ws/http 共用 wsPath/wsHost 输入框；undefined=新建分支）。 */
export function readTransportDefaults(serverConfig?: ServerConfig) {
  return {
    wsPath: serverConfig?.wsSettings?.path || serverConfig?.httpSettings?.path || '',
    wsHost:
      serverConfig?.wsSettings?.headers?.['Host'] || serverConfig?.httpSettings?.host?.[0] || '',
    grpcServiceName: serverConfig?.grpcSettings?.serviceName || '',
    ...readXhttpDefaults(serverConfig),
  };
}

/**
 * 按规范化后的 network（小写真值：tcp/ws/grpc/http/httpupgrade）构造对应传输 settings；
 * 其余置 null（与各表单既有 wsSettings 三元同构）。ws 与 httpupgrade 共用 wsSettings。
 */
export function buildTransportSettings(network: string, values: TransportValues) {
  // 空 wsHost（用户清空/未设）→ 省略 Host（而非下发空 `Host:` header，后者非标准无意义）。
  // Host 为字符串、无「合法值恰为 falsy」情形，故 `values.wsHost ? … : undefined` 是正确归一化，非 falsy-zero bug。
  return {
    wsSettings:
      network === 'ws' || network === 'httpupgrade'
        ? {
            path: values.wsPath || '/',
            headers: values.wsHost ? { Host: values.wsHost } : undefined,
          }
        : null,
    httpSettings:
      network === 'http'
        ? {
            path: values.wsPath || '/',
            host: values.wsHost ? [values.wsHost] : undefined,
          }
        : null,
    grpcSettings: network === 'grpc' ? { serviceName: values.grpcServiceName?.trim() || '' } : null,
    xhttpSettings: network === 'xhttp' ? buildXhttpSettings(values) : null,
  };
}

// ── Xray（XHTTP 传输 / 强制 Xray 内核 / 证书钉扎 / Reality 扩展）——vless/vmess/trojan 表单共用 ──

/** XHTTP 模式（与 shared types XhttpMode 一致）。 */
export const XHTTP_MODES = ['auto', 'packet-up', 'stream-up', 'stream-one'] as const;

/** extra 文本框：空或合法 JSON 对象。 */
export function parseXhttpExtra(
  text: string | undefined
): Record<string, unknown> | null | 'invalid' {
  const t = (text || '').trim();
  if (!t) return null;
  try {
    const o = JSON.parse(t);
    return o && typeof o === 'object' && !Array.isArray(o)
      ? (o as Record<string, unknown>)
      : 'invalid';
  } catch {
    return 'invalid';
  }
}

/** Xray 相关字段的 zod 形状（展开进 z.object）。xhttpExtra 非法 JSON 时提交被拦（错误挂在该字段）。 */
export const xraySchemaShape = {
  xhttpPath: z.string().optional(),
  xhttpHost: z.string().optional(),
  xhttpMode: z.enum(XHTTP_MODES).optional(),
  xhttpExtra: z
    .string()
    .optional()
    .refine((v) => parseXhttpExtra(v) !== 'invalid', { message: 'invalid-json' }),
  useXrayCore: z.boolean().optional(),
  tlsPinnedSha256: z.string().optional(),
};

/** 新建表单的 Xray 默认值。 */
export const xrayDefaults = {
  useXrayCore: false,
  tlsPinnedSha256: '',
};

/** 从既有 serverConfig 读取 XHTTP 字段默认值（readTransportDefaults 内聚调用）。 */
export function readXhttpDefaults(serverConfig?: ServerConfig) {
  const x = serverConfig?.xhttpSettings;
  return {
    xhttpPath: x?.path || '',
    xhttpHost: x?.host || '',
    xhttpMode: (x?.mode || 'auto') as (typeof XHTTP_MODES)[number],
    xhttpExtra: x?.extra && Object.keys(x.extra).length > 0 ? JSON.stringify(x.extra, null, 2) : '',
  };
}

/** 从既有 serverConfig 读取 Xray 开关 / 证书钉扎默认值。 */
export function readXrayDefaults(serverConfig: ServerConfig) {
  return {
    useXrayCore: serverConfig.useXrayCore === true,
    tlsPinnedSha256: serverConfig.tlsSettings?.pinnedPeerCertSha256 || '',
  };
}

/** XHTTP 提交映射（mode=auto 仍写入，便于往返；builder 侧不下发 auto）。 */
export function buildXhttpSettings(values: TransportValues) {
  const extra = parseXhttpExtra(values.xhttpExtra);
  return {
    path: values.xhttpPath?.trim() || '/',
    host: values.xhttpHost?.trim() || undefined,
    mode: (values.xhttpMode as (typeof XHTTP_MODES)[number] | undefined) || undefined,
    extra: extra && extra !== 'invalid' ? extra : undefined,
  };
}
