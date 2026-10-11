# Xray 内核（sidecar）—— 在 FlowZX 中使用 Xray 独有协议组合

FlowZX 在 sing-box 主核之外**随包内置 Xray-core**，专门承载 sing-box 不支持的 Xray 独有协议组合，例如：

| 组合 | 说明 |
| --- | --- |
| **VLESS + XHTTP + REALITY + ENC** | XHTTP 传输 + REALITY 伪装 + VLESS Encryption（`mlkem768x25519plus.*`，后量子） |
| VLESS + RAW + REALITY + Vision + ENC | 经典 Vision + REALITY 叠加 VLESS Encryption |
| VLESS / VMess / Trojan + XHTTP + TLS | XHTTP 走 CDN（packet-up / stream-up / stream-one / auto），支持 `extra`（xmux、`downloadSettings` 上下行分离…） |
| REALITY + ML-DSA-65 | 后量子 REALITY 证书验证（分享链 `pqv`） |
| `xtls-rprx-vision-udp443` | sing-box 仅支持 `xtls-rprx-vision` |
| TLS + 证书 SHA-256 钉扎（`pcs`） | sing-box 无整证书钉扎：填了「证书 SHA-256 指纹」的 TLS 节点自动由 Xray 承载（自签证书方案） |
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
   `network: xhttp` + `xhttp-opts` + `encryption` 同样支持。

   **Xray JSON**（手动导入与订阅链接均支持）。按 outbound 用 `protocol`（sing-box 用 `type`）自动识别：outbounds
   里出现任何带 `type` 的条目即按 sing-box JSON 处理，二者不会混淆；支持三种形态：
   - 单份 Xray 配置（含 `outbounds`）；
   - 完整配置数组：Marzban / 3x-ui 等面板的「v2ray-json」订阅，每份配置通常一个节点，节点名取配置顶层的
     `remarks`（一份配置含多个代理 outbound 时为「remarks · tag」）；无 `remarks` 的配置按地址命名
     （`address:port`，自定义 Xray JSON 节点带协议前缀），同地址同端口仍重名时追加「#配置序号」；
   - 裸 outbound 数组。

   `freedom` / `blackhole`（及其协议别名 `direct` / `block`）/ `dns` / `loopback` 等内部 outbound 忽略。链式代理
   （`sockopt.dialerProxy` / `proxySettings.tag`）转为节点的「前置代理」，且只在**同一份配置内**解析；前置指向内部
   outbound（如 3x-ui 的 `fragment` 分片 freedom）时该链不保留并告警（订阅更新时记入「日志」页，手动导入时在导入
   对话框中提示）——节点直连服务器，分片设置不生效。结构化表单
   无法表达的 outbound（mKCP、TCP / RAW 的 HTTP 伪装头、finalmask、mux、sockopt、wireguard / hysteria 等）以
   「自定义 Xray JSON」原样导入。订阅更新按「协议 + 地址 + 端口 + 凭据 + 传输」对账（自定义 Xray JSON 节点取其
   outbound 内的凭据与传输；多个节点该五项完全相同时——如多份配置链经同一中转——再按节点名配对），节点 id 与前置
   代理关系在更新间保持稳定，内容未变时不重启内核。例外：完全相同的节点连名字也相同（或名字带「#配置序号」）时，
   配置重排可能令其互换 id / 改名，该次更新按「有变化」处理、重启一次内核（流量走向不变）。
2. **手动添加 / 编辑**：VLESS / VMess / Trojan 表单的「传输」选 **XHTTP (Xray)**；VLESS 的「加密」可填
   `xray vlessenc` 生成的 encryption 串。需要 Xray 的节点会显示 **Xray** 角标，「高级」里的「使用 Xray 内核」
   开关会自动打开并说明原因；普通节点（含 Shadowsocks，见下方限制）也可手动打开该开关改由 Xray 承载。
   Trojan 表单的「安全」可选 **Reality**（与 VLESS 相同的公钥 / Short ID / SpiderX / 指纹字段）：sing-box 与 Xray
   都原生支持 Trojan + REALITY，默认由 sing-box 承载；填写 ML-DSA-65 验证公钥（`pqv`）或手动勾选时改由 Xray 承载。
   VLESS / Trojan 的 ML-DSA-65 与 SpiderX 字段只在 RAW（TCP）/ gRPC / XHTTP 传输下显示；其它传输上 ML-DSA-65 不提交、
   节点留在 sing-box（Xray 的 REALITY 不支持这些传输，见下方注意事项）。
3. **任意 Xray 组合**：添加节点 →「自定义出站 JSON」→ 内核选 **Xray** → 粘贴 Xray outbound JSON，表单会实时用
   `xray run -test` 校验。`tag`、`proxySettings`、`sockopt.dialerProxy` 由 FlowZX 接管（链式代理请用节点的前置代理）。
4. **内核状态与版本**：设置 → 高级 →「Xray 内核（sidecar）」卡显示版本、来源与运行状态，并可从 XTLS 官方发布页
   在线切换版本（含预发布），见下方[切换 Xray 版本](#切换-xray-版本)。

## 切换 Xray 版本

设置 → 高级 →「Xray 内核（sidecar）」卡（在 sing-box 的「内核管理」卡下方）：

- **来源**：「随包」= 安装包自带的版本（`core-manifest.json` 的 `bundledXrayVersion`）；「在线安装」= 在本卡安装的
  版本（GitHub 预发布版显示为「预发布」）；「自定义文件」= 你自己放进 `xray_core/` 的 `xray` 可执行文件。
- **选择版本**：下拉列表按版本号从新到旧列出带本平台构建的 release，选项标出预发布 / 当前 / 随包；旁边的按钮随所选
  版本显示「安装」/「切换」（选中随包版本时直接恢复随包，不下载）/「已是当前版本」，下方可打开该版本的发行说明。
  列表由主进程缓存 10 分钟，「刷新列表」强制重新获取（未登录的 GitHub API 每 IP 每小时 60 次，限流时提示稍后再试）。
- **预发布**：默认只列稳定版。打开「包含预发布版本」后同时列出 GitHub 标记为 pre-release 的版本（例如 v26.3.27
  之后的 v26.4.13 … v26.10.10 都是预发布）。预发布版未经 FlowZX 测试，安装前会二次确认。该开关只影响列表：
  Xray **没有后台自动更新**，只在你点击时安装。
- **最低版本 26.1.23**：Xray 遇到不认识的配置字段会**静默忽略**（`xray run -test` 照样通过），而 FlowZX 生成的配置
  靠这些字段保证安全：`pinnedPeerCertSha256`（证书钉扎，26.1.23）、`mldsa65Verify`（REALITY 后量子验证，25.7.26）、
  `echSockopt`（25.8.3）、VLESS Encryption（25.9.5）、`sockopt.penetrate`（XHTTP 上下行分离的下行也走 sing-box
  拨号，25.3.6）。旧版本会让证书钉扎失效、ECH 查询或下行连接绕过 sing-box 直连。因此低于 26.1.23 的版本不会列出，
  主进程也会拒装（tag 与解出二进制的 `xray version` 双重检查）；手动放入的旧版本会在卡内警示。最低版本记在
  `src/shared/core-manifest.json` 的 `minXrayVersion`。
- **完整性校验**：渲染端只把 tag 交给主进程，下载地址与摘要由主进程按 tag 现查 GitHub release 取得：本平台压缩包
  （如 `Xray-linux-64.zip`）的官方 SHA2-256 取自 GitHub API 的 `digest` 与 github.com 直连下载的
  `<asset>.zip.dgst`（绝不经镜像），两者都有时必须一致，都取不到则拒装。下载遇网络错误时会回落 GitHub 镜像
  （设置的 ghProxy 前缀，未设置则用内置 gh-proxy），但字节仍须通过这份官方摘要。之后只解出 `xray`（`xray.exe`），
  要求 `xray version` 与所选版本一致，再用新内核 `xray run -test` 当前 Xray 配置：不通过时不切换，弹框显示 Xray
  的报错，可选择「仍然切换」（新内核不认的 Xray 节点会在连接时被剔除并标为不可用，切换不会因此回滚；代理本身起不来
  才回滚）。macOS 上还会清除隔离属性并 ad-hoc 重签。
- **生效方式**：代理未运行时下次连接生效。代理运行中会**整体重启代理**（连接短暂中断，安装前会提示）：sing-box 的
  进程规则内嵌 Xray 路径，逐节点的 `xray run -test` 也要用新内核重跑。重启失败会自动换回原来的 Xray 与安装标记并
  再次启动，提示「已恢复原来的 Xray」。重启期间你手动停止 / 连接代理或退出 FlowZX 时，以你的操作为准：保留新版本，
  不回滚、也不再自动启动代理。安装或恢复进行中、或代理正在启动 / 停止时，卡内操作不可用；离开设置页再回来，进度仍会
  显示（新内核不认当前配置的弹框也会重新出现）。Xray 切换与 sing-box 内核更新互斥：一方进行中时另一方会提示稍后再试
  （sing-box 的自动落位则推迟到下次时机）。
- **恢复随包版本**：来源不是「随包」时可一键恢复：在线安装的版本直接删除，自定义文件改名为 `xray.custom-bak` 保留。
- **自定义文件**：仍可把 `xray`（Windows 为 `xray.exe`）放进 `<userData>/xray_core/` 使用其它构建，存在且可执行
  （macOS / Linux 需先 `chmod +x`）即优先于随包版本，卡内来源显示「自定义文件」。在线安装会替换它，替换前另存为
  `xray.custom-bak`；已有内容不同的旧备份会先改名为 `xray.custom-bak-<时间>`，你的文件不会被覆盖丢失。
- **`<userData>/xray_core/` 下的文件**：

  | 文件 | 说明 |
  | --- | --- |
  | `xray`（`xray.exe`） | 现役槽位，存在即优先于随包版本 |
  | `flowzx-xray.json` | 在线安装标记（tag、版本、是否预发布、二进制与压缩包 sha256、资产名、安装时间）；槽位文件的哈希与之一致才算「在线安装」，否则视为自定义文件 |
  | `xray.bak`（`xray.bak.exe`） | 最近一次在线安装前的槽位文件（不会自动清理） |
  | `xray.custom-bak`（`xray.custom-bak.exe`） | 被替换或移走的自定义文件 |

  切换过程中的临时文件（`.staging-*` / `.restore-*`）会在下次安装或恢复时清理。

## 与 Xray 26 相关的注意事项

- Xray 26 **移除了 `allowInsecure`**（配置中出现即启动失败）。Xray 节点上的「允许不安全证书」不会下发，改按正常证书
  校验；自签证书请在 TLS 高级里填写「证书 SHA-256 指纹」（`xray tls hash --cert cert.pem`，分享链参数 `pcs`）。
- Xray 节点开启 ECH 时必须提供 ECHConfigList（base64 / PEM）或 DNS 查询地址（如 `https://1.1.1.1/dns-query`），
  否则节点被判无效（不静默关闭 ECH 导致 SNI 外泄）。
- mKCP 的 `header` / `seed` 已迁到 `finalmask`：结构化表单不提供 mKCP，请用「自定义出站 JSON（Xray）」。
- HTTP/2（h2）传输已被 Xray 移除：使用 h2 的节点不能切到 Xray 内核（官方建议改用 XHTTP）。
- Xray 节点不使用 sing-box 的多路复用（Multiplex）；XHTTP 的连接复用用 `extra.xmux` 配置。
- Shadow-TLS、SS 插件为 sing-box 独有特性，带这些附加层的节点不能切到 Xray 内核。
- Xray 已移除 Shadowsocks 流加密（`aes-*-cfb` / `aes-*-ctr`、`rc4-md5`、`chacha20-ietf` 等）：仅 AEAD
  （`aes-128/256-gcm`、`(x)chacha20-(ietf-)poly1305`）与 2022（`2022-blake3-*`）方法的 SS 节点可切到 Xray 内核。
  加密方法名下发给 Xray 时统一转小写（Xray 按原样匹配 `2022-blake3-*`，大写会被拒收）。
- Xray 的 REALITY 只支持 RAW / XHTTP / gRPC 传输：WebSocket / HTTPUpgrade + REALITY 的节点只能由 sing-box 承载
  （「使用 Xray 内核」开关不可用，表单也不提供 ML-DSA-65 字段）。
- REALITY 必须使用 uTLS 浏览器指纹：指纹为「无」时两侧均按 `chrome` 下发（sing-box / Xray 都拒收无指纹的 REALITY）。

## 打包与版本

- `npm run fetch:core` 同时拉取 sing-box 与 Xray（`src/shared/core-manifest.json` 的 `bundledXrayVersion`、
  `xrayArchiveSha256`（= release 附带 `.dgst` 中的 SHA2-256）、`xrayBinarySha256`），落到 `resources/<平台>/xray[.exe]`，
  与 sing-box 一起由 electron-builder 的 `extraResources` 打包。二进制不入库。
- 升级 Xray：改 `bundledXrayVersion` 与两组 sha，重跑 `npm run fetch:core`。
- `minXrayVersion`：FlowZX 生成的配置所需的最低 Xray 版本（见[切换 Xray 版本](#切换-xray-版本)）。配置构造器开始
  输出更新的字段时同步上调；`core-manifest-invariants` 测试保证它不高于随包版本。

## 验证

- `npm test`：Xray 判定 / 配置构造 / 桥规划 / 分享链 / Clash / Xray JSON 导入与订阅（含对账稳定性）/ 脱敏 等单测。
- `npm run test:core-gate`（打包链必经）：`xray-check-gate` 用随包 Xray 跑 `xray run -test`、用随包 sing-box 跑
  `sing-box check`，覆盖上表全部组合与前置代理链，以及 v2ray-json 订阅语料（`xray-subscription-fixtures.ts`）的解析产物。
- `npm run test:xray-e2e`（Linux / macOS，需先 `npm run fetch:core`）：在本机起 VLESS-XHTTP-REALITY-ENC 等真实服务端，
  经 `ProxyManager.start` 全链路验证 TCP + UDP 转发、两条测速路径、节点热切换、Xray 崩溃自愈、前置代理链。
