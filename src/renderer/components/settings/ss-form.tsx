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
import { Switch } from '@/components/ui/switch';
import { Shield } from 'lucide-react';
import { MultiplexFields } from './shared/anti-censor-fields';
import { AddressField, PortField } from './shared/basic-fields';
import { XrayCoreField, formXrayRequirement, formCanUseXray } from './shared/xray-fields';
import { FormSection, FieldGrid, FieldSpan } from './shared/form-layout';
import {
  multiplexSchemaShape,
  multiplexDefaults,
  readMultiplexDefaults,
  buildMultiplexSettings,
} from './shared/field-schemas';
import type { ServerConfig } from '@/bridge/types';
import { useTranslation } from 'react-i18next';

const createSsSchema = (t: any) =>
  z.object({
    address: z.string().min(1, t('servers.addressRequired')),
    port: z.number().min(1).max(65535),
    method: z.string().min(1, t('servers.methodRequired')),
    password: z.string().min(1, t('servers.passwordRequired')),
    plugin: z.string().optional(),
    pluginOptions: z.string().optional(),
    remarks: z.string().optional(),
    enableShadowTls: z.boolean(),
    shadowTlsPassword: z.string().optional(),
    shadowTlsSni: z.string().optional(),
    shadowTlsFingerprint: z.string().optional(),
    shadowTlsPort: z.number().optional().or(z.literal('')), // '' = 清空态哨兵（提交 `|| undefined` 归一）
    useXrayCore: z.boolean().optional(),
    ...multiplexSchemaShape,
  });

type SsFormValues = z.infer<ReturnType<typeof createSsSchema>>;

interface SsFormProps {
  serverConfig?: ServerConfig;
  onSubmit: (config: any) => Promise<void>;
}

const COMMON_METHODS = [
  'aes-128-gcm',
  'aes-256-gcm',
  'chacha20-ietf-poly1305',
  '2022-blake3-aes-128-gcm',
  '2022-blake3-aes-256-gcm',
  '2022-blake3-chacha20-poly1305',
  'aes-128-cfb',
  'aes-192-cfb',
  'aes-256-cfb',
  'aes-128-ctr',
  'aes-192-ctr',
  'aes-256-ctr',
  'rc4-md5',
  'chacha20-ietf',
  'xchacha20-ietf-poly1305',
];

const CIPHER_ALIASES: Record<string, string> = {
  'chacha20-poly1305': 'chacha20-ietf-poly1305',
  'xchacha20-poly1305': 'xchacha20-ietf-poly1305',
};

function normalizeMethod(raw: string | undefined): string {
  if (!raw) return 'aes-256-gcm';
  const lower = raw.toLowerCase().trim();
  const aliased = CIPHER_ALIASES[lower] ?? lower;
  return COMMON_METHODS.find((m) => m === aliased) ?? aliased;
}

/**
 * 内核判定所需的表单片段（shared/xray#canUseXrayCore，与生成期同一谓词）：插件 / Shadow-TLS 为 sing-box 独有，
 * 流加密（aes-*-cfb/ctr、rc4-md5…）Xray 已移除。Shadow-TLS 按开关判（开着即视为要用，与界面一致）。
 */
function ssXrayLayer(v: { method?: string; plugin?: string; enableShadowTls?: boolean }) {
  return {
    protocol: 'shadowsocks',
    ssMethod: v.method,
    ssPlugin: v.plugin,
    shadowTls: !!v.enableShadowTls,
  };
}

export function SsForm({ serverConfig, onSubmit }: SsFormProps) {
  const { t } = useTranslation();
  const ssFormSchema = createSsSchema(t);

  const isSs = serverConfig?.protocol?.toLowerCase() === 'shadowsocks';
  const hasShadowTls = isSs && !!serverConfig?.shadowTlsSettings;

  const form = useForm<SsFormValues>({
    resolver: zodResolver(ssFormSchema),
    defaultValues: {
      address: isSs ? (serverConfig?.address ?? '') : '',
      port: isSs ? (serverConfig?.port ?? 8388) : 8388,
      method: normalizeMethod(isSs ? serverConfig?.shadowsocksSettings?.method : undefined),
      password: isSs ? (serverConfig?.shadowsocksSettings?.password ?? '') : '',
      plugin: isSs ? (serverConfig?.shadowsocksSettings?.plugin ?? '') : '',
      pluginOptions: isSs ? (serverConfig?.shadowsocksSettings?.pluginOptions ?? '') : '',
      remarks: isSs ? (serverConfig?.name ?? '') : '',
      enableShadowTls: hasShadowTls,
      shadowTlsPassword: hasShadowTls ? (serverConfig?.shadowTlsSettings?.password ?? '') : '',
      shadowTlsSni: hasShadowTls ? (serverConfig?.shadowTlsSettings?.sni ?? '') : '',
      shadowTlsFingerprint: hasShadowTls
        ? (serverConfig?.shadowTlsSettings?.fingerprint ?? 'chrome').toLowerCase()
        : 'chrome',
      shadowTlsPort: hasShadowTls
        ? (serverConfig?.shadowTlsSettings?.port ?? undefined)
        : undefined,
      useXrayCore: isSs && serverConfig?.useXrayCore === true,
      ...(isSs && serverConfig ? readMultiplexDefaults(serverConfig) : multiplexDefaults),
    },
  });

  const enableShadowTls = form.watch('enableShadowTls');

  const handleSubmit = async (values: SsFormValues) => {
    const config: any = {
      protocol: 'shadowsocks' as const,
      address: values.address,
      port: values.port,
      name: values.remarks || `${values.address}:${values.port}`,
      shadowsocksSettings: {
        method: values.method,
        password: values.password,
        plugin: values.plugin || undefined,
        pluginOptions: values.pluginOptions || undefined,
      },
      multiplexSettings: buildMultiplexSettings(values),
      // 不可切 Xray（插件 / Shadow-TLS / 流加密）时开关显示为关 → 提交也不持久化，免日后去掉插件时节点静默改走 Xray。
      useXrayCore: values.useXrayCore && formCanUseXray(ssXrayLayer(values)) ? true : undefined,
    };

    if (values.enableShadowTls && values.shadowTlsPassword && values.shadowTlsSni) {
      config.shadowTlsSettings = {
        password: values.shadowTlsPassword,
        sni: values.shadowTlsSni,
        fingerprint: values.shadowTlsFingerprint || 'chrome',
        port: values.shadowTlsPort || undefined,
      };
    }

    await onSubmit(config);
  };

  const xrayLayer = ssXrayLayer({
    method: form.watch('method'),
    plugin: form.watch('plugin'),
    enableShadowTls,
  });
  const xrayReq = formXrayRequirement({ ...xrayLayer, useXrayCore: form.watch('useXrayCore') });
  const xraySupported = formCanUseXray(xrayLayer);

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
          <FieldSpan>
            <FormField
              control={form.control}
              name="remarks"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">{t('servers.remarks')}</span>
                  <Input placeholder={t('servers.remarksPlaceholder')} {...field} />
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
          </FieldSpan>
          <AddressField control={form.control} t={t} />
          <PortField control={form.control} t={t} placeholder="8388" />
          <FieldSpan>
            <FormField
              control={form.control}
              name="method"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">{t('servers.encryption')}</span>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <SelectTrigger>
                      <SelectValue placeholder={t('servers.selectEncryption')} />
                    </SelectTrigger>
                    <SelectContent>
                      {(() => {
                        const sortedMethods = [...COMMON_METHODS];
                        if (field.value && !COMMON_METHODS.includes(field.value)) {
                          sortedMethods.unshift(field.value);
                        }
                        return sortedMethods.map((method) => (
                          <SelectItem key={method} value={method}>
                            {method}
                          </SelectItem>
                        ));
                      })()}
                    </SelectContent>
                  </Select>
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
          </FieldSpan>
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
        </FieldGrid>

        <FormSection title={t('servers.advanced', 'Advanced')} collapsible defaultOpen={false}>
          <XrayCoreField
            control={form.control}
            t={t}
            requirement={xrayReq}
            supported={xraySupported}
            unsupportedHint={t(
              'servers.xrayCoreUnsupportedSs',
              'Not available with SS plugins or Shadow-TLS (sing-box only), or with legacy stream ciphers: Xray supports only AEAD (AES-GCM, ChaCha20-Poly1305) and 2022 methods.'
            )}
          />

          <FieldGrid cols={2}>
            <FormField
              control={form.control}
              name="plugin"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">
                    {t('servers.plugin')}{' '}
                    <small className="font-medium text-fg-faint">{t('servers.optional')}</small>
                  </span>
                  <Input placeholder="obfs-local" {...field} />
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
            <FormField
              control={form.control}
              name="pluginOptions"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">
                    {t('servers.pluginOptions')}{' '}
                    <small className="font-medium text-fg-faint">{t('servers.optional')}</small>
                  </span>
                  <Input placeholder="obfs=http;obfs-host=..." {...field} />
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
          </FieldGrid>

          <div className="nd-fset">
            <FormField
              control={form.control}
              name="enableShadowTls"
              render={({ field }) => (
                <div className="nd-fset-h">
                  <span className="inline-flex items-center gap-1.5">
                    <Shield className="h-4 w-4 text-muted-foreground" />
                    {t('servers.enableShadowTls', 'Enable Shadow-TLS v3')}
                  </span>
                  <Switch
                    className="ml-auto"
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </div>
              )}
            />

            {enableShadowTls && (
              <>
                <FormField
                  control={form.control}
                  name="shadowTlsPassword"
                  render={({ field }) => (
                    <div className="nd-fld">
                      <span className="nd-fld-lbl">{t('servers.shadowTlsPassword')}</span>
                      <Input
                        type="password"
                        className="mono"
                        placeholder={t('servers.shadowTlsPasswordPlaceholder')}
                        {...field}
                      />
                      <FormMessage className="fld-err" />
                    </div>
                  )}
                />

                <FieldGrid cols={2}>
                  <FormField
                    control={form.control}
                    name="shadowTlsSni"
                    render={({ field }) => (
                      <div className="nd-fld">
                        <span className="nd-fld-lbl">{t('servers.sniValue')}</span>
                        <Input placeholder="www.microsoft.com" {...field} />
                        <FormMessage className="fld-err" />
                      </div>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="shadowTlsPort"
                    render={({ field }) => (
                      <div className="nd-fld">
                        <span className="nd-fld-lbl">
                          {t('servers.realPort')}{' '}
                          <small className="font-medium text-fg-faint">
                            {t('servers.optional')}
                          </small>
                        </span>
                        <Input
                          type="number"
                          placeholder={t('servers.realPortPlaceholder')}
                          {...field}
                          value={field.value ?? ''}
                          onChange={(e) => {
                            // '' 空哨兵（非 undefined）：避免 RHF Controller 编辑态回退旧端口（issue #294 同类）。
                            const val = e.target.value;
                            field.onChange(val ? parseInt(val) : '');
                          }}
                        />
                        <FormMessage className="fld-err" />
                      </div>
                    )}
                  />
                </FieldGrid>

                <FormField
                  control={form.control}
                  name="shadowTlsFingerprint"
                  render={({ field }) => (
                    <div className="nd-fld">
                      <span className="nd-fld-lbl">{t('servers.fingerprint')}</span>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="chrome">Chrome</SelectItem>
                          <SelectItem value="firefox">Firefox</SelectItem>
                          <SelectItem value="safari">Safari</SelectItem>
                          <SelectItem value="edge">Edge</SelectItem>
                          <SelectItem value="ios">iOS</SelectItem>
                          <SelectItem value="android">Android</SelectItem>
                          <SelectItem value="random">{t('servers.random')}</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage className="fld-err" />
                    </div>
                  )}
                />
              </>
            )}
          </div>

          <MultiplexFields
            control={form.control}
            t={t}
            disabled={!!xrayReq}
            disabledReason={t(
              'servers.multiplexXrayConflictSs',
              'Xray-core nodes do not use sing-box multiplex.'
            )}
          />
        </FormSection>
      </form>
    </Form>
  );
}
