/**
 * 本分支（FlowZX）的 GitHub 仓库坐标单一真值：App 自更新（UpdateService 查 releases / 打开 release 页）、
 * 「关于」页仓库链接与「报告问题」、托盘 releases 兜底链接均由此派生。
 * FlowZX 安装包内置 Xray 内核，上游 dododook/FlowZ 的安装包不含 → 绝不能把上游 release 当作本分支的「更新」推给用户。
 * 改仓库地址只改这里（scripts/push-release.js 是独立 CommonJS 脚本，有一份同值兜底常量，需同步）。
 */
export const REPO_OWNER = 'mutsuki14';
export const REPO_NAME = 'FlowZX';
export const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;
export const REPO_RELEASES_URL = `${REPO_URL}/releases`;
