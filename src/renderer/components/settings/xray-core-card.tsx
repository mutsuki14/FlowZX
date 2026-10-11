/**
 * 设置 · 高级 · Xray 内核卡（`.card.set-card`，紧跟 sing-box 的 CoreManagementCard）：现役版本 / 来源 / 运行态，
 * 从 XTLS 官方 GitHub Releases 选择版本（可含预发布）在线安装，或恢复随包版本。取代原先内核卡里的只读 XrayCoreRow。
 *
 * 契约（见 shared/xray-release.ts 与主进程 XrayCoreUpdateService）：
 *  - 渲染端只回传 tag / force；下载 URL 与 sha256 由主进程按 tag 现取并校验。
 *  - 安装 / 恢复预期内的失败以 `{ ok:false, code }` 返回（不抛），按 code 出文案（xray-version-logic.errorMessageKey）；
 *    CONFIG_TEST_FAILED 弹框展示 `xray run -test` 的错误行，用户确认后 force 重试。该结果存 app store
 *    （pendingXrayConfigTestFail）：安装途中本卡被卸载也不丢，重挂后照常弹框（卸载期间完成则另以 toast 告知）。
 *  - 进度由主进程持有：挂载时 getInstallState 找回 + 订阅 onInstallProgress（载荷 null = 操作结束 → 刷新状态），
 *    故本卡随设置子节卸载重挂也不丢进度。
 *  - 切换 = 代理整体重启（代理在跑时连接会短暂中断，需确认）；代理启停中（proxyPhase ≠ idle）或安装进行中禁用所有操作。
 * 决策逻辑（过滤 / 动作 / 确认理由 / 徽章 / 警示 / 错误码）全在 xray-version-logic.ts（node 单测）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { AlertTriangle, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { openExternal } from '@/bridge/api-wrapper';
import { api } from '@/ipc/api-client';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/app-store';
import type {
  XrayInstallProgress,
  XrayRelease,
  XrayReleaseList,
} from '../../../shared/xray-release';
import { Srow, Swt } from './conduit-controls';
import {
  clipDetail,
  composeOptionLabel,
  confirmReasonKey,
  confirmsNeeded,
  errorMessageKey,
  errorShowsDetail,
  filterReleases,
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
  type XrayConfirmReason,
  type XrayStatusNoteKind,
} from './xray-version-logic';

type XrayStatus = Awaited<ReturnType<typeof api.proxy.getXrayStatus>>;

/** 待确认的操作：install = 按 tag 在线安装；restore = 恢复随包版本（下拉选中随包版本时的「切换」也走这里）。 */
type PendingConfirm =
  | { kind: 'install'; release: XrayRelease; reasons: XrayConfirmReason[] }
  | { kind: 'restore'; reasons: XrayConfirmReason[] };

interface FailureLike {
  code: string;
  detail?: string;
  rolledBack?: boolean;
}

export function XrayCoreCard() {
  const { t } = useTranslation();
  const config = useAppStore((s) => s.config);
  const saveConfig = useAppStore((s) => s.saveConfig);
  // 代理启停会改变 sidecar 运行态 → 随 proxyPhase 刷新；启停中禁止切换（主进程也会以 PROXY_BUSY 拒绝）。
  const proxyPhase = useAppStore((s) => s.proxyPhase);
  const proxyRunning = useAppStore((s) => s.connectionStatus?.proxyCore.running === true);

  const [status, setStatus] = useState<XrayStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [list, setList] = useState<XrayReleaseList | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<'RATE_LIMITED' | 'NETWORK' | null>(null);
  const [selectedTag, setSelectedTag] = useState('');
  // 主进程推送的进行中进度（null = 空闲）；requesting 覆盖本卡发起后、首个进度事件到达前的窗口。
  const [progress, setProgress] = useState<XrayInstallProgress | null>(null);
  const [requesting, setRequesting] = useState<'install' | 'restore' | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  // CONFIG_TEST_FAILED 待决结果放 store（安装途中切走设置子节会卸载本卡，本地 state 会丢）。
  const configTestFail = useAppStore((s) => s.pendingXrayConfigTestFail);
  const setConfigTestFail = useAppStore((s) => s.setPendingXrayConfigTestFail);
  // 安装结束时本卡是否仍挂载：未挂载 → CONFIG_TEST_FAILED 另以 toast 告知（弹框等重挂后再出）。
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshStatus = async () => {
    setStatusLoading(true);
    try {
      setStatus(await api.proxy.getXrayStatus());
    } catch {
      setStatus(null);
    } finally {
      setStatusLoading(false);
    }
  };

  // force=true：用户点「刷新列表」（绕过主进程 10 分钟缓存，失败 toast）；挂载时走缓存、失败只在卡内提示。
  const loadList = async (force: boolean) => {
    setListLoading(true);
    try {
      setList(await api.xrayCore.listReleases(force));
      setListError(null);
    } catch (error) {
      const code = listErrorCode(error);
      setListError(code); // 保留上次成功的列表
      if (force) {
        toast.error(t('settings.xrayCore.listFail'), { description: t(errorMessageKey(code)) });
      }
    } finally {
      setListLoading(false);
    }
  };

  useEffect(() => {
    void refreshStatus();
  }, [proxyPhase]);

  useEffect(() => {
    // 先订阅再取快照：快照返回前若已收到事件，以事件为准（快照可能已过时）。
    let gotEvent = false;
    const unsubscribe = api.xrayCore.onInstallProgress((p) => {
      gotEvent = true;
      setProgress(p);
      if (p === null) void refreshStatus(); // 操作结束（含卸载期间 / 其它窗口发起的）→ 刷新版本与来源
    });
    void api.xrayCore
      .getInstallState()
      .then((s) => {
        if (!gotEvent) setProgress(s.installing);
      })
      .catch(() => {});
    void loadList(false);
    return () => unsubscribe();
  }, []);

  const includePrerelease = config?.xrayIncludePrerelease === true;
  const filtered = useMemo(
    () => filterReleases(list?.releases ?? [], includePrerelease, status),
    [list, includePrerelease, status]
  );
  // 选中项不入 effect：原选中被过滤掉（如关掉预发布）时即时回落到最新一项。
  const effectiveTag = pickSelection(filtered, selectedTag);
  const selected = filtered.find((r) => r.tag === effectiveTag) ?? null;
  const action = selected ? releaseAction(selected, status) : null;

  const busy = progress !== null || requesting !== null;
  const actionsDisabled = busy || proxyPhase !== 'idle' || !status;
  const installBusy = requesting === 'install' || progress?.kind === 'install';
  const restoreBusy = requesting === 'restore' || progress?.kind === 'restore';
  const bundledVersion = status?.bundledVersion ?? list?.bundledVersion ?? '';
  const minVersion = status?.minVersion ?? list?.minVersion ?? '';

  const failureDescription = (res: FailureLike) => {
    const msg = t(errorMessageKey(res.code, res.rolledBack), { min: minVersion });
    const detail = errorShowsDetail(res.code) ? clipDetail(res.detail) : '';
    if (!detail) return msg;
    return (
      <>
        <div>{msg}</div>
        <div
          className="mono"
          dir="ltr"
          style={{ fontSize: 11, opacity: 0.85, wordBreak: 'break-all' }}
        >
          {detail}
        </div>
      </>
    );
  };

  const runInstall = async (release: XrayRelease, force: boolean) => {
    setConfigTestFail(null); // 新一次安装取代任何待决的 CONFIG_TEST_FAILED
    setRequesting('install');
    const toastId = toast.loading(t('settings.xrayCore.installing', { version: release.version }), {
      description: t('settings.about.doNotClose'),
    });
    try {
      const res = await api.xrayCore.install(release.tag, force);
      if (res.ok) {
        toast.success(t('settings.xrayCore.installSuccess', { version: res.version }), {
          id: toastId,
          description: res.restarted
            ? t('settings.xrayCore.restartedDesc')
            : t('settings.xrayCore.nextStartDesc'),
        });
      } else if (res.code === 'CONFIG_TEST_FAILED' && !force) {
        // 新核不认当前配置：未切换。弹框给出 Xray 的错误行，由用户决定是否强行切换。结果进 store：本卡此刻若已
        // 卸载（切走了设置子节），弹框在重挂时出现，并以 toast 先告知结果。
        if (mountedRef.current) {
          toast.dismiss(toastId);
        } else {
          toast.error(t('settings.xrayCore.installFail'), {
            id: toastId,
            description: t(errorMessageKey(res.code)),
          });
        }
        setConfigTestFail({ release, detail: res.detail ?? '' });
      } else {
        toast.error(t('settings.xrayCore.installFail'), {
          id: toastId,
          description: failureDescription(res),
        });
      }
    } catch (error) {
      toast.error(t('settings.xrayCore.installFail'), {
        id: toastId,
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRequesting(null);
      void refreshStatus();
    }
  };

  const runRestore = async () => {
    setRequesting('restore');
    const toastId = toast.loading(t('settings.xrayCore.restoring'), {
      description: t('settings.about.doNotClose'),
    });
    try {
      const res = await api.xrayCore.restoreBundled();
      if (res.ok) {
        toast.success(t('settings.xrayCore.restoreSuccess', { version: bundledVersion }), {
          id: toastId,
          description: res.restarted
            ? t('settings.xrayCore.restartedDesc')
            : t('settings.xrayCore.nextStartDesc'),
        });
      } else {
        toast.error(t('settings.xrayCore.restoreFail'), {
          id: toastId,
          description: failureDescription(res),
        });
      }
    } catch (error) {
      toast.error(t('settings.xrayCore.restoreFail'), {
        id: toastId,
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRequesting(null);
      void refreshStatus();
    }
  };

  const handleAction = () => {
    if (!selected || !status || actionsDisabled) return;
    const act = releaseAction(selected, status);
    if (act === 'current') return;
    if (act === 'switch') {
      setConfirm({ kind: 'restore', reasons: restoreConfirms(status, proxyRunning) });
      return;
    }
    const reasons = confirmsNeeded(selected, status, proxyRunning);
    if (reasons.length > 0) setConfirm({ kind: 'install', release: selected, reasons });
    else void runInstall(selected, false);
  };

  const handleConfirm = () => {
    const c = confirm;
    setConfirm(null);
    if (!c) return;
    if (c.kind === 'install') void runInstall(c.release, false);
    else void runRestore();
  };

  const handleForceInstall = () => {
    const target = configTestFail;
    setConfigTestFail(null);
    if (target) void runInstall(target.release, true);
  };

  const handleTogglePrerelease = (checked: boolean) => {
    if (!config) return;
    saveConfig({ ...config, xrayIncludePrerelease: checked }).catch(() =>
      toast.error(t('common.saveFailed'))
    );
  };

  const runPill = status ? runStatePill(status) : null;
  const srcPill = status ? sourcePill(status) : null;
  const notes = statusNotes(status);
  const optionSuffix = {
    prerelease: t('settings.xrayCore.optionPrerelease'),
    current: t('settings.xrayCore.optionCurrent'),
    bundled: t('settings.xrayCore.optionBundled'),
  };
  const selectedDate = selected ? releaseDate(selected.publishedAt) : null;

  const noteText = (kind: XrayStatusNoteKind): string => {
    switch (kind) {
      case 'custom':
        return t('settings.xrayCore.customNote', { dir: status?.overrideDir ?? '' });
      case 'belowMinimum':
        return t('settings.xrayCore.belowMinimumNote', {
          version: status?.version ?? '',
          min: minVersion,
        });
      case 'olderThanBundled':
        return t('settings.xrayCore.olderThanBundledNote', {
          version: status?.version ?? '',
          bundled: bundledVersion,
        });
    }
  };

  const actionLabel =
    action === 'current'
      ? t('settings.xrayCore.isCurrent')
      : action === 'switch'
        ? t('settings.xrayCore.switch')
        : t('settings.xrayCore.install');

  const listPlaceholder = listLoading
    ? t('settings.xrayCore.loadingList')
    : listError && !list
      ? t('settings.xrayCore.listFail')
      : t('settings.xrayCore.noReleases');

  const confirmVersion = confirm?.kind === 'install' ? confirm.release.version : bundledVersion;
  const confirmAnyway =
    confirm?.kind === 'install' &&
    confirm.reasons.some((r) => r === 'prerelease' || r === 'downgrade');

  return (
    <div className="card set-card">
      <div className="set-h">
        <b>{t('settings.xrayCore.title')}</b>
        <small>{t('settings.xrayCore.cardSub')}</small>
      </div>

      <Srow
        label={
          <>
            {t('settings.xrayCore.currentVersion')}
            {runPill && (
              <span className={cn('pill', runPill.cls)}>
                {runPill.n !== undefined ? t(runPill.key, { n: runPill.n }) : t(runPill.key)}
              </span>
            )}
            {srcPill && <span className={cn('pill', srcPill.cls)}>{t(srcPill.key)}</span>}
          </>
        }
        desc={
          status
            ? t('settings.xrayCore.versionDesc', {
                bundled: status.bundledVersion,
                min: status.minVersion,
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
          onClick={() => void refreshStatus()}
          disabled={statusLoading}
          aria-label={t('settings.xrayCore.refresh')}
          title={t('settings.xrayCore.refresh')}
        >
          {statusLoading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
        </button>
      </Srow>

      {/* 自放文件 / 低于最低支持版本 / 在线安装的版本旧于随包（App 升级后） */}
      {notes.length > 0 && (
        <div className="set-pad" style={{ paddingTop: 0, gap: 8 }}>
          {notes.map((kind) => (
            <div key={kind} className="set-note warn">
              <AlertTriangle />
              <span>{noteText(kind)}</span>
            </div>
          ))}
        </div>
      )}

      <Srow
        label={t('settings.xrayCore.includePrerelease')}
        desc={t('settings.xrayCore.includePrereleaseDesc')}
      >
        <Swt
          checked={includePrerelease}
          onChange={handleTogglePrerelease}
          disabled={!config}
          label={t('settings.xrayCore.includePrerelease')}
        />
      </Srow>

      <Srow
        stacked
        label={t('settings.xrayCore.selectVersion')}
        desc={minVersion ? t('settings.xrayCore.desc', { min: minVersion }) : undefined}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <div className="sel" style={{ flex: '1 1 240px', minWidth: 0 }}>
              <select
                aria-label={t('settings.xrayCore.selectVersion')}
                style={{ width: '100%' }}
                value={effectiveTag}
                onChange={(e) => setSelectedTag(e.target.value)}
                disabled={busy || filtered.length === 0}
              >
                {filtered.length === 0 && <option value="">{listPlaceholder}</option>}
                {filtered.map((r) => (
                  <option key={r.tag} value={r.tag}>
                    {composeOptionLabel(optionLabelParts(r, status), optionSuffix)}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="btn flow sm"
              onClick={handleAction}
              disabled={actionsDisabled || !selected || action === 'current'}
            >
              {installBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {actionLabel}
            </button>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => void loadList(true)}
              disabled={listLoading || busy}
            >
              {listLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('settings.xrayCore.refreshList')}
            </button>
          </div>

          {selected && (
            <div
              className="ng-hint"
              style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}
            >
              <span className={cn('pill', selected.prerelease ? 'warn' : 'ok')}>
                {selected.prerelease
                  ? t('settings.xrayCore.prerelease')
                  : t('settings.xrayCore.stable')}
              </span>
              {selectedDate && <span className="mono tnum">{selectedDate}</span>}
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => void openExternal(selected.htmlUrl)}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {t('settings.xrayCore.releaseNotes')}
              </button>
            </div>
          )}

          {listError && (
            <div className="ng-hint ng-warn">
              {t('settings.xrayCore.listFail')} · {t(errorMessageKey(listError))}
            </div>
          )}
        </div>
      </Srow>

      {/* 安装 / 恢复进度（主进程持有，卸载重挂后经 getInstallState 找回） */}
      {progress && (
        <>
          <div className="set-hair" />
          <div className="set-pad">
            <div className="srow-desc" style={{ fontSize: 12 }}>
              {t(phaseKey(progress), { tag: progress.tag })}
              {progress.phase === 'downloading' && typeof progress.percent === 'number' && (
                <>
                  {' '}
                  <span className="mono tnum">{progressBarPercent(progress)}%</span>
                </>
              )}
            </div>
            <div className="bar">
              <i style={{ width: `${progressBarPercent(progress)}%` }} />
            </div>
          </div>
        </>
      )}

      {status && status.source !== 'bundled' && (
        <Srow
          label={t('settings.xrayCore.restoreRow')}
          desc={t('settings.xrayCore.restoreRowDesc')}
        >
          <button
            type="button"
            className="btn ghost sm"
            onClick={() =>
              setConfirm({ kind: 'restore', reasons: restoreConfirms(status, proxyRunning) })
            }
            disabled={actionsDisabled}
          >
            {restoreBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('settings.xrayCore.restoreBundled', { version: status.bundledVersion })}
          </button>
        </Srow>
      )}

      {/* 安装 / 恢复确认（预发布 / 旧于随包 / 替换自定义文件 / 代理将重启，按需逐条列出） */}
      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === 'install'
                ? t('settings.xrayCore.confirmInstallTitle', { version: confirmVersion })
                : t('settings.xrayCore.restoreConfirmTitle', { version: confirmVersion })}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  {confirm?.kind === 'install'
                    ? t('settings.xrayCore.confirmInstallDesc', { version: confirmVersion })
                    : t('settings.xrayCore.restoreConfirmDesc')}
                </p>
                {confirm && confirm.reasons.length > 0 && (
                  <ul className="list-disc space-y-1 ps-5">
                    {confirm.reasons.map((r) => (
                      <li key={r}>
                        {t(confirmReasonKey(r), {
                          version: confirmVersion,
                          bundled: bundledVersion,
                        })}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirm}>
              {confirm?.kind === 'restore'
                ? t('settings.xrayCore.restoreConfirmBtn')
                : confirmAnyway
                  ? t('settings.xrayCore.confirmAnywayBtn')
                  : t('settings.xrayCore.confirmInstallBtn')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 新核 `run -test` 当前配置失败：未切换；展示 Xray 的错误行，确认后 force 重试 */}
      <AlertDialog
        open={configTestFail !== null}
        onOpenChange={(open) => {
          if (!open) setConfigTestFail(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.xrayCore.configTestTitle')}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  {t('settings.xrayCore.configTestDesc', {
                    version: configTestFail?.release.version ?? '',
                  })}
                </p>
                {configTestFail?.detail && (
                  <pre
                    className="mono"
                    dir="ltr"
                    style={{
                      maxHeight: 180,
                      overflow: 'auto',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      fontSize: 11,
                      lineHeight: 1.5,
                      padding: '8px 10px',
                      borderRadius: 8,
                      background: 'hsl(var(--surface-2))',
                      color: 'hsl(var(--fg-dim))',
                    }}
                  >
                    {summarizeConfigTestDetail(configTestFail.detail)}
                  </pre>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleForceInstall}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('settings.xrayCore.configTestForceBtn')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
