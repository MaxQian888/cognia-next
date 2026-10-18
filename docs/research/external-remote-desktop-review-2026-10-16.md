# Cognia External Remote 方案审查：可行性、纠错与收敛后的决策

研究日期：2026-10-16（决策确认 2026-10-18）。代码基准：`dev`，审查期间 HEAD 从 `966ad5ae3` 前进到 `da24dae0f0`，其中 `c20b00cd34`（ADR-0233 托管云桌面）对本审查有直接影响，结论已按其更新。仓库事实由只读代码检索核对；上游事实由联网检索核对（Codex `gpt-6.1-sol`，2026-10-16）。本文只记录研究与决策，没有修改实现。最终决策见 [ADR-0234](../content/docs/zh/adr/0234-a-remote-desktop-is-a-provider-binding-brokered-by-the-host.md)。

审查对象：用户提供的《Cognia External Remote 完整设计与实施方案》v1.0（2026-10-16，下称"原方案"），共十六节，提出 Remote Desktop Framework + Built-in Viewer + External Remote Providers。

## 结论

方向可行，且与仓库既有架构和 [2026-10-03 行业调研](./sandbox-virtual-computer-industry-2026-10-03.md)（"已有 Linux 桌面先 noVNC，需要更顺滑接管再评估 Selkies"）一致：Companion API 作为唯一控制面、Provider 与 Viewer 分离、RemoteTarget 只做引用层、服务端强制而不是前端 `viewOnly`、对无法托管控制权的 Provider 如实标注——这些判断都正确。

但原方案不能直接作为实施规范交给开发 Agent：存在 6 处事实错误，遗漏 3 个比其所列整个阶段更大的前置条件，并且在"禁止桩代码"（CLAUDE.md 规则 2）的仓库里一次铺开 7 个 Provider 加插件 API，范围过大。

## 原方案中经核实正确的部分

| 论断                                                          | 证据                                                                                                                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 旧 Remote Control 已退役，应接入 Companion API                | ADR-0005 于 2026-08-09 Superseded；`subsystems/remote-control` 标题为 Retired                                                                                                  |
| 命令清单与 gen/check/lint 流水线                              | `protocol/companion-commands.json`（字段 target/operation/capability/risk/approval/idempotency/transports/inputSchema/outputSchema）；`pnpm companion-api:{gen,check,lint}`    |
| 可复用一次性 Socket Ticket                                    | `crates/cognia-companion-security/src/security_store.rs:2409`（签发）/`:2440`（兑换）：60 s、只存 SHA-256、绑定 path 与 audience、单事务单次使用；`ws_terminal.rs:57` 等已使用 |
| 不应把视频塞进 `cognia.signaling`                             | 该通道为可靠有序 JSON RPC（`crates/cognia-companion-connectivity/src/signaling/peer.rs:645`），仓库无任何媒体轨                                                                |
| CUA 15 s 租约，人工持有时阻止 Agent                           | `cua_sandbox/desktop_session.rs:14` `CONTROL_TTL`，`require_agent()`                                                                                                           |
| noVNC `viewOnly` 只是客户端行为                               | [noVNC API](https://novnc.com/noVNC/docs/API.html)                                                                                                                             |
| Selkies `POST /api/tokens` 替换整张表；可附着已有 X11 DISPLAY | [Secure Mode](https://docs.selkies.io/latest/secure-mode)、[Native](https://docs.selkies.io/latest/native)                                                                     |
| guacd 服务端执行只读                                          | [guacd VNC `user.c`](https://github.com/apache/guacamole-server/blob/main/src/protocols/vnc/user.c) 仅在 `!read_only` 时安装输入 handler                                       |
| MeshCentral 登录 Token + `viewmode=11` + `allowFraming` 嵌入  | [官方嵌入指南](https://docs.meshcentral.com/meshcentral/#embedding-meshcentral)                                                                                                |
| RustDesk 可用 URI 启动                                        | [`flutter/lib/common.dart`](https://github.com/rustdesk/rustdesk/blob/master/flutter/lib/common.dart)：`rustdesk://<ID>`                                                       |
| 凭据引用模式已存在                                            | `lib/keyring/index.ts`、`lib/remote-host/credential-vault.ts` 的 `credentialRef`                                                                                               |

## 事实错误

1. **网易 UU 远程没有公开集成协议。** 官方站点与帮助入口均未找到面向第三方的 deep link、URL scheme 或 SDK（[官网](https://uuyc.163.com/)、[帮助](https://uuyc.163.com/help/)）。原方案 P5"按照其公开的移动端接入协议适配"前提不成立。
2. **CUA 租约只给人工，释放不完整。** 不存在 Agent 租约（Agent 是默认写入者）。过期只在下一次调用时惰性清理；按下的鼠标键只在**取得**控制权时松开（`desktop_session.rs:202-221`），键盘按下状态完全没有跟踪；已通过 `require_agent` 的进行中 Agent 动作不会被取消，接管只是在互斥锁上等待（`cua_route.rs:262-282`）。原方案"断线/租约失效时必须释放按键和鼠标"是当前代码**未满足**的要求，而非可复用能力。ADR-0233 的新租约（见下）同样未补上过期时松键。
3. **Selkies `enable_collab` 会破坏独占控制。** 持有 `mk_control` token 的 viewer 在 `enable_collab` 开启时可以输入（[`sessions.py`](https://github.com/selkies-project/selkies/blob/main/src/selkies/sessions.py)）。必须要求 `enable_collab=false`。
4. **Selkies 许可证不只是 MPL-2.0。** 默认软件编码依赖 GPL 的 x264/x265（[licensing](https://docs.selkies.io/latest/licensing)）。若 Cognia 分发带 Selkies 的镜像，需要履行 GPL 义务；原方案许可证表不完整。
5. **Guacamole"方式 A"混淆了两个产品。** Encrypted JSON Authentication 是官方 Java webapp 的扩展（[json-auth](https://guacamole.apache.org/doc/gug/json-auth.html)），对自建隧道或 `guacamole-lite` 不生效。npm 上的 `guacamole-common-js`（1.5.0）是第三方重打包，Apache 当前为 1.6.0（[Apache API](https://guacamole.apache.org/api-documentation/)）。自建隧道不需要 Java：协议是带长度前缀的 UTF-8 指令流（[协议](https://guacamole.apache.org/doc/gug/guacamole-protocol.html)）。
6. **websockify 不是 Rust Host 的合适复用对象。** Python 主实现为 LGPL-3.0，只做字节转发（[README](https://github.com/novnc/websockify)）；Rust 端口 `warp-websockify` 最后提交 2021-04，`axum-websockify` 是 2023 年的 POC。axum 中 WS↔TCP 字节桥只需百余行，自写即可。

次要不准确处：`lib/remote-host/` 建模的是 ADR-0224 "用户自带的常驻 Host"，而非泛指已配对 Host（设备种类为 `local | paired-device | remote-host | worker | ssh-host`，`lib/devices/types.ts:44`）；仓库没有 `desktop` 能力 ID，沙箱 GUI 能力名为 `gui`；新命令名必须使用 ADR-0175 的封闭动词表（`protocol/companion-verbs.json`）。另外 TigerVNC 的只读做法是 `vncpasswd` 生成的第二个只读密码，不存在 `-ViewOnlyPassword` 参数（[vncpasswd](https://tigervnc.org/doc/vncpasswd.html)）。

## 遗漏的前置条件

1. **本地 CUA 沙箱无法跨设备访问。** 17 个 `cua_sandbox_*` 命令全部 `transports: ["internal"]`、`target: "client"`；`components/devices/sections/runtime-section.tsx:10-16` 明确远端 Host 的沙箱不可达。原方案把"跨设备访问"写成 P2 的一个子项，实际是前置阶段。ADR-0233 的 `managed_desktop_control_*` 已经可经 http/websocket/webrtc 访问，但只覆盖 E2B 托管桌面。
2. **人工控制没有审计。** `cua_sandbox_desktop_input`（`cua_sandbox/mod.rs:459`）绕过 `run_gated`；租约取得、续期、释放与 CUA 生命周期都不进入 `automation/audit.rs`。ADR-0233 的托管输入经 `run_gated_enf` 审计，但租约事件仍未审计，且 `AuditRing` 只在内存中。
3. **没有数据面，且出站策略按设计拒绝局域网。** 仓库内没有任何 TCP 转发（无 `copy_bidirectional`）；`crates/cognia-net/src/egress.rs:112` `is_forbidden_dest_ip` 拒绝 RFC1918——恰是多数 VNC 主机所在网段。`scripts/gates/check-network-egress.mjs` 也不扫描 `TcpStream::connect`，新桥接可能绕过代理策略而不被发现。

## 原方案说得对但不够具体的点

- **查看器位置。** 现有查看器只在设置页（`sandbox-connection-sheet.tsx`），每秒一次截图轮询（ADR-0233 托管桌面同样是 RPC 返回 PNG）。对话里已有 `components/chat/computer-use-picture-in-picture.tsx` 和 Dock 面板体系（`ContextPanelDefinition`、`components/artifacts/chat-dock-panels.tsx`），"在对话中查看桌面/人工接管"是新增 Dock 面板，不是复用。
- **noVNC 与静态导出。** 1.7.0 在导入时访问 `document`，H.264 探测使用 top-level await（[`browser.js`](https://github.com/novnc/noVNC/blob/v1.7.0/core/util/browser.js)、[issue #1943](https://github.com/novnc/noVNC/issues/1943)），必须仅客户端动态导入，并确认 Turbopack 与移动端 bundle 支持；上游 `master` 已移除 TLA。
- **MeshCentral 跨源 iframe 风险高。** 默认 `X-Frame-Options: sameorigin`，需 `allowedFramingOrigins`；会话 Cookie 默认 `SameSite=Lax`，WKWebView 与 Android WebView 还有第三方 Cookie 限制（[webserver.js](https://github.com/Ylianst/MeshCentral/blob/master/webserver.js)）。code-server 面板的原生子 webview（`src-tauri/src/codeserver/webview.rs`，`Window::add_child`）是桌面端更稳妥的嵌入方式。
- **手机数据面已有先例。** `peer.rs` 已有独立的 `TERMINAL_DATACHANNEL_LABEL = "cognia.terminal"`，而 noVNC 原生接受 `RTCDataChannel`。专用 `cognia.rfb` 通道可经现有 relay/WebRTC 送达，无需暴露新的公网网关。
- **URL 中的凭据。** RustDesk 支持 `?password=`，Selkies 使用 URL token，二者都会进入系统启动日志或历史记录；RustDesk URI 不得带密码。
- **性能目标。** CUA 的 Xvfb 固定为 1280×800×24，"1080p30"对沙箱不适用；Selkies 在缺少 `VideoDecoder` 时有 JPEG 降级路径（[util](https://docs.selkies.io/latest/reference/web-core/lib/util)），旧 WebView 会降级而不是失败。WebKit 16.4 起支持视频 WebCodecs，Android WebView 需 Chromium 94+（[WebKit 16.4](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/)）。

## 上游事实速查（2026-10-16）

| 项目           | 当前事实                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| noVNC          | `@novnc/novnc@1.7.0`，ESM；核心 MPL-2.0；RFB 接受 URL / WebSocket / RTCDataChannel                                                                                       |
| websockify     | Python LGPL-3.0，字节转发 + token/auth 插件；无维护中的 axum 实现                                                                                                        |
| VNC 服务端只读 | TigerVNC：`vncpasswd` 只读密码 → `AccessView`；x11vnc：`-viewonly`、`-viewpasswd`、`client_input`；无公认维护的 RFB 输入过滤代理                                         |
| Selkies        | 2.0.0，Python + Rust 扩展，默认 WebSocket、WebRTC 可选；Secure Mode 整表替换、删除即断开；可附着已有 X11；CPU x264 可用，1080p30 需实测；默认 WebSocket 不需要 STUN/TURN |
| Guacamole      | Apache 1.6.0；npm 包为第三方 1.5.0；Node `guacamole-lite`、Rust `sol1/rustguac`（完整应用，非可嵌入库）；JSON auth 有 `expires`（毫秒）和 `read-only` 参数               |
| MeshCentral    | Apache-2.0；token 登录受限用户，`node`/`viewmode`/`hide` 本身不缩减授权；`hide=15` 只隐藏 header/tabs/footer/title                                                       |
| RustDesk       | 客户端 AGPL-3.0；`rustdesk://<ID>`、`<ID>@<SERVER>`、`key`、`relay`；有官方托管 Web client，但无可嵌入 SDK；Pro 自托管 Web client 有套餐门槛                             |
| UU 远程        | 未找到公开集成协议                                                                                                                                                       |

## ADR-0233 带来的变化

`c20b00cd34` 引入 E2B 托管桌面：`crates/cognia-automation/src/cua_sandbox/managed/control.rs` 中带 fence 计数器的 15 s 租约（`LEASE_MS`，每次失效递增 fence）、`ManagedDesktopProvider` trait（唯一生产实现为 E2B）、5 个 `managed_desktop_control_*` Companion 命令（frame 用 `host.observe`，其余用 `host.admin`）。它明确拒绝在托管桌面中另跑原生 VNC/RDP 端点，因为那会允许租约之外的输入。它没有补上的：过期松键、旧 CUA 路径的进行中动作、租约审计与持久化、对话内查看器、连续串流、局域网放行、插件扩展点。

## 与用户确认的决策（2026-10-18）

经逐项确认（grill 会话），收敛为：

- 目标：本地/托管沙箱 + 外部设备；已配对 Host 的真实桌面按"装了 VNC 的外部设备"接入。
- 客户端：桌面、Web、手机都在范围内，按阶段交付。
- UU 远程：删除。
- 与 ADR-0233：叠加不推翻；Selkies 只进本地 Docker CUA。
- 控制模型：以 `managed/control.rs` 的 fence 租约为唯一模型，本地 CUA 迁移上去；多人看、一人控，接管必须显式。
- Agent 操作外部设备：首版不做。
- 权限：复用 `host.observe` / `host.admin`。
- 数据面：经配对 Host 中转；局域网用票据 WS，外网用 `cognia.rfb` 通道；Selkies 前保持 RPC 轮询。
- 存储：目标、绑定、凭据由 Host 持有，不入 Dexie、不走账号同步。
- 局域网放行：逐目标 `host.admin` 确认，保存时解析并固定 IP:端口。
- VNC：Host 代为完成认证；只有服务端支持只读密码时才提供只读。
- 插件 API：首版开放，硬隔离；握手只能使用 Host 的封闭适配器列表；内置 Provider 作为一方插件实现，一方可用 React，第三方用沙箱 iframe。
- Selkies：作为 opt-in 构建参数由用户本地构建，Cognia 不分发含 GPL 的镜像。
- Guacamole / MeshCentral：Web 控制台绑定；RustDesk：只用 URI 启动且不带密码；不内置 RDP。
- 手机：默认触控板模式。
- 审计：Host 持久化，只记元数据。
- 一篇总 ADR，分阶段各自上线。
