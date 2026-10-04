# Cognia 沙箱虚拟电脑：实现现状与下一步

研究日期：2026-10-03。代码基准：当前共享工作目录，HEAD `0be8ce03051529ebaefc982ffe06acb27a0e92ca`，包含大量既有未提交修改；结论是本次读取时的状态，不代表该提交本身或已发布安装包。本文仅新增研究记录，没有修改实现。

行业组件与官方来源见 [行业调研](./sandbox-virtual-computer-industry-2026-10-03.md)。

实施阶段校正：E2B workspace / microVM 代码虽已存在，但 `plugins/e2b-sandbox/src/provisioning.ts` 的可用性开关为 false，尚缺随产品交付的 Node SDK bridge；下文原调研对其运行时注册的描述过强。Docker 后续修复与验收以 [实施计划](../plans/2026-10-03-sandbox-virtual-computer.md) 为准。

## 结论

Cognia 已有 Docker Linux 桌面的生命周期、旧版 GUI 指令通道、文件读取和 shell 执行，以及独立的 E2B 工作区和外部 Agent 容器运行时。它有可复用的基础，但还不能认定为完整、安全闭环的虚拟电脑产品。最优先的问题是新 app-session Computer Use 命令没有消费远端目标，存在实际路由到宿主桌面的代码路径；其次是交互式画面、执行取消和供应商能力对齐。

## 现有能力分层

| 层                        | 当前实现                                                                                        | 边界                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| OS 进程沙箱               | OS exec bridge、平台 confinement、策略与可用性探测                                              | 是命令执行隔离，不是独立桌面                                            |
| Docker 虚拟桌面           | `docker:computer-server` adapter；创建、启动、暂停、恢复、停止、删除、检查、GUI、文件读取、exec | 唯一真正注册的桌面 provider/driver 组合；依赖客户端本地 Tauri 和 Docker |
| E2B microVM 工作区        | 插件注册 workspace backend 和 microVM exec adapter，绑定已有远端 workspace                      | 当前没有因此自动获得 E2B Desktop GUI；缺少插件/工作区时拒绝执行         |
| 外部 Agent Docker runtime | sandbox-pool、sandboxd、容器 backend、持久 runtime、租约                                        | 另一条执行链；不能把其 supervisor 清理保证直接套到 CUA 的裸 docker exec |
| 本机虚拟显示器            | Windows Screen-off 模式的 virtual display controller                                            | 仍是宿主 Windows 会话，不是 VM 隔离；不是 macOS 虚拟电脑                |

源码：

- [adapter-registry.ts](../../lib/sandbox/adapter-registry.ts): `ADAPTERS` 仅含 `docker:computer-server`。
- [connection-capabilities.ts](../../lib/sandbox/connection-capabilities.ts): revision 3 开放 Docker `workspaceRead` / `workspaceExec`；`cua-cloud` / `lume` 全部能力关闭，`cua-driver` 驱动全部关闭。
- [runtime-availability.ts](../../lib/sandbox/runtime-availability.ts): adapter 和客户端本地生命周期 host 同时可用才开启连接操作。
- [E2B plugin](../../plugins/e2b-sandbox/src/index.ts) 与 [microvm-exec.ts](../../plugins/e2b-sandbox/src/microvm-exec.ts): 已有 workspace handle、网络创建事实、路径约束及能力拒绝。
- [persistent.rs](../../crates/cognia-sandbox-pool/src/docker/persistent.rs): `connect-agent --lease-seconds 60`，20 秒续约。
- [virtual_display/mod.rs](../../crates/cognia-automation/src/automation/virtual_display/mod.rs): Windows-only screen-off，非 Windows unavailable。

## Docker 桌面已接通的部分

设置页 `SandboxConnectionsTab` 被 `automation-section.tsx` 挂载，默认镜像为 `ghcr.io/trycua/cua-xfce:latest`。连接通过生命周期 adapter 调用 10 个 `cua_sandbox_*` 命令；这些命令在 Tauri `generate_handler!` 注册，startup 创建共享的 `CuaSandboxRegistry`。此处不是只有类型或 UI。

后端通过 Docker CLI 管理容器，映射 `127.0.0.1:<ephemeral>:8000`，通过 `/ws` 发送 computer-server 命令。默认策略包含只读 rootfs、`cap-drop ALL` 后少量显式加回、`no-new-privileges`、PID 上限、临时可写目录、以 `cua` 用户执行 shell；CPU/内存上限默认未设置，网络默认 Docker bridge。它没有为每个桌面启动独立 guest kernel 的实现，不能按每会话 microVM 描述隔离强度。

`pause` 使用 Docker pause 并保留驻留内存；`stop` 保留容器但结束进程；`delete` 删除容器及匿名卷。应用退出清理 WebSocket 客户端，容器保留；再次启动可基于确定性名称 adopt，并核验隔离参数。暂停不等同于持久磁盘快照或释放内存。

源码：

- [sandbox-connections-tab.tsx](../../components/settings/automation/sandbox-connections-tab.tsx)
- [docker-adapter.ts](../../lib/sandbox/docker-adapter.ts)
- [startup/automation.rs](../../src-tauri/src/startup/automation.rs)
- [src-tauri/lib.rs](../../src-tauri/src/lib.rs)
- [lifecycle.rs](../../crates/cognia-automation/src/cua_sandbox/lifecycle.rs)
- [registry.rs](../../crates/cognia-automation/src/cua_sandbox/registry.rs)
- [remote_client.rs](../../crates/cognia-automation/src/cua_sandbox/remote_client.rs)

## 首要缺口：新 app-session 命令绕过远端路由

当前模型插件主要发布 `list_apps`、`get_app_state`、`query_elements`、`expand_element`、`perform_action`、`zoom` 等工具。

调用链为：

1. `plugins/computer-use/src/index.ts` 的 `get_app_state` / `perform_action` 调用 Automation API。
2. `lib/plugin/api/automation-api.ts` 的 `buildComputerUseCallContext` 正确取得不可变 runtime ref，并装饰 `sandboxConnectionId`。
3. `lib/automation/client.ts` 将该 context 送入 Tauri。
4. `automation/commands.rs` 中 `desktop_list_apps`（约 505 行）、`desktop_get_app_state`（约 527 行）、`desktop_perform_action`（约 723 行）直接调用 `state.handle`；没有根据 `ctx.remote_connection_id()` 选择 CUA。
5. `command_body!` 只投影权限、审批和审计字段到 `GateContext`，不做目标路由；`worker.rs` 对应分支调用本机 backend / 本地 UiSessionManager。

因此，即使前端携带了 sandbox connection，权限放行后的新工具仍存在操作/读取宿主机的路径。这是源码确认的路由缺口，尚未在真实桌面执行复现；本次没有为了验证而操作用户真实桌面。权限门仍然存在，不能把问题描述为绕过所有审批。

旧 `cua_route.rs` 支持远端截图、坐标点击、输入、滚动、拖拽和树读取，且不支持的远端操作会拒绝。但这一保证不能覆盖绕过它的新命令。其 accessibility refs 为合成引用，不能复用本机语义句柄；远端 `find`、元素点击、pattern、window operation 等也存在明确不支持边界。

修复顺序建议：先让未实现的 remote app-session 命令明确拒绝并增加 Rust 端回归；再实现真正以 connection/runtime 为身份的远端 session、revision、frame 与 action 路由。只修 TypeScript context 传递不足以解决问题。

## 其他产品与可靠性缺口

1. **画面呈现以动作截图为主。** 当前 `ComputerUsePictureInPicture` 消费 tool producer 发布的 frame，支持放大/拖动/隐藏；已读取的这条桌面链没有嵌入 noVNC/WebRTC 持续串流与人工键鼠接管。不能把截图 PiP 当成交互式远程桌面。
2. **CUA shell 的取消不等于进程结束。** `docker_exec` 超时返回明确说明容器内命令可能仍运行；输出在 `wait_with_output()` 收集后才截断，返回上限不等于采集期间内存上限。应复用已有 supervisor 的会话租约/进程树清理思路并流式限制输出。
3. **健康判定有限。** Docker adapter 的健康主要是 inspect + exec 可用；这不能证明 GUI WebSocket、截图、输入、串流全部可用。建议按 control/exec/gui/stream 区分 readiness，并以真实 screenshot/input smoke 验证。
4. **上游版本没有固定。** 默认 `latest`，自写 WebSocket 协议没有版本协商；新版 Cua 已公开另一套 spacesd/SDK/runtime 接口，升级镜像前需要兼容性矩阵和固定 digest，不应直接替换镜像名。
5. **桌面云服务尚未接入。** E2B workspace 并不等于 E2B Desktop，`cua-cloud` / `lume` 的配置类型不代表可用 provider。

源码： [PiP](../../components/chat/computer-use-picture-in-picture.tsx)、[PiP producer](../../lib/plugin/api/automation-api.ts)、[CUA exec](../../crates/cognia-automation/src/cua_sandbox/lifecycle.rs)、[health adapter](../../lib/sandbox/docker-adapter.ts)、[protocol](../../crates/cognia-automation/src/cua_sandbox/protocol.rs)。

上游接口变化来源：[Cua Runtime support](https://cua.ai/docs/cua-sdk/reference/runtime-support)。该页明确区分当前 SDK 的源代码契约与实际镜像/部署验证。

## 建议路线与验收

| 优先级 | 工作                                             | 验收                                                                                                  |
| ------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| P0     | 修正/拒绝 remote app-session 路由                | 远端请求绝不调用 host backend；真实容器与宿主放置不同标识，读写均只能命中选定目标                     |
| P1     | 固定一个 Docker 桌面镜像和协议组合，验证完整会话 | 创建→GUI→shell→文件→pause/resume→应用重启 adopt→stop/delete 全链路                                    |
| P1     | 持续画面与人工接管                               | stream 鉴权、输入权仲裁、Agent 暂停/恢复、断线恢复、目标身份不变                                      |
| P1     | 复用 supervisor 的取消与租约机制                 | timeout、断线、Host 崩溃后子孙进程消失；持续大输出不造成无界内存                                      |
| P2     | 根据部署目标增加一个 provider                    | 云 Linux 优先评估 E2B Desktop；Apple Silicon 的 macOS guest 优先 Lume；自建云控制面再评估 OpenSandbox |

保持现有 `SandboxRuntimeRef`、`SandboxProviderAdapter`、生命周期/权限系统和 workspace/terminal/browser/file 组件，逐项扩展真实能力。无需新建第二套全能 runtime registry。GUI、shell、文件、浏览器预览应能证明属于同一个具体实例；仅 UI 上显示同一名称不足以成立。

## 本次验证边界

实际运行：

```text
rtk pnpm exec jest --runInBand --runTestsByPath \
  lib/sandbox/adapter-registry.test.ts \
  lib/sandbox/connection-capabilities.test.ts \
  lib/sandbox/session-runtime.test.ts \
  lib/automation/sandbox-target.e2e.test.ts \
  plugins/e2b-sandbox/src/microvm-exec.test.ts

Test Suites: 5 passed, 5 total
Tests:       105 passed, 105 total
```

这里的 `sandbox-target.e2e.test.ts` 是 TypeScript wiring test，截止于 context 装饰，不是跨 Tauri/Rust/真实 Docker 的端到端验证，不能反证上述路由缺口。测试有 audit persistence warning（Node 环境 Dexie guard / 关闭场景），未证明真实审计持久化。

环境只读探测：Docker context 为 `desktop-linux`；`docker info` 返回 `Cannot connect to the Docker daemon at unix:///Users/bytedance/.docker/run/docker.sock. Is the docker daemon running?`；Colima default 为 Stopped。没有启动 Docker、下载镜像、创建付费云沙箱或改变登录。未运行真实桌面 E2E、Rust 全量构建、打包或覆盖率。未把此前研究记录中的测试数字作为本次验证结果。

旧的 2026-08-24 sandbox convergence note 中“CUA 只有 GUI、workspaceRead/Exec 为 false”已与当前 revision 3 实现不一致。本报告以当前源码为准。
