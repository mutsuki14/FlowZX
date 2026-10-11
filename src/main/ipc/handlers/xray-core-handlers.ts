/**
 * Xray 内核版本选择 IPC（设置 → 高级 → Xray 卡）。单例注入模式同 core-update-handlers。
 * 渲染端只回传 tag / force，下载 URL 与 sha256 一律由 XrayCoreUpdateService 按 tag 现取（不接受渲染端给的 URL / 摘要）。
 * 进度经 EVENT_XRAY_CORE_INSTALL_PROGRESS 推送（index.ts 注入 ipcEventEmitter.sendToAll）。
 */
import { registerIpcHandler } from '../ipc-handler';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type { XrayCoreUpdateService } from '../../services/XrayCoreUpdateService';
import type {
  XrayInstallResult,
  XrayInstallState,
  XrayReleaseList,
  XrayRestoreResult,
} from '../../../shared/xray-release';

let xrayCoreUpdateService: XrayCoreUpdateService | null = null;

export function setXrayCoreUpdateService(service: XrayCoreUpdateService): void {
  xrayCoreUpdateService = service;
}

function requireService(): XrayCoreUpdateService {
  if (!xrayCoreUpdateService) {
    throw new Error('XrayCoreUpdateService not initialized');
  }
  return xrayCoreUpdateService;
}

export function registerXrayCoreHandlers(): void {
  registerIpcHandler<{ force?: boolean } | undefined, XrayReleaseList>(
    IPC_CHANNELS.XRAY_CORE_LIST_RELEASES,
    async (_, args) => requireService().listReleases({ force: args?.force === true })
  );

  registerIpcHandler<{ tag?: string; force?: boolean } | undefined, XrayInstallResult>(
    IPC_CHANNELS.XRAY_CORE_INSTALL,
    async (_, args) => requireService().install({ tag: args?.tag, force: args?.force === true })
  );

  registerIpcHandler<void, XrayRestoreResult>(IPC_CHANNELS.XRAY_CORE_RESTORE_BUNDLED, async () =>
    requireService().restoreBundled()
  );

  registerIpcHandler<void, XrayInstallState>(IPC_CHANNELS.XRAY_CORE_GET_INSTALL_STATE, async () =>
    requireService().getInstallState()
  );
}
