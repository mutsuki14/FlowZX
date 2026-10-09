/**
 * 设置 · 内核卡里的 Xray sidecar 状态行：版本 / 运行态 / 用户覆盖目录。
 * Xray 随包内置、以普通用户权限运行，仅承载 XHTTP / VLESS Encryption 等 Xray 独有协议组合（见 docs/XRAY.md）；
 * 无在线更新——要换 Xray 版本，把 xray 可执行文件放进覆盖目录即可（存在即优先使用）。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { api } from '@/ipc/api-client';
import { useAppStore } from '@/store/app-store';
import { Srow } from './conduit-controls';

type XrayStatus = Awaited<ReturnType<typeof api.proxy.getXrayStatus>>;

export function XrayCoreRow() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<XrayStatus | null>(null);
  // 代理启停会改变 sidecar 运行态 → 随 proxyPhase 刷新。
  const proxyPhase = useAppStore((s) => s.proxyPhase);

  const refresh = () => {
    void api.proxy
      .getXrayStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  };
  useEffect(refresh, [proxyPhase]);

  const pill = !status
    ? null
    : !status.available
      ? { cls: 'warn', label: t('settings.xrayCore.missing', 'Missing') }
      : status.running
        ? {
            cls: 'ok',
            label: t('settings.xrayCore.running', {
              defaultValue: 'Running · {{n}} nodes',
              n: status.nodes,
            }),
          }
        : { cls: 'idle', label: t('settings.xrayCore.idle', 'Idle') };

  return (
    <Srow
      label={
        <>
          {t('settings.xrayCore.title', 'Xray core (sidecar)')}
          {pill && <span className={`pill ${pill.cls}`}>{pill.label}</span>}
        </>
      }
      desc={
        status
          ? t('settings.xrayCore.desc', {
              defaultValue:
                'Runs Xray-only nodes (XHTTP, VLESS Encryption…) alongside sing-box. To use another Xray build, put the xray binary in {{dir}}.',
              dir: status.overrideDir,
            })
          : undefined
      }
    >
      <span className="mono tnum" style={{ fontSize: 13, fontWeight: 640 }} title={status?.path}>
        {status?.version ?? '—'}
      </span>
      <button
        type="button"
        className="btn ghost sm"
        onClick={refresh}
        aria-label={t('settings.xrayCore.refresh', 'Refresh')}
      >
        <RefreshCw className="h-3.5 w-3.5" />
      </button>
    </Srow>
  );
}
