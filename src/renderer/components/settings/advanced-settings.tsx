import { BackupRestoreSection } from './backup-restore-section';
import { CoreVersionBanner } from './core-version-banner';
import { CoreManagementCard } from './core-management-card';
import { SingboxDashboardSection } from './singbox-dashboard-section';
import { XrayCoreCard } from './xray-core-card';

/**
 * 内核管理从「关于」迁入并置顶（C9/M3：破坏性运维不藏在只读关于页，且是高频运维入口）；Xray 内核卡紧随其后
 * （版本选择 / 预发布 / 恢复随包，与 sing-box 卡分开：两核的来源、更新链路与危险区互不相干）；数据备份置末（低频）；
 * 日志/诊断在「日志」页。
 */
export function AdvancedSettings() {
  return (
    <div className="set-panel" data-set-panel="advanced">
      <CoreVersionBanner />
      <CoreManagementCard />
      <XrayCoreCard />
      <SingboxDashboardSection />
      <BackupRestoreSection />
    </div>
  );
}
