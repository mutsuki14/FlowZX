# Xray 内核（sidecar）—— 在 FlowZX 中使用 Xray 独有协议组合

FlowZX 在 sing-box 主核之外**随包内置 Xray-core**，专门承载 sing-box 不支持的 Xray 独有协议组合，例如：

| 组合 | 说明 |
| --- | --- |
| **VLESS + XHTTP + REALITY + ENC** | XHTTP 传输 + REALITY 伪装 + VLESS Encryption（`mlkem768x25519plus.*`，后量子） |
| VLESS + RAW + REALITY + Vision + ENC | 经典 Vision + REALITY 叠加 VLESS Encryption |
| VLESS / VMess / Trojan + XHTTP + TLS | XHTTP 走 CDN（packet-up / stream-up / stream-one / auto），支持 `extra`（xmux、`downloadSettings` 上下行分离…） |
| REALITY + ML-DSA-65 | 后量子 REALITY 证书验证（分享链 `pqv`） |
| `xtls-rprx-vision-udp443` | sing-box 仅支持 `xtls-rprx-vision` |
| 任意 Xray outbound JSON | 「自定义出站 JSON」选 **Xray** 内核：mKCP + finalmask、hysteria、wireguard… 原样运行 |

其余节点（含普通 VLESS-REALITY-Vision、Hysteria2、TUIC、WireGuard…）照旧由 sing-box 承载，行为不变。

## 架构

```
应用 ─▶ sing-box（TUN / 系统代理 / 分流 / DNS / 管理 API，主核不变）
          │ proxy-selector / rule-sel 选中 Xray 节点
          ▼  socks（127.0.0.1:<该节点专属端口> + 随机凭据）
        Xray sidecar（普通用户权限）
          │ 节点 outbound（XHTTP / REALITY / ENC …）
          │ streamSettings.sockopt.dialerProxy
          ▼  socks（127.0.0.1:<xray-dial-in> + 凭据）
        sing-box xray-dial-in ──auth_user──▶ xray-dial-direct（直连，节点域名用 sing-box 节点解析器）
                                        └──▶ 前置代理节点（detour / 代理链）
```

设计要点：

- **sing-box 仍是唯一主核**：TUN、分流规则、DNS / FakeIP、热切换、测速探测池、统计、管理 API 全部沿用；Xray 节点在
  sing-box 里只是一个 socks 出站，所以 **selector 热切换、规则指定节点、测速、出口 IP 检测**都与原生节点一致。
- **Xray 的出网拨号回环到 sing-box**（`dialerProxy` → `xray-dial-in`）：loopback 不进 TUN，零回环；节点服务器域名由
  sing-box 的节点解析器（多上游 race / 关 IPv6 的 AAAA 放宽）解析；物理网卡绑定、macOS VPN 路由跟随等沿用 sing-box。
- **前置代理（代理链）**：Xray 节点设置了 detour 时，Xray 的拨号经 sing-box 按 `auth_user` 钉死到前置节点（可以是
  sing-box 原生节点，也可以是另一个 Xray 节点）。前置节点不可用时 fail-closed（reject），**绝不静默改直连**。
- **按入站端口路由**：每个 Xray 节点一个独立 loopback socks 入站（端口 + 随机密码）。实测 Xray 的 socks UDP 关联包
  不携带用户身份，按用户名路由对 UDP 失效，故按端口分流，TCP / UDP 一致。
- **生命周期绑定主核**：起核前生成 Xray 配置并 `xray run -test` 校验（报错节点按 tag 归因后剔除，选中节点报错则
  终止并给出原因），Xray 先于 sing-box 启动；停核即停 Xray。Xray 意外退出在 60s 内自动重拉至多 3 次（sing-box
  不受影响），超出则提示。上次会话崩溃残留的 Xray 进程在启动时按 PID 文件 + 进程名回收。
- **测速**：主核运行时经主核探测池测 Xray 节点（与原生节点同路径）；主核未运行时起一个临时 Xray + 临时 sing-box。

## 使用

1. **导入**：直接粘贴 / 订阅分享链即可，例如

   ```
   vless://<uuid>@example.com:443?encryption=mlkem768x25519plus.native.0rtt.<key>&security=reality&type=xhttp&path=%2Fxh&mode=auto&sni=www.microsoft.com&fp=chrome&pbk=<pbk>&sid=<sid>#XHTTP-REALITY-ENC
   ```

   支持的分享链参数：`type=xhttp|splithttp`、`path`、`host`、`mode`、`extra`（URL 编码 JSON）、`encryption`、
   `flow=xtls-rprx-vision-udp443`、`pbk`/`sid`/`spx`/`pqv`、`pcs`（证书指纹）、`ech`。Clash（mihomo）的
   `network: xhttp` + `xhttp-opts` + `encryption` 与 Xray JSON 配置导入同样支持；Xray JSON 中结构化表单无法表达的
   outbound（mKCP、finalmask、mux、sockopt、wireguard / hysteria 等）会以「自定义 Xray JSON」原样导入。
2. **手动添加 / 编辑**：VLESS / VMess / Trojan 表单的「传输」选 **XHTTP (Xray)**；VLESS 的「加密」可填
   `xray vlessenc` 生成的 encryption 串。需要 Xray 的节点会显示 **Xray** 角标，「高级」里的「使用 Xray 内核」
   开关会自动打开并说明原因；普通节点也可手动打开该开关改由 Xray 承载。
3. **任意 Xray 组合**：添加节点 →「自定义出站 JSON」→ 内核选 **Xray** → 粘贴 Xray outbound JSON，表单会实时用
   `xray run -test` 校验。`tag`、`proxySettings`、`sockopt.dialerProxy` 由 FlowZX 接管（链式代理请用节点的前置代理）。
4. **内核状态**：设置 → 高级 → 内核管理 →「Xray 内核（sidecar）」显示版本与运行状态。要使用其它版本的 Xray，
   把 `xray`（Windows 为 `xray.exe`）放进该行提示的目录（`<userData>/xray_core/`），存在即优先使用。

## 与 Xray 26 相关的注意事项

- Xray 26 **移除了 `allowInsecure`**（配置中出现即启动失败）。Xray 节点上的「允许不安全证书」不会下发，改按正常证书
  校验；自签证书请在 TLS 高级里填写「证书 SHA-256 指纹」（`xray tls hash --cert cert.pem`，分享链参数 `pcs`）。
- Xray 节点开启 ECH 时必须提供 ECHConfigList（base64 / PEM）或 DNS 查询地址（如 `https://1.1.1.1/dns-query`），
  否则节点被判无效（不静默关闭 ECH 导致 SNI 外泄）。
- mKCP 的 `header` / `seed` 已迁到 `finalmask`：结构化表单不提供 mKCP，请用「自定义出站 JSON（Xray）」。
- HTTP/2（h2）传输已被 Xray 移除：使用 h2 的节点不能切到 Xray 内核（官方建议改用 XHTTP）。
- Xray 节点不使用 sing-box 的多路复用（Multiplex）；XHTTP 的连接复用用 `extra.xmux` 配置。
- Shadow-TLS、SS 插件为 sing-box 独有特性，带这些附加层的节点不能切到 Xray 内核。

## 打包与版本

- `npm run fetch:core` 同时拉取 sing-box 与 Xray（`src/shared/core-manifest.json` 的 `bundledXrayVersion`、
  `xrayArchiveSha256`（= release 附带 `.dgst` 中的 SHA2-256）、`xrayBinarySha256`），落到 `resources/<平台>/xray[.exe]`，
  与 sing-box 一起由 electron-builder 的 `extraResources` 打包。二进制不入库。
- 升级 Xray：改 `bundledXrayVersion` 与两组 sha，重跑 `npm run fetch:core`。

## 验证

- `npm test`：Xray 判定 / 配置构造 / 桥规划 / 分享链 / Clash / Xray JSON 导入 / 脱敏 等单测。
- `npm run test:core-gate`（打包链必经）：`xray-check-gate` 用随包 Xray 跑 `xray run -test`、用随包 sing-box 跑
  `sing-box check`，覆盖上表全部组合与前置代理链。
- `npm run test:xray-e2e`（Linux / macOS，需先 `npm run fetch:core`）：在本机起 VLESS-XHTTP-REALITY-ENC 等真实服务端，
  经 `ProxyManager.start` 全链路验证 TCP + UDP 转发、两条测速路径、节点热切换、Xray 崩溃自愈、前置代理链。
