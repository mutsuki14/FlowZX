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
import {
  readTrojanSecurityDefaults,
  buildRealityTlsSettings,
  buildRealitySettings,
  realityXrayExtrasSupported,
  requireRealityPublicKey,
} from './shared/reality-form-logic';
import { FormSection, FieldGrid, FieldSpan } from './shared/form-layout';
import { normalizeNetworkLower } from './shared/normalize-network';
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

const createTrojanSchema = (t: any) =>
  z.object({
    address: z.string().min(1, t('servers.addressRequired')),
    port: z.number().min(1).max(65535),
    password: z.string().min(1, t('servers.passwordRequired')),
    network: z.enum(['tcp', 'ws', 'grpc', 'http', 'httpupgrade', 'xhttp']),
    // REALITY：sing-box 1.14（sing-box check）与 Xray 26（xray run -test）均接受 trojan + REALITY → 两核皆可承载。
    security: z.enum(['none', 'tls', 'reality']),
    tlsServerName: z.string().optional(),
    tlsAllowInsecure: z.boolean(),
    tlsFingerprint: z.string().optional(),
    tlsEngine: z.string().optional(),
    alpn: z.string().optional(),
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

type TrojanFormValues = z.infer<ReturnType<typeof createTrojanSchema>>;

interface TrojanFormProps {
  serverConfig?: ServerConfig;
  onSubmit: (config: any) => Promise<void>;
}

export function TrojanForm({ serverConfig, onSubmit }: TrojanFormProps) {
  const { t } = useTranslation();
  // xhttpExtra 的 JSON 校验 / REALITY publicKey 条件必填均挂对象级（仅对应模式下生效）。
  const trojanFormSchema = createTrojanSchema(t)
    .superRefine(refineXhttpExtra)
    .superRefine(
      requireRealityPublicKey(
        t('servers.realityPublicKeyRequired', 'REALITY requires the server public key')
      )
    );

  // 同步 defaultValues（对齐 vless/vmess）：编辑态直接由 serverConfig 算初值，表单按 key={id} 挂载即正确。
  // 不走挂载后 useEffect(form.reset)——radix Select 受控 value 被编程改写会触发伪 onValueChange 打回空态
  // （传输显「选择传输协议」+ 保存 invalid input，issue #294）；同步初值让 Select 挂载即带正确值，结构性免疫。
  const getDefaultValues = (): TrojanFormValues => {
    if (serverConfig && serverConfig.protocol?.toLowerCase() === 'trojan') {
      return {
        address: serverConfig.address || '',
        port: serverConfig.port || 443,
        password: serverConfig.password || '',
        network: normalizeNetworkLower(serverConfig.network),
        // security / SNI / 指纹（TLS 缺省 none、REALITY 缺省 chrome）/ REALITY 字段：与往返单测共用同一读取函数。
        ...readTrojanSecurityDefaults(serverConfig),
        tlsAllowInsecure: serverConfig.tlsSettings?.allowInsecure || false,
        tlsEngine: serverConfig.tlsSettings?.engine || 'go',
        alpn: serverConfig.tlsSettings?.alpn?.join(',') || '',
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
      password: '',
      network: 'tcp',
      ...readTrojanSecurityDefaults(),
      tlsAllowInsecure: false,
      tlsEngine: 'go',
      alpn: '',
      ...readTransportDefaults(),
      ...echDefaults,
      ...multiplexDefaults,
      ...tlsSpoofDefaults,
      ...xrayDefaults,
    };
  };

  const form = useForm<TrojanFormValues>({
    resolver: zodResolver(trojanFormSchema),
    defaultValues: getDefaultValues(),
  });

  const handleSubmit = async (values: TrojanFormValues) => {
    const network = values.network;
    const config = {
      protocol: 'trojan',
      address: values.address,
      port: values.port,
      password: values.password,
      network,
      security: values.security,
      tlsSettings:
        values.security === 'tls'
          ? {
              serverName: values.tlsServerName || null,
              allowInsecure: values.tlsAllowInsecure,
              fingerprint: values.tlsFingerprint || 'none',
              engine: values.tlsEngine && values.tlsEngine !== 'go' ? values.tlsEngine : undefined,
              alpn: values.alpn ? values.alpn.split(',').map((s) => s.trim()) : undefined,
              ech: values.ech ? true : undefined,
              echConfig: values.echConfig?.trim() || undefined,
              // 钉扎只有 Xray 消费：传输切不到 Xray（如 HTTP/2）时不保存，免留一个静默无效的「安全设置」。
              pinnedPeerCertSha256: formCanUseXray({ protocol: 'trojan', network: values.network })
                ? values.tlsPinnedSha256?.trim() || undefined
                : undefined,
              ...buildTlsSpoofSettings(values),
            }
          : values.security === 'reality'
            ? buildRealityTlsSettings(values)
            : null,
      realitySettings:
        values.security === 'reality' ? buildRealitySettings('trojan', values) : null,
      ...buildTransportSettings(network, values),
      useXrayCore: values.useXrayCore ? true : undefined,
      multiplexSettings: buildMultiplexSettings(values),
    };

    await onSubmit(config);
  };

  const isTlsEnabled = form.watch('security') === 'tls';
  const isRealityEnabled = form.watch('security') === 'reality';
  const watchedNetwork = form.watch('network');
  const showPathHostFields =
    watchedNetwork === 'ws' || watchedNetwork === 'httpupgrade' || watchedNetwork === 'http';
  const isGrpcEnabled = watchedNetwork === 'grpc';
  const isXhttpEnabled = watchedNetwork === 'xhttp';
  // REALITY 的 Xray 扩展（spiderX / ML-DSA-65）仅在 RAW / gRPC / XHTTP 上显示；ML-DSA-65 也只在此时参与内核判定
  //（与提交侧 buildRealitySettings 同一谓词）——ws / httpupgrade / HTTP/2 上的残留值不把节点误判成 Xray。
  const realityXrayExtras =
    isRealityEnabled && realityXrayExtrasSupported('trojan', watchedNetwork);
  // 内核判定（与主进程生成期同一谓词）：XHTTP / REALITY ML-DSA-65（pqv）/ 证书钉扎 / 手动勾选 → Xray。
  const xrayReq = formXrayRequirement({
    protocol: 'trojan',
    network: watchedNetwork,
    security: form.watch('security'),
    mldsa65Verify: realityXrayExtras ? form.watch('realityMldsa65') : undefined,
    pinnedCert: isTlsEnabled ? form.watch('tlsPinnedSha256')?.trim() : undefined,
    useXrayCore: form.watch('useXrayCore'),
  });
  const xraySupported = formCanUseXray({
    protocol: 'trojan',
    network: watchedNetwork,
    security: form.watch('security'),
  });

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
              name="password"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">
                    {t('servers.password')} <span className="nd-req">*</span>
                  </span>
                  <Input
                    type="password"
                    className="mono"
                    placeholder={t('servers.passwordPlaceholder')}
                    {...field}
                  />
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
          </FieldSpan>
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
                    <SelectItem value="tcp">TCP</SelectItem>
                    <SelectItem value="ws">WebSocket</SelectItem>
                    <SelectItem value="grpc">gRPC</SelectItem>
                    <SelectItem value="httpupgrade">HTTPUpgrade</SelectItem>
                    <SelectItem value="http">HTTP/2</SelectItem>
                    <SelectItem value="xhttp">XHTTP (Xray)</SelectItem>
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
                    <SelectItem value="none">{t('servers.none')}</SelectItem>
                    <SelectItem value="tls">TLS</SelectItem>
                    <SelectItem value="reality">Reality</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage className="fld-err" />
              </div>
            )}
          />
        </FieldGrid>

        {/* Reality：security=reality 时 publicKey 为条件必填 → 放基础（不入折叠高级）；字段与 vless 表单同构（无 flow）。 */}
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
              <FingerprintField control={form.control} t={t} reality />
              <FieldSpan>
                <RealityPublicKeyField control={form.control} t={t} />
              </FieldSpan>
              <RealityShortIdField control={form.control} t={t} />
              {/* spiderX / ML-DSA-65 只有 Xray 消费：传输承载不了 Xray REALITY（ws / httpupgrade / HTTP/2）时不显示——填 pqv 即改走 Xray，在这些传输上只会产出 Xray 拒收的节点。 */}
              {realityXrayExtras && <RealityXrayFields control={form.control} t={t} />}
            </FieldGrid>
          </div>
        )}

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
          {isTlsEnabled && <TlsAdvancedFields control={form.control} t={t} alpn="http/1.1" />}
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
            disabled={!!xrayReq}
            disabledReason={t(
              'servers.multiplexXrayConflict',
              'Xray-core nodes do not use sing-box multiplex (configure xmux in XHTTP extra instead).'
            )}
          />
        </FormSection>
      </form>
    </Form>
  );
}
