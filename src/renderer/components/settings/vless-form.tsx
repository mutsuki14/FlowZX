import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Form, FormField, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { MultiplexFields } from './shared/anti-censor-fields';
import { AddressField, PortField } from './shared/basic-fields';
import { TlsServerNameField, FingerprintField, TlsAdvancedFields } from './shared/tls-fields';
import { WsPathField, WsHostField, GrpcServiceNameField } from './shared/transport-fields';
import { RealityPublicKeyField, RealityShortIdField } from './shared/reality-fields';
import {
  XhttpFields,
  XrayCoreField,
  PinnedCertField,
  RealityXrayFields,
  formXrayRequirement,
  formCanUseXray,
} from './shared/xray-fields';
import { FormSection, FieldGrid, FieldSpan } from './shared/form-layout';
import { InfoTooltip } from './shared/info-tooltip';
import { normalizeNetworkUpper } from './shared/normalize-network';
import {
  echSchemaShape,
  multiplexSchemaShape,
  tlsSpoofSchemaShape,
  echDefaults,
  multiplexDefaults,
  tlsSpoofDefaults,
  readEchDefault,
  readMultiplexDefaults,
  readTlsSpoofDefault,
  buildMultiplexSettings,
  buildTlsSpoofSettings,
  readTransportDefaults,
  buildTransportSettings,
  xraySchemaShape,
  xrayDefaults,
  readXrayDefaults,
  refineXhttpExtra,
} from './shared/field-schemas';
import type { ServerConfig } from '@/bridge/types';
import { useTranslation } from 'react-i18next';

const createVlessSchema = (t: any) =>
  z.object({
    address: z.string().min(1, t('servers.addressRequired')),
    port: z.number().min(1).max(65535),
    uuid: z
      .string()
      .min(1, t('servers.uuidRequired'))
      .regex(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        t('servers.uuidInvalid')
      ),
    encryption: z.string().optional(),
    flow: z.string().optional(),
    network: z.enum(['Tcp', 'Ws', 'Grpc', 'Http', 'HttpUpgrade', 'Xhttp']),
    security: z.enum(['None', 'Tls', 'Reality']),
    tlsServerName: z.string().optional(),
    tlsAllowInsecure: z.boolean(),
    tlsFingerprint: z.string().optional(),
    tlsEngine: z.string().optional(),
    realityPublicKey: z.string().optional(),
    realityShortId: z.string().optional(),
    realitySpiderX: z.string().optional(),
    realityMldsa65: z.string().optional(),
    wsPath: z.string().optional(),
    wsHost: z.string().optional(),
    grpcServiceName: z.string().optional(),
    ...echSchemaShape,
    ...multiplexSchemaShape,
    ...tlsSpoofSchemaShape,
    ...xraySchemaShape,
  });

type VlessFormValues = z.infer<ReturnType<typeof createVlessSchema>>;

interface VlessFormProps {
  serverConfig?: ServerConfig;
  onSubmit: (config: any) => Promise<void>;
}

export function VlessForm({ serverConfig, onSubmit }: VlessFormProps) {
  const { t } = useTranslation();
  // xhttpExtra 的 JSON 校验挂对象级（仅 XHTTP 时生效，见 refineXhttpExtra）。
  const vlessFormSchema = createVlessSchema(t).superRefine(refineXhttpExtra);

  const normalizeSecurity = (s: string | undefined): 'None' | 'Tls' | 'Reality' => {
    const lower = (s || 'tls').toLowerCase();
    if (lower === 'none') return 'None';
    if (lower === 'reality') return 'Reality';
    return 'Tls';
  };

  const getDefaultValues = (): VlessFormValues => {
    if (serverConfig && serverConfig.protocol?.toLowerCase() === 'vless') {
      return {
        address: serverConfig.address || '',
        port: serverConfig.port || 443,
        uuid: serverConfig.uuid || '',
        // VLESS Encryption 串（mlkem768x25519plus.*）含大小写敏感的 base64url 密钥 → 不得 toLowerCase。
        encryption: serverConfig.encryption?.trim() || 'none',
        flow: (serverConfig.flow || '').toLowerCase(),
        network: normalizeNetworkUpper(serverConfig.network),
        security: normalizeSecurity(serverConfig.security),
        tlsServerName: serverConfig.tlsSettings?.serverName || '',
        tlsAllowInsecure: serverConfig.tlsSettings?.allowInsecure || false,
        tlsFingerprint: (serverConfig.tlsSettings?.fingerprint || 'chrome').toLowerCase(),
        tlsEngine: serverConfig.tlsSettings?.engine || 'go',
        realityPublicKey: serverConfig.realitySettings?.publicKey || '',
        realityShortId: serverConfig.realitySettings?.shortId || '',
        realitySpiderX: serverConfig.realitySettings?.spiderX || '',
        realityMldsa65: serverConfig.realitySettings?.mldsa65Verify || '',
        ...readTransportDefaults(serverConfig),
        ...readEchDefault(serverConfig),
        ...readMultiplexDefaults(serverConfig),
        ...readTlsSpoofDefault(serverConfig),
        ...readXrayDefaults(serverConfig),
      };
    }
    return {
      address: '',
      port: 443,
      uuid: '',
      encryption: 'none',
      flow: '',
      network: 'Tcp',
      security: 'Tls',
      tlsServerName: '',
      tlsAllowInsecure: false,
      tlsFingerprint: 'chrome',
      tlsEngine: 'go',
      realityPublicKey: '',
      realityShortId: '',
      realitySpiderX: '',
      realityMldsa65: '',
      ...readTransportDefaults(),
      ...echDefaults,
      ...multiplexDefaults,
      ...tlsSpoofDefaults,
      ...xrayDefaults,
    };
  };

  const form = useForm<VlessFormValues>({
    resolver: zodResolver(vlessFormSchema),
    defaultValues: getDefaultValues(),
  });

  const handleSubmit = async (values: VlessFormValues) => {
    const network = values.network.toLowerCase();
    const security = values.security.toLowerCase() as 'none' | 'tls' | 'reality';

    const serverConfig = {
      protocol: 'vless' as const,
      address: values.address,
      port: values.port,
      uuid: values.uuid,
      encryption: values.encryption?.trim() || 'none',
      flow: values.flow || undefined,
      network,
      security,
      tlsSettings:
        security === 'tls' || security === 'reality'
          ? {
              serverName: values.tlsServerName?.trim() || null,
              allowInsecure: security === 'tls' ? values.tlsAllowInsecure : false,
              fingerprint: values.tlsFingerprint || 'chrome',
              engine:
                security === 'tls' && values.tlsEngine && values.tlsEngine !== 'go'
                  ? values.tlsEngine
                  : undefined,
              ech: values.ech ? true : undefined,
              echConfig: values.echConfig?.trim() || undefined,
              // 钉扎只有 Xray 消费：传输切不到 Xray（如 HTTP/2）时不保存，免留一个静默无效的「安全设置」。
              pinnedPeerCertSha256:
                security === 'tls' && formCanUseXray({ protocol: 'vless', network: values.network })
                  ? values.tlsPinnedSha256?.trim() || undefined
                  : undefined,
              ...(security === 'tls' ? buildTlsSpoofSettings(values) : {}),
            }
          : null,
      realitySettings:
        security === 'reality'
          ? {
              publicKey: values.realityPublicKey?.trim() || '',
              shortId: values.realityShortId?.trim() || undefined,
              spiderX: values.realitySpiderX?.trim() || undefined,
              mldsa65Verify: values.realityMldsa65?.trim() || undefined,
            }
          : null,
      ...buildTransportSettings(network, values),
      multiplexSettings: buildMultiplexSettings(values, { skipVisionFlow: true }),
      useXrayCore: values.useXrayCore ? true : undefined,
    };

    await onSubmit(serverConfig);
  };

  const isTlsEnabled = form.watch('security') === 'Tls';
  const isRealityEnabled = form.watch('security') === 'Reality';
  const watchedNetwork = form.watch('network');
  const showPathHostFields =
    watchedNetwork === 'Ws' || watchedNetwork === 'HttpUpgrade' || watchedNetwork === 'Http';
  const isGrpcEnabled = watchedNetwork === 'Grpc';
  const isXhttpEnabled = watchedNetwork === 'Xhttp';
  // 内核判定（与主进程生成期同一谓词）：XHTTP / VLESS Encryption / vision-udp443 / pqv / 证书钉扎 / 手动勾选 → Xray。
  const xrayReq = formXrayRequirement({
    protocol: 'vless',
    network: watchedNetwork,
    encryption: form.watch('encryption'),
    flow: form.watch('flow'),
    security: form.watch('security'),
    mldsa65Verify: isRealityEnabled ? form.watch('realityMldsa65') : undefined,
    pinnedCert: isTlsEnabled ? form.watch('tlsPinnedSha256')?.trim() : undefined,
    useXrayCore: form.watch('useXrayCore'),
  });
  const xraySupported = formCanUseXray({ protocol: 'vless', network: watchedNetwork });

  return (
    <Form {...form}>
      <form
        id="node-cfg-form"
        onSubmit={form.handleSubmit(handleSubmit)}
        onReset={(e) => {
          e.preventDefault();
          form.reset();
        }}
        className="flex flex-col gap-[13px]"
      >
        <FieldGrid cols={2}>
          <AddressField control={form.control} t={t} />
          <PortField control={form.control} t={t} placeholder="443" />
          <FieldSpan>
            <FormField
              control={form.control}
              name="uuid"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">
                    {t('servers.uuid', 'UUID')} <span className="nd-req">*</span>
                  </span>
                  <Input className="mono" placeholder={t('servers.uuidPlaceholder')} {...field} />
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
          </FieldSpan>
          <FormField
            control={form.control}
            name="encryption"
            render={({ field }) => (
              <div className="nd-fld">
                <span className="nd-fld-lbl inline-flex items-center gap-1.5">
                  {t('servers.encryption')}
                  <InfoTooltip
                    content={t(
                      'servers.vlessEncryptionDesc',
                      'none, or a VLESS Encryption string from `xray vlessenc` (e.g. mlkem768x25519plus.native.0rtt.…). VLESS Encryption runs on the Xray core.'
                    )}
                  />
                </span>
                <Input className="mono" placeholder="none" {...field} />
                <FormMessage className="fld-err" />
              </div>
            )}
          />
          <FormField
            control={form.control}
            name="network"
            render={({ field }) => (
              <div className="nd-fld">
                <span className="nd-fld-lbl">{t('servers.transport')}</span>
                <Select onValueChange={field.onChange} value={field.value}>
                  <SelectTrigger>
                    <SelectValue placeholder={t('servers.selectTransport')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Tcp">TCP</SelectItem>
                    <SelectItem value="Ws">WebSocket</SelectItem>
                    <SelectItem value="Grpc">gRPC</SelectItem>
                    <SelectItem value="HttpUpgrade">HTTPUpgrade</SelectItem>
                    <SelectItem value="Http">HTTP/2</SelectItem>
                    <SelectItem value="Xhttp">XHTTP (Xray)</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage className="fld-err" />
              </div>
            )}
          />
          <FormField
            control={form.control}
            name="security"
            render={({ field }) => (
              <div className="nd-fld">
                <span className="nd-fld-lbl">{t('servers.security')}</span>
                <Select onValueChange={field.onChange} value={field.value}>
                  <SelectTrigger>
                    <SelectValue placeholder={t('servers.selectSecurity')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="None">{t('servers.none')}</SelectItem>
                    <SelectItem value="Tls">TLS</SelectItem>
                    <SelectItem value="Reality">Reality</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage className="fld-err" />
              </div>
            )}
          />
        </FieldGrid>
        {/* Reality：security=Reality 时 publicKey 为条件必填 → 放基础(不入折叠高级)。 */}
        {isRealityEnabled && (
          <div className="nd-fset">
            <div className="nd-fset-h">
              Reality{' '}
              <span className="nd-badge">
                {t('servers.realityRequiredWhen', 'security=Reality')}
              </span>
            </div>
            <FieldGrid cols={2}>
              <TlsServerNameField
                control={form.control}
                t={t}
                labelKey="servers.realityTarget"
                descKey="servers.realityTargetDesc"
                placeholder="www.microsoft.com"
              />
              <FingerprintField control={form.control} t={t} />
              <FieldSpan>
                <RealityPublicKeyField control={form.control} t={t} />
              </FieldSpan>
              <RealityShortIdField control={form.control} t={t} />
              <FormField
                control={form.control}
                name="flow"
                render={({ field }) => (
                  <div className="nd-fld">
                    <span className="nd-fld-lbl">
                      Flow{' '}
                      <small className="font-medium text-fg-faint">{t('servers.optional')}</small>
                    </span>
                    <Select
                      onValueChange={(v) => field.onChange(v === '_none' ? '' : v)}
                      value={field.value || '_none'}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={t('servers.selectFlow', 'Select Flow')} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="_none">{t('servers.none')}</SelectItem>
                        <SelectItem value="xtls-rprx-vision">xtls-rprx-vision</SelectItem>
                        <SelectItem value="xtls-rprx-vision-udp443">
                          xtls-rprx-vision-udp443 (Xray)
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage className="fld-err" />
                  </div>
                )}
              />
              <RealityXrayFields control={form.control} t={t} />
            </FieldGrid>
          </div>
        )}

        {/* XHTTP（Xray 独有）：path/mode 为常用必调项 → 放基础区而非折叠高级。 */}
        {isXhttpEnabled && (
          <div className="nd-fset">
            <div className="nd-fset-h">
              XHTTP <span className="nd-badge">Xray</span>
            </div>
            <XhttpFields control={form.control} t={t} />
          </div>
        )}

        <FormSection title={t('servers.advanced', 'Advanced')} collapsible defaultOpen={false}>
          <XrayCoreField
            control={form.control}
            t={t}
            requirement={xrayReq}
            supported={xraySupported}
          />

          {isTlsEnabled && <TlsAdvancedFields control={form.control} t={t} />}
          {/* 证书钉扎（仅 Xray 消费）：TLS 且传输能走 Xray 时显示——填写即改走 Xray（tls-pinned-cert），不能只在已需 Xray 时露出；HTTP/2 等切不到 Xray 的传输上钉扎无从生效，不显示。 */}
          {isTlsEnabled && xraySupported && <PinnedCertField control={form.control} t={t} />}

          {showPathHostFields && (
            <FieldGrid cols={2}>
              <WsPathField control={form.control} t={t} />
              <WsHostField control={form.control} t={t} />
            </FieldGrid>
          )}

          {isGrpcEnabled && (
            <FieldGrid cols={2}>
              <GrpcServiceNameField control={form.control} t={t} />
            </FieldGrid>
          )}

          <MultiplexFields
            control={form.control}
            t={t}
            disabled={(form.watch('flow') || '').startsWith('xtls-rprx-vision') || !!xrayReq}
            disabledReason={
              xrayReq
                ? t(
                    'servers.multiplexXrayConflict',
                    'Xray-core nodes do not use sing-box multiplex (configure xmux in XHTTP extra instead).'
                  )
                : t(
                    'servers.multiplexVisionConflict',
                    'Multiplex 与 xtls-rprx-vision flow 不兼容，已禁用。'
                  )
            }
          />
        </FormSection>
      </form>
    </Form>
  );
}
