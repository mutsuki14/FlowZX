# 发布指南

**简体中文** · [English](RELEASE.en.md)

本文说明如何发布 FlowZX 新版本。发布由 GitHub Actions 的 Release 工作流（`.github/workflows/release.yml`）完成：推送 `v*` tag，或在 `main` 上手动运行该工作流。它在三个平台上打包，并直接发布 GitHub Release。本地打包只用于验证，不会发布。

## 前置要求

- **GitHub Actions 已启用**：本仓库已启用；若在 Settings → Actions → General 中被禁用，工作流不会运行。Release 使用内置的 `GITHUB_TOKEN` 创建 tag 和 Release（工作流已声明 `contents: write`），无需配置 secret。
- **推送权限**：能推送到 `main` 和推送 tag。
- **Node.js 26**：与 CI 一致。
- **Go 1.24 及以上**：本地打包时用于编译提权助手；缺少时跳过，打出的包不含提权助手。CI 中已提供 Go。

## 工作流

| 工作流 | 触发条件 | 作用 |
|---|---|---|
| CI（`ci.yml`） | 推送到 `main`、向 `main` 发起的 PR、手动运行 | 在 macOS 与 Windows 上运行 lint、单元测试和构建 |
| Package（`package.yml`） | 同上，但推送和 PR 只在改动涉及打包输入时触发（`package.json`、`package-lock.json`、`electron-builder.json`、`scripts/`、`helper*/`、`build/`、`resources/`、`src/shared/core-manifest.json`、`.github/workflows/`） | PR：`electron-builder --dir` 冒烟；推送 / 手动：Windows 与 macOS 完整打包，并上传 Windows 安装包（保留 3 天） |
| Release（`release.yml`） | 推送 `v*` tag；在 `main` 上手动运行 | 在 Windows / macOS / Linux 上打包并发布 GitHub Release |

## 发布步骤

1. **更新版本号**。下面的命令同时更新 `package.json` 与 `package-lock.json`，不会创建 commit 或 tag：

   ```bash
   npm version patch --no-git-tag-version   # 或 minor / major / 指定版本号
   ```

2. **编写发布说明** `docs/releases/v<版本>.md`，格式参照已有文件（先中文、后英文）。Release 正文取自这个文件，后面接 GitHub 自动生成的 Release Notes；文件不存在时只有自动生成的部分。

3. **提交并推送到 `main`**，确认 CI 通过（改动涉及打包输入时 Package 也会运行）。

4. **触发 Release**，二选一：
   - **推送 tag**：在 `main` 上运行 `npm run release:tag`。`scripts/push-release.js` 读取 `package.json` 的版本号，创建附注 tag `v<版本>` 并推送到 `origin`。`npm run release:tag -- -y` 跳过确认；`npm run release:tag -- -u` 删除并重新推送已存在的同名 tag；`npm run release:tag:update` 等同于 `-- -y -u`。tag 必须与 `package.json` 版本一致：不一致时工作流只给出警告，安装包文件名仍按 `package.json`；安装后应用版本仍是 `package.json` 的版本，而应用内更新按 tag 判断，会反复提示同一「新版本」。
   - **手动运行**：在 Actions 页选择 Release →「Run workflow」，分支选 `main`（也可经 API 触发 `workflow_dispatch`）。版本取自 `package.json`，构建完成后在该 commit 上创建 tag `v<版本>` 并发布，这个 tag 不会再次触发 Release。该 tag 已存在且指向其他 commit 时工作流会失败，需要先升版本号；指向同一 commit 时视为重跑。

5. **检查 Release**：Releases 页应出现 `Release <版本>`（非 draft、非 prerelease），并包含 6 个安装包：

   | 平台 | 文件 |
   |---|---|
   | Windows x64 | `FlowZ-<版本>-win-x64-setup.exe`、`FlowZ-<版本>-win-x64-portable.exe` |
   | macOS | `FlowZ-<版本>-mac-arm64.dmg`、`FlowZ-<版本>-mac-x64.dmg` |
   | Linux x86_64 | `FlowZ-<版本>-linux-x86_64.AppImage`、`FlowZ-<版本>-linux-amd64.deb` |

   应用内的「检查更新」读取本仓库最近发布的非 prerelease Release，以 tag 判断版本，并按文件名挑选适合当前平台和安装形式的安装包，因此不要改动安装包的命名。

## Release 工作流的步骤

- **meta**：确定版本号。tag 触发时取 tag 名；手动触发时取 `package.json`，并检查分支是否为 `main`、同名 tag 是否已指向其他 commit。
- **release**：在 `windows-2022`、`macos-14`、`ubuntu-latest` 上并行执行 `npm ci`、`npm run build` 和 `npm run package:<平台>`。设置了 `REQUIRE_HELPER=1`，缺少 Go 时直接失败，不会发布不含提权助手的包。macOS 上再把 arm64 与 x64 的 `FlowZ.app` 分别用 `codesign` 做 ad-hoc 签名，并用 `hdiutil` 打成 DMG（内附首次打开说明），缺少任一架构即失败。
- **create-release**：用 `softprops/action-gh-release` 发布 `v<版本>` 的 Release 并上传全部安装包。

## 本地打包（只验证，不发布）

```bash
npm run dist:win     # Windows 安装版 + 便携版（x64）
npm run dist:mac     # macOS arm64 + x64 的 FlowZ.app（DMG 只在 CI 中生成）
npm run dist:linux   # Linux AppImage + deb（x64）
```

`dist:*` 带 `--publish never`，产物在 `dist-package/`，请在对应系统上打包。打包前依次执行 `build:helper`、`fetch:core`、`test:core-gate`、`fetch:cronet`（仅 Windows / Linux）、`fetch:dashboard` 和 `build`。

sing-box、Xray、cronet 与面板都不入库，构建时下载；前三者按 `src/shared/core-manifest.json` 中的 SHA-256 校验。更换内核版本时修改该文件的版本号与 SHA-256（sing-box：`bundledCoreVersion`、`coreArchiveSha256`、`coreBinarySha256`；Xray：`bundledXrayVersion`、`xrayArchiveSha256`、`xrayBinarySha256`），再运行 `npm run fetch:core` 和 `npm run test:core-gate`。

## 版本号

遵循[语义化版本](https://semver.org/lang/zh-CN/)。`package.json` 的 `version` 不带 `v`，tag 形如 `v4.4.1`。

## 故障排除

| 问题 | 处理 |
|---|---|
| 推送 tag 后 Release 没有运行 | 确认 tag 以 `v` 开头、仓库的 Actions 未被禁用；之后在 `main` 上手动运行 Release（tag 指向当前 commit 时视为重跑），或用 `npm run release:tag -- -u` 重新推送 tag |
| 手动运行失败：只允许在 `main` 上触发 | 运行时分支选择 `main` |
| 手动运行失败：tag 已存在且指向其他 commit | 升 `package.json` 版本号后重新发布 |
| `release:tag` 提示远程 tag 已存在 | 升版本号后重新发布。`-u` 会删除并重推同名 tag，只应在该版本尚未发布时使用 |
| Release 缺少某个 macOS 架构的 DMG | 「Create DMG」步骤会报错失败；检查 `package:mac` 是否产出了 arm64 与 x64 两个 `FlowZ.app` |
| 安装时提示提权助手二进制缺失 | 打包时缺少 Go，安装 Go 后重新打包 |
| 构建失败 | 用 `npm ci` 重装依赖；确认能访问 GitHub 与 `proxy.golang.org`（`fetch:*` 需要联网）；按平台查看 CI 日志 |
