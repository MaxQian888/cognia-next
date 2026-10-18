---
title: "0234 — 远程桌面是由 Host 中转的 Provider 绑定"
description: "沙箱与外部机器通过 Host 持有的 Provider 绑定来查看和控制：唯一的 fence 控制租约、由 Host 终结的数据面、硬隔离的 Provider 插件。复用第三方引擎，不重新实现协议。"
---

# ADR 0234 — 远程桌面是由 Host 中转的 Provider 绑定

**状态：** 已接受——用户于 2026-10-18 逐项确认全部决策。第 1–4 阶段已实现，规格与"实际实现"记录见 `docs/plans/2026-10-18-remote-desktop-phase{1,2,3,4}.md`；第 5 阶段待实现。  
**日期：** 2026-10-18  
**范围：** 在 Tauri 桌面、Web 与手机客户端上，查看并人工控制本地 Docker CUA 沙箱、ADR-0233 托管桌面和用户自有的外部机器（VNC、Selkies、Guacamole/MeshCentral Web 控制台、RustDesk 启动）。Agent 对外部机器执行 Computer Use 不在范围内。  
**相关：** [0005](./0005-remote-control)、[0020](./0020-computer-use-completeness)、[0088](./0088-pro-ide-code-server)、[0153](./0153-the-host-obtains-the-confirmation)、[0175](./0175-the-rpc-face-has-one-grammar-one-error-and-one-version)、[0196](./0196-a-library-crate-links-tauri-only-when-asked)、[0214](./0214-the-chat-dock-is-a-tabbed-browser-that-remembers-each-task)、[0224](./0224-an-always-on-host-is-a-peer-the-user-brings)、[0233](./0233-a-managed-desktop-accepts-a-delivered-commit)。  
**研究：** `docs/research/external-remote-desktop-review-2026-10-16.md`（对原方案的仓库与上游事实核查，含引用）。

## 决策

Cognia 不实现远程桌面协议，而是在成熟引擎之上中转会话。**远程目标**只是一个引用（沙箱、托管桌面或用户自有的外部机器），不是第二套生命周期注册表。每个目标有一个或多个 **Provider 绑定**。能到达该目标的 **Host** 负责：

- 持有绑定与凭据；
- 完成协议认证；
- 桥接字节流；
- 持有唯一的 **fence 控制租约**；
- 写入审计。

客户端只通过 Companion 命令和 Host 签发的票据进行查看和输入。Provider 以插件形式提供；内置 Provider 是一方插件，与第三方使用同一套契约。

## 背景

原方案（"Remote Desktop Framework + Built-in Viewer + External Remote Providers"）方向正确，但不能直接执行。

它有几处事实错误：

- UU 远程没有公开协议；
- Selkies 的 `enable_collab` 会破坏独占控制；
- Selkies 默认编码器为 GPL；
- Guacamole JSON auth 只存在于 Java webapp；
- 对 Rust Host 来说，websockify 不是合适的复用对象。

它也遗漏了几个前置条件：

- 本地 `cua_sandbox_*` 命令只能在 `internal`/`client` 使用，手机无法访问 Host 上的沙箱；
- 人工输入绕过 `run_gated`，租约事件从不审计；
- 仓库里没有 TCP 数据面；
- `crates/cognia-net/src/egress.rs` 的 `is_forbidden_dest_ip` 拒绝 RFC1918，而多数 VNC 服务器正在这些网段。

随后 ADR-0233 加入了 E2B 托管桌面：

- `crates/cognia-automation/src/cua_sandbox/managed/control.rs` 中带 fence 的 15 秒租约；
- `ManagedDesktopProvider` trait；
- 可经 http/websocket/webrtc 访问的 `managed_desktop_control_*` 命令。

它还禁止在托管 computer-server 旁另开原生 VNC/RDP 端点，因为那会接受租约之外的输入。本 ADR 建立在 0233 之上，并保留这项禁止。

## 1. 目标与绑定

| 目标类型 | 引用 | Provider |
| --- | --- | --- |
| `sandbox` | 本地 Docker CUA 连接（`lib/sandbox/`） | Native（经租约的画面与输入）；镜像带 Selkies 构建时可用 Selkies |
| `managed-desktop` | ADR-0233 桌面身份 | 仅 Native，经 0233 控制面 |
| `external` | Host 持有的记录 | VNC、Web 控制台（Guacamole、MeshCentral）、RustDesk 启动 |

已配对 Host 自己的屏幕，按"运行 VNC 服务端的 `external` 目标"接入，不另建原生屏幕串流路径。

绑定记录以下内容：Provider id、优先级、非敏感配置、凭据引用和固定后的端点。选择方式是手动指定，或在**同一**目标的绑定之间按优先级选择。回退永远不改变目标，也不会把查看升级为控制。

目标、绑定与凭据存在能到达它们的 Host 上：

- 目标与绑定存在带版本的 Host 存储里；
- 凭据存入 Host secrets，沿用 `lib/remote-host/credential-vault.ts` 的 `credentialRef` 模式与 0233 的 `managed-desktop:` 引用；
- 客户端通过 Companion 命令读取；
- 不建 Dexie 表，不走账号同步；
- 凭据永不离开 Host。

## 2. 唯一的控制租约

`managed/control.rs` 的 fence 租约成为唯一控制模型，本地 Docker CUA 从 `desktop_session.rs` 迁移上去。租约 15 秒，每 5 秒续期，绑定主体、目标、绑定与代际；每次失效都递增 fence。

- **多人看，一人控。** 独占只在 Cognia 中转的会话之间生效。接管必须显式请求，第二个人不能静默抢走控制权。
- **松开按键。** 人类输入是原子动作，因此持续按下的键盘键和鼠标键只来自 Agent 的状态切换。Host 跟踪这些 Agent 按下状态，并在接管、抢占和停止时松开；人类租约过期不会遗留按下状态。清理结果不确定时，按 0233 隔离该目标。
- **接管时处理进行中的 Agent 动作。** 接管会阻止新的 Agent 操作，并在截止时间内取消或等待进行中的动作结束，而不是简单排在它后面。
- **无法管控的连接。** 绕过 Cognia 的连接（另一个 VNC 客户端、一个 Guacamole 标签页）无法管控。不具备服务端撤销控制权能力的绑定，在 UI 中标为**由对方管理权限**，绝不展示为受租约保护。

## 3. 权限与命令

| 操作 | 能力 |
| --- | --- |
| 列出目标、读取状态、查看画面、打开只读会话 | `host.observe` |
| 取得/续期/释放控制、发送输入、打开控制会话 | `host.admin` |
| 创建/编辑/删除目标与绑定、确认局域网端点 | `host.admin` |

命令加入 `protocol/companion-commands.json`，动词取自封闭词表（`protocol/companion-verbs.json`，ADR-0175），并用 `pnpm companion-api:gen` 重新生成。敏感操作沿用 ADR-0153 的 Host 确认。共享对话永远不会附带桌面访问权。

## 4. 数据面由 Host 终结

- **传输。** 网络可达时，客户端用一次性 socket 票据打开 Companion WebSocket（`security_store.rs` 的签发/兑换，沿用 `ws_terminal.rs` 模式）。票据绑定会话、目标、绑定与模式。经 relay 时，Host 用专用的 `cognia.rfb` datachannel 承载同一数据流，在 `crates/cognia-companion-connectivity/src/signaling/peer.rs` 中与 `cognia.terminal` 并列分类。桌面画面永不走 `cognia.signaling` JSON RPC。
- **桥接。** 新 crate 中的 Host 侧 axum WebSocket↔TCP 桥替代 websockify。撤销票据或租约时，由服务端关闭数据流。
- **握手适配器。** 协议认证只能由 Host 的封闭适配器列表完成。第一个是 `vnc`：Host 与服务端完成 RFB 握手和 VNC 认证，再向客户端提供安全类型为 None 的已认证流，密码永不到达客户端或插件。`none` 是纯字节管道。新适配器（`guacd` 等）只进入 Host 代码，不进入插件。
- **VNC 只读。** 只有服务端强制只读的绑定才提供只读：TigerVNC 用 `vncpasswd` 生成的只读密码，或 x11vnc 的 `-viewpasswd`。只读会话由 Host 用该密码认证。其余绑定只提供完全控制，并标注"无法只读"。不做 RFB 输入过滤代理。
- **局域网出站。** 私有地址端点必须按目标经 `host.admin` 确认后才放行。主机名在保存时解析并固定为 IP:端口，解析结果变化需要重新确认。回环、链路本地与元数据地址始终拒绝。放行逻辑放在 `cognia-net`，与 `is_forbidden_dest_ip` 相邻。`scripts/gates/check-network-egress.mjs` 新增针对裸 `TcpStream::connect` 的规则，避免桥接悄悄绕过策略。
- **画面。** Selkies 阶段之前，Native 目标保持 RPC 轮询帧。

## 5. Provider 是硬隔离的插件

远程桌面 Provider 扩展点在 `lib/plugin/contracts/plugin-points.ts` 中声明。Provider 需要声明：

- manifest：集成方式 `native | embedded | web-console | external-app`、支持的目标、能力（含 `serverEnforcedViewOnly`、`managedControl`）；
- 配置 Schema；
- 探测；
- 从 Host 列表中选用的握手适配器；
- Viewer。

任何插件都可以注册 Provider，但隔离是硬性的：

- 插件永远拿不到凭据；
- 网络只能经 Host 桥接，且只能到达用户确认过的目标；
- 注册 Provider 不会获得任何已有目标的访问权。

内置 Provider 作为 `plugins/` 下的一方插件发布（先例：`plugins/e2b-sandbox/`），保证这套契约被真实使用。一方 Viewer 可以是 React 组件；第三方 Viewer 运行在沙箱化的插件 webview 中（`lib/plugin/registries/webview-registry.ts`），经 MessagePort 接收字节流。

## 6. 各 Provider 的定位

| Provider | 定位 |
| --- | --- |
| Native | 沙箱与托管桌面，经租约控制。Viewer 不再只在设置页，而是成为对话 Dock 面板（`ContextPanelDefinition`、`components/artifacts/chat-dock-panels.tsx`），与 `computer-use-picture-in-picture.tsx` 并列 |
| VNC | 第一个外部 Provider。noVNC 1.7 在导入时访问 `document` 并使用 top-level await，因此只在客户端经动态导入加载 |
| Selkies | 仅用于本地 Docker CUA，作为用户本地构建的 opt-in 构建参数（默认编码器为 GPL，Cognia 不分发该镜像）。附着已有的 `:99` 显示，经第二个回环端口发布，启用 Secure Mode 且 `enable_collab=false`。由一个 Host 所有者串行化 token 表替换。释放时先撤销 Selkies 控制者，确认后才释放租约。若要进入托管桌面，需要修订 0233。*实际实现（第 4 阶段）：* opt-in 采用叠加在内置镜像上的变体镜像（`cognia-cua-desktop:0.3.46-2-selkies-2.0.0`），而不是在其 Dockerfile 上加构建参数，因此默认镜像与托管镜像保持 recipe 7；用户在许可说明后按连接开关选择 |
| Guacamole、MeshCentral | 指向用户自有服务器的 Web 控制台绑定。桌面端用原生子 webview（`src-tauri/src/codeserver/webview.rs` 模式），手机用应用内浏览器，标注"由对方管理权限"。不内置 guacd 或 RDP 协议栈 |
| RustDesk | 在已安装该应用的设备上用 `rustdesk://<ID>` 启动，URI 中永不带密码。Cognia 不声称连接已建立 |
| UU 远程 | 不支持：没有公开的集成协议 |

RDP 只能经用户自己的 Guacamole 或 MeshCentral 接入，或在目标机器上安装 VNC / RustDesk。

## 7. 客户端

桌面、Web、手机使用同一套 Companion 命令。Web 静态构建没有服务端，只能经已配对 Host 访问目标。手机 Viewer：

- 默认触控板模式（精确光标），可切换为直接点触；
- 提供特殊键栏（Ctrl、Alt、Esc、Tab）和软键盘。

## 8. 审计

Host 持久化审计，参照 `crates/cognia-companion/src/sandbox_previews.rs` 的 `audit_grant`。记录以下事件：

- 会话打开、关闭与失败；
- 租约取得、续期、释放、过期与接管；
- 人工输入批次（只记数量与种类）；
- 绑定与 Provider 变更；
- 局域网确认。

每条记录包含时间、主体、设备、目标、绑定与结果，不含画面、凭据或剪贴板内容。客户端经 Companion 查询。仅靠内存中的 `AuditRing` 不够。

## 阶段

新的 Rust 逻辑放在 `crates/cognia-remote-desktop/`，登记在 `scripts/gates/rust-architecture.json`，Tauri 外壳放在其 `tauri-host` feature 之后（ADR-0196）。

1. **统一租约、补齐沙箱缺口、对话 Dock。** 本地 CUA 迁移到 fence 租约；松开按下的键；阻止进行中的 Agent 动作；Host 持久化审计；挂载 Dock 面板。
2. **框架、插件 API 与桌面端 VNC。** Host 目标存储、局域网固定地址及其 gate 规则、票据桥、`vnc` 适配器、一方 VNC 插件。
3. **Web 与手机。** 新命令启用 Companion 传输、`cognia.rfb` 通道、手机 Viewer。
4. **本地 Docker CUA 中的 Selkies。**
5. **RustDesk 启动与 Web 控制台。**

每个阶段都附带同目录测试、双语 i18n 与 changeset。安全测试必须覆盖：

- 绕过 UI 时，只读票据无法发送输入；
- 一个目标的票据无法到达另一个目标；
- 撤销租约后，下一次调用即停止输入；
- 固定地址的端点拒绝 DNS rebinding；
- 插件 Viewer 无法读取凭据。

## 后果

- 第一阶段完成本地 CUA 迁移后，旧的 `desktop_session.rs` 租约及其 `cua_sandbox_desktop_*` 命令退役。0020 与 0233 背景部分中关于本地沙箱"15 秒人工租约"的表述随之被取代。
- `cognia-net` 出站策略首次出现经用户确认的私有地址放行；其他调用方保持默认拒绝。
- 第三方 Provider 插件可以扩展 Viewer 与配置，不能扩展协议。新协议需要 Host 适配器和本 ADR 的修订。
- 不在范围内：Agent 对外部机器执行 Computer Use、内置 RDP、跨 Host 共享目标、录制、文件传输与剪贴板同步。剪贴板和文件传输以后加入时需要单独授权。

## 已考虑的替代方案

- **以客户端 `viewOnly` 作为边界。** 拒绝：noVNC 文档明确它只是客户端行为。
- **RFB 输入过滤代理。** v1 拒绝：没有在维护的开源实现，解析 RFB 输入会显著扩大安全面；服务端只读密码已能满足需求。
- **引入 websockify。** 拒绝：它是 Python 且为 LGPL，Rust 移植无人维护；在 axum 中写字节桥很小。
- **目标存 Dexie 并账号同步。** 拒绝：Host 负责桥接并持有凭据，同步列表会让它与唯一能使用它的机器分离。
- **MeshCentral 跨源 iframe。** 拒绝：`X-Frame-Options`、`SameSite=Lax` Cookie 和 WebView 第三方 Cookie 限制让它很脆弱；子 webview 走顶层导航。
