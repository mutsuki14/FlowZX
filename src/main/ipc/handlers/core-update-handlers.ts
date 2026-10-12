import { registerIpcHandler } from '../ipc-handler';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import { CoreUpdateService } from '../../services/CoreUpdateService';
import { LogManager } from '../../services/LogManager';
import type {
  SingboxInstallResult,
  SingboxInstallState,
  SingboxReleaseList,
} from '../../../shared/singbox-release';

let coreUpdateService: CoreUpdateService | null = null;

export function setCoreUpdateService(service: CoreUpdateService, _logger: LogManager) {
  coreUpdateService = service;
}

export function registerCoreUpdateHandlers() {
  registerIpcHandler(IPC_CHANNELS.CORE_UPDATE_CHECK, async () => {
    if (!coreUpdateService) {
      throw new Error('CoreUpdateService not initialized');
    }
    return await coreUpdateService.checkUpdate();
  });

  registerIpcHandler(IPC_CHANNELS.CORE_UPDATE_RUN, async (_, downloadUrl: string) => {
    if (!coreUpdateService) {
      throw new Error('CoreUpdateService not initialized');
    }
    return await coreUpdateService.updateCore(downloadUrl);
  });

  registerIpcHandler(IPC_CHANNELS.CORE_GET_VERSION_INFO, async () => {
    if (!coreUpdateService) {
      throw new Error('CoreUpdateService not initialized');
    }
    return await coreUpdateService.getVersionInfo();
  });

  registerIpcHandler(IPC_CHANNELS.CORE_ROLLBACK, async () => {
    if (!coreUpdateService) {
      throw new Error('CoreUpdateService not initialized');
    }
    await coreUpdateService.rollbackCore();
    return true;
  });

  registerIpcHandler(IPC_CHANNELS.CORE_UPDATE_ACK_VERSION_CHANGE, async () => {
    if (!coreUpdateService) {
      throw new Error('CoreUpdateService not initialized');
    }
    coreUpdateService.ackPendingChangeNotice();
    return true;
  });

  registerIpcHandler(
    IPC_CHANNELS.CORE_REPLACE_MANUAL,
    async (_, opts?: { filePath?: string; force?: boolean }) => {
      if (!coreUpdateService) {
        throw new Error('CoreUpdateService not initialized');
      }
      return await coreUpdateService.replaceManualCore(opts);
    }
  );

  // 重置内核到出厂：把随 App 出厂的 bundled 核重新落位回受保护目录/bundle（force 跳过同版本短路）。
  // 版本选择的「恢复随包」同经此处：进度经 EVENT_CORE_INSTALL_PROGRESS（kind 'reset'）推送；已有内核操作在飞 → code BUSY / XRAY_BUSY。
  registerIpcHandler(IPC_CHANNELS.CORE_RESET_FACTORY, async () => {
    if (!coreUpdateService) {
      throw new Error('CoreUpdateService not initialized');
    }
    return await coreUpdateService.resetCoreToFactory();
  });

  // 内核自动更新状态（lastCheckAt / staged 待生效 / 跨带提示 / 固定版本）
  registerIpcHandler(IPC_CHANNELS.CORE_UPDATE_GET_AUTO_STATUS, async () => {
    if (!coreUpdateService) {
      throw new Error('CoreUpdateService not initialized');
    }
    return await coreUpdateService.getAutoStatus();
  });

  // 用户点「立即应用」：停代理→换核→重启（唯一允许主动断流）
  registerIpcHandler(IPC_CHANNELS.CORE_UPDATE_APPLY_STAGED, async () => {
    if (!coreUpdateService) {
      throw new Error('CoreUpdateService not initialized');
    }
    return await coreUpdateService.applyStagedNow();
  });

  // sing-box 版本选择（含预发布）：渲染端只回传 tag / force / pin（单一 args 对象），下载 URL 与 sha256 一律由
  // CoreUpdateService.installTag 按 tag 现取（不接受渲染端给的 URL / 摘要）。进度经 EVENT_CORE_INSTALL_PROGRESS 推送。
  registerIpcHandler<{ force?: boolean } | undefined, SingboxReleaseList>(
    IPC_CHANNELS.CORE_LIST_RELEASES,
    async (_, args) => {
      if (!coreUpdateService) {
        throw new Error('CoreUpdateService not initialized');
      }
      return await coreUpdateService.listReleases({ force: args?.force === true });
    }
  );

  registerIpcHandler<
    { tag?: string; force?: boolean; pin?: boolean } | undefined,
    SingboxInstallResult
  >(IPC_CHANNELS.CORE_INSTALL_TAG, async (_, args) => {
    if (!coreUpdateService) {
      throw new Error('CoreUpdateService not initialized');
    }
    return await coreUpdateService.installTag({
      tag: args?.tag,
      force: args?.force === true,
      pin: args?.pin === true,
    });
  });

  registerIpcHandler<void, SingboxInstallState>(IPC_CHANNELS.CORE_GET_INSTALL_STATE, async () => {
    if (!coreUpdateService) {
      throw new Error('CoreUpdateService not initialized');
    }
    return coreUpdateService.getInstallState();
  });

  // 取消固定版本（恢复自动更新）
  registerIpcHandler<void, boolean>(IPC_CHANNELS.CORE_CLEAR_PIN, async () => {
    if (!coreUpdateService) {
      throw new Error('CoreUpdateService not initialized');
    }
    await coreUpdateService.clearPin();
    return true;
  });
}
