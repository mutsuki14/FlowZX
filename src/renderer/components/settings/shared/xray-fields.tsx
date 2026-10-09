/**
 * Xray 相关字段的共享渲染组件（Conduit `.nd-fld` / `.nd-swrow` 版）——vless/vmess/trojan 表单共用：
 *   XhttpFields        XHTTP 传输（path / host / mode / extra JSON）
 *   XrayCoreField      「使用 Xray 内核」开关 + 当前节点内核判定提示（单一真值 shared/xray#xrayRequirement）
 *   PinnedCertField    证书 SHA256 指纹（Xray 26 移除 allowInsecure 后的自签证书方案）
 *   RealityXrayFields  Reality 的 Xray 扩展（spiderX / ML-DSA-65 验证公钥）
 * 约定字段名见 field-schemas.ts 的 xraySchemaShape。
 */
import type { Control } from 'react-hook-form';
import { Cpu } from 'lucide-react';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FormField, FormMessage } from '@/components/ui/form';
import type { XrayRequirement } from '@shared/xray';
import { InfoTooltip } from './info-tooltip';
import { FieldGrid, FieldSpan } from './form-layout';
import { SwitchField } from './switch-field';
import { XHTTP_MODES } from './field-schemas';

type AnyControl = Control<any>;
type TFn = (key: string, fallback?: any) => string;

/** 内核判定原因 → 本地化短语。 */
export function xrayReasonLabel(reason: XrayRequirement, t: TFn): string {
  switch (reason) {
    case 'xhttp':
      return t('servers.xrayReasonXhttp', 'XHTTP transport');
    case 'vless-encryption':
      return t('servers.xrayReasonEncryption', 'VLESS Encryption');
    case 'vision-udp443':
      return t('servers.xrayReasonVisionUdp443', 'xtls-rprx-vision-udp443 flow');
    case 'reality-pqv':
      return t('servers.xrayReasonPqv', 'REALITY ML-DSA-65 verification');
    case 'tls-pinned-cert':
      return t('servers.xrayReasonPinnedCert', 'certificate SHA-256 pin');
    case 'custom-xray':
      return t('servers.xrayReasonCustom', 'custom Xray outbound JSON');
    case 'forced':
    default:
      return t('servers.xrayReasonForced', 'manually enabled');
  }
}

// 内核判定 / 可切 Xray 谓词的纯逻辑在 xray-form-logic.ts（jest 可直测），此处 re-export 保持调用方不变。
export { formXrayRequirement, formCanUseXray } from './xray-form-logic';

export function XhttpFields({ control, t }: { control: AnyControl; t: TFn }) {
  return (
    <FieldGrid cols={2}>
      <FormField
        control={control}
        name="xhttpPath"
        render={({ field }) => (
          <div className="nd-fld">
            <span className="nd-fld-lbl">{t('servers.xhttpPath', 'XHTTP Path')}</span>
            <Input placeholder="/" {...field} />
            <FormMessage className="fld-err" />
          </div>
        )}
      />
      <FormField
        control={control}
        name="xhttpHost"
        render={({ field }) => (
          <div className="nd-fld">
            <span className="nd-fld-lbl">
              {t('servers.xhttpHost', 'XHTTP Host')}{' '}
              <small className="font-medium text-fg-faint">{t('servers.optional')}</small>
            </span>
            <Input placeholder="cdn.example.com" {...field} />
            <FormMessage className="fld-err" />
          </div>
        )}
      />
      <FormField
        control={control}
        name="xhttpMode"
        render={({ field }) => (
          <div className="nd-fld">
            <span className="nd-fld-lbl inline-flex items-center gap-1.5">
              {t('servers.xhttpMode', 'XHTTP Mode')}
              <InfoTooltip
                content={t(
                  'servers.xhttpModeDesc',
                  'auto picks the best mode. packet-up works through most CDNs; stream-up/stream-one need streaming-capable paths.'
                )}
              />
            </span>
            <Select onValueChange={field.onChange} value={field.value || 'auto'}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {XHTTP_MODES.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormMessage className="fld-err" />
          </div>
        )}
      />
      <FieldSpan>
        <FormField
          control={control}
          name="xhttpExtra"
          render={({ field, fieldState }) => (
            <div className="nd-fld">
              <span className="nd-fld-lbl inline-flex items-center gap-1.5">
                {t('servers.xhttpExtra', 'XHTTP extra (JSON)')}{' '}
                <small className="font-medium text-fg-faint">{t('servers.optional')}</small>
                <InfoTooltip
                  content={t(
                    'servers.xhttpExtraDesc',
                    'Raw Xray xhttpSettings.extra object, e.g. {"xmux":{"maxConcurrency":"16-32"}} or downloadSettings for split up/down links.'
                  )}
                />
              </span>
              <textarea
                className="nd-textarea mono"
                style={{ minHeight: 72 }}
                placeholder='{"xmux": {"maxConcurrency": "16-32"}}'
                {...field}
              />
              {fieldState.error && (
                <p className="fld-err">{t('servers.xhttpExtraInvalid', 'Must be a JSON object')}</p>
              )}
            </div>
          )}
        />
      </FieldSpan>
    </FieldGrid>
  );
}

/**
 * 「使用 Xray 内核」开关：节点用到 Xray 独有特性时恒开且置灰（提示原因）；否则由用户选择（仅 canUseXrayCore 协议）。
 */
export function XrayCoreField({
  control,
  t,
  requirement,
  supported = true,
}: {
  control: AnyControl;
  t: TFn;
  requirement: XrayRequirement | null;
  supported?: boolean;
}) {
  const auto = requirement !== null && requirement !== 'forced';
  return (
    <SwitchField
      control={control}
      name="useXrayCore"
      label={
        <span className="inline-flex items-center gap-1.5">
          <Cpu className="h-3.5 w-3.5" />
          {t('servers.xrayCore', 'Run on Xray core')}
        </span>
      }
      tooltip={t(
        'servers.xrayCoreDesc',
        'FlowZ keeps sing-box as the main core (TUN, routing, DNS) and runs this node inside a bundled Xray sidecar. Required for Xray-only protocols such as XHTTP and VLESS Encryption.'
      )}
      disabled={auto || !supported}
      checkedOverride={auto ? true : supported ? undefined : false}
      hint={
        requirement ? (
          <p className="text-xs text-muted-foreground">
            {auto
              ? t('servers.xrayCoreAuto', {
                  defaultValue: 'Uses {{reason}}, so this node runs on the Xray core.',
                  reason: xrayReasonLabel(requirement, t),
                })
              : t('servers.xrayCoreForced', 'This node will run on the Xray core.')}
          </p>
        ) : !supported ? (
          <p className="text-xs text-muted-foreground">
            {t(
              'servers.xrayCoreUnsupported',
              'Not available with HTTP/2 transport, Shadow-TLS or SS plugins (sing-box only features).'
            )}
          </p>
        ) : undefined
      }
    />
  );
}

/** 证书 SHA256 指纹（仅 Xray 内核消费 → 填写即改由 Xray 承载，见 shared/xray 的 tls-pinned-cert）。 */
export function PinnedCertField({ control, t }: { control: AnyControl; t: TFn }) {
  return (
    <FormField
      control={control}
      name="tlsPinnedSha256"
      render={({ field }) => (
        <div className="nd-fld">
          <span className="nd-fld-lbl inline-flex items-center gap-1.5">
            {t('servers.pinnedCert', 'Certificate SHA-256 pin')}{' '}
            <small className="font-medium text-fg-faint">{t('servers.optional')}</small>
            <InfoTooltip
              content={t(
                'servers.pinnedCertDesc',
                'Xray 26 removed "allow insecure". For self-signed servers paste the certificate SHA-256 in hex (comma-separate several; get it with `xray tls hash --cert cert.pem`). sing-box cannot pin certificates, so filling this runs the node on the Xray core.'
              )}
            />
          </span>
          <Input className="mono" placeholder="e3b0c44298fc1c149afb…" {...field} />
          <FormMessage className="fld-err" />
        </div>
      )}
    />
  );
}

/** Reality 的 Xray 扩展字段（spiderX / ML-DSA-65）。约定字段名 realitySpiderX / realityMldsa65。 */
export function RealityXrayFields({ control, t }: { control: AnyControl; t: TFn }) {
  return (
    <>
      <FormField
        control={control}
        name="realitySpiderX"
        render={({ field }) => (
          <div className="nd-fld">
            <span className="nd-fld-lbl">
              SpiderX <small className="font-medium text-fg-faint">{t('servers.optional')}</small>
            </span>
            <Input className="mono" placeholder="/" {...field} />
            <FormMessage className="fld-err" />
          </div>
        )}
      />
      <FieldSpan>
        <FormField
          control={control}
          name="realityMldsa65"
          render={({ field }) => (
            <div className="nd-fld">
              <span className="nd-fld-lbl inline-flex items-center gap-1.5">
                {t('servers.realityMldsa65', 'ML-DSA-65 verify key')}{' '}
                <small className="font-medium text-fg-faint">{t('servers.optional')}</small>
                <InfoTooltip
                  content={t(
                    'servers.realityMldsa65Desc',
                    'Post-quantum REALITY certificate verification (Xray only; share-link pqv). Filling this runs the node on the Xray core.'
                  )}
                />
              </span>
              <Input className="mono" placeholder="pqv" {...field} />
              <FormMessage className="fld-err" />
            </div>
          )}
        />
      </FieldSpan>
    </>
  );
}
