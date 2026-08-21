# 跨设备连接与任务派发 — 现状盘点、缺口清单与 daemon 决策（2026-08-20）

> 范围：**连接面**（一台设备如何找到并信任另一台）与**派发面**（一件"工作"如何从设备 A 落到设备 B 执行并把结果送回）。
> 不重复 `docs/research/multica-cognia-gap-analysis-2026-08-12.md` 已覆盖的"共享工作项产品模型"结论；本文只做连接/派发维度，并更新 08-12 之后落地的部分。
> 证据标准：全部结论都指向工作树中的具体文件行；ADR 只用于说明设计意图，实现以代码为准。工作树在审计时有 409 个他人会话的未提交改动，本文只读、未做任何修改。

---

## 0. 结论先行

1. **连接面是完整且成熟的**，不是缺口所在。5 条传输、6 种发现方式、一套统一的设备身份/授权模型都已落地并有 boot 时恢复。
2. **派发面才是缺口**。11 条"跨设备把活儿送过去"的路径中，只有 1 条（客户端→宿主的 `mobileOutboundQueue`）是持久、幂等、可恢复的。其余要么是内存态、要么无排队、要么默认关闭、要么根本不存在宿主维度。
3. **不需要模仿 multica 新造一个 daemon**——仓库里已经有三个 daemon 前例，而且 multica daemon 的核心职责（认证接入 + 声明能力 + 领任务 + 本地跑 CLI + 回传事件）在 cognia 里已经**完整实现**了，就是 `cognia-agent worker connect` + `/ws/worker` + `BridgeWorkerRpcPool`（ADR-0113）。
4. 真正的问题是这套能力**接不上电**：
   - 桌面宿主收得下 worker、在 Fleet 里显示"在线"，但**一帧都派不过去**（`announce_all_workers` 在没有 socket brain 时直接早退），且 UI 没有任何惰性标注；
   - 开启远程派发需要**三个默认关闭的开关同时打开**（两个 feature flag + 一个 developer setting）；
   - 没有"放置层"（placement）——ADR-0097 自己写着 `Not done`：**没有任何东西决定一次运行应该在哪里执行**。
5. 需要新增的"daemon 化"只有两件小事：把 worker 变成**受管服务**（复用已有的三平台安装器），以及让**桌面宿主也能成为派发方**。这两件事的架构选择需要你拍板（见 §7）。

---

## 1. 连接面盘点

### 1.1 五条传输

| 传输                 | 方向                       | 实现                                                                    | 现状                                                                      |
| -------------------- | -------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `TauriTransport`     | 渲染层 ↔ 本机 Rust         | `lib/tauri/transport-tauri.ts`                                          | 桌面默认                                                                  |
| `RoutingTransport`   | 桌面 → 远程 Cognia 宿主    | `lib/tauri/transport-routing.ts`（ADR-0082）                            | 会话级，默认 `local`，指针交换切换，~480 个 `transport.call` 站点自动跟随 |
| `CompanionTransport` | 手机 / 浏览器 → 宿主       | `lib/tauri/transport-companion.ts`                                      | HTTPS + WS，主路径                                                        |
| `RtcTransport`       | NAT 穿透                   | `lib/tauri/transport-rtc.ts` + `services/signaling-server/`（ADR-0021） | 端到端加密信令，需自部署 signaling                                        |
| `BridgeTransport`    | 宿主 Rust ↔ headless brain | `src-tauri/src/companion_api/ws_bridge.rs`（`/internal/bridge`）        | **仅 `cognia-server`**；桌面用 `WebViewBridgeTransport`                   |

`lib/runtime/runtime-target.ts` 定义了三种客户端运行目标：`standalone` / `companion`(desktop\|cloud) / `legacy-readonly`；Tauri 与 headless 自身是宿主，返回 `null`。

### 1.2 发现与可达性

- mDNS 广播（`src-tauri/src/companion_api/mdns.rs`）+ 浏览（`lib/connectivity/mdns-browse.ts`、`mdns-discovery.ts`、`mdns-permission.ts`）
- LAN 扫描 / 解析 / 分类（`lan-scanner.ts`、`lan-resolver.ts`、`lan-classify.ts`）+ loopback 探测（`loopback-discovery.ts`）
- Cloudflared 隧道（`tunnel.rs` / `tunnel_config.rs` / `tunnel-resolver.ts`），Quick 与 Named 两种模式
- 候选排序：`lib/connectivity/connection-strategy.ts` → `mdns` > `tunnel` > `cached`，全部按 TLS 指纹校验
- **boot 时恢复**：`companion_api/commands.rs::restore_reachability` 在 Tauri `setup` 钩子里跑，托盘启动 / 登录自启也能恢复监听 + 广播（`reachability_config.rs` 只记录"用户意图"，内部调用不写盘）

### 1.3 身份与信任

一次性邀请（cgnp3 payload）→ 设备 JWT（ES256）+ DPoP + TLS SPKI SHA-256 pin → `SecurityStore`（Rust SQLite，`security_store.rs` 77KB）持有设备与 grants；socket ticket 单次可用、设备绑定（`/api/v1/terminal/socket-ticket`）；OIDC 把同组织成员映射到同一 account（`middleware.rs`）；能力分级 READ_ONLY / CONTROL / SERVICE_ONLY + 每设备 `control_allow_list`；撤销走 `DELETE /api/devices/{id}`，远端优先（ADR-0097 D15）。

### 1.4 端点清单（`companion_api/server.rs`）

`/healthz` `/livez` `/readyz` `/metrics` `/api/whoami` `/api/_rpc/{name}` `/api/devices[/{id}][/capabilities]` `/api/invitations` `/api/worker-enrollments` `/api/auth/pair/issue` `/api/auth/device/challenge` `/api/sessions/{id}/media/{hash}` `/api/workflow-deployments/{id}/runs` `/api/workflow-runs/{id}[/cancel|/events]` `/a2a` `/.well-known/agent-card.json` `/ide/relay/{id}` `/connectors[/webhook/...]` `/integrations/{lark,mcp}` `/oauth/callback` `/operator/...` `/internal/{bridge,events,_rpc}` `/ws/{events,acp,terminal,worker,browser}`（含 `/ws/v1`、`/ws/v2` 兼容别名）。

**A2A 双向都有**：`companion_api/a2a/`（cognia 作为 A2A agent 被调用）+ `lib/ai/agent/external/a2a-client.ts`（cognia 调用远端 A2A agent，已注册进 `manager.ts:823`）。这一条 multica 2026-08 才加的能力 cognia 已经覆盖。

### 1.5 唤醒能力（薄弱环节）

- Push：`companion_api/push.rs` 默认 `NoopDispatcher`；真实 FCM/APNs 在 `dispatchers.rs`，但需要用户自己上传 service account / `.p8`（`push_creds.rs`）。有 WS 时抑制推送。
- **无 Wake-on-LAN**、**无电源断言**（全仓只有 Windows 虚拟显示器用了 `SetThreadExecutionState`，macOS/Linux 没有任何 `IOPMAssertion` / App Nap 处理）。宿主睡眠 = 全面失联。

---

## 2. 派发面盘点 — 11 条路径

| #   | 路径                             | 载体                                                | 持久排队                               | 可选设备                  | 断线恢复             | 默认状态                              |
| --- | -------------------------------- | --------------------------------------------------- | -------------------------------------- | ------------------------- | -------------------- | ------------------------------------- |
| 1   | 客户端写 → 宿主                  | `mobileOutboundQueue`（Dexie v25+）                 | ✅ 幂等键 + 退避 + 死信                | n/a（单宿主）             | ✅                   | **开**                                |
| 2   | HostState 会话意图 → 宿主        | 同队列，`protocol: "host-state-v1"`                 | ✅                                     | n/a                       | ✅ 租约 + `hostSeq`  | **暗**（默认 `legacy-authoritative`） |
| 3   | 宿主 → 手机执行步骤              | `remote-step-broker.ts` + `workflow://step-execute` | ❌ 纯内存                              | 按 `lastSeenAt`           | ❌ 重进执行器重发    | 开，但 **Tauri-only**                 |
| 4   | brain → worker 执行 Agent 子任务 | `/ws/worker` + `BridgeWorkerRpcPool`                | ✅ 60s 租约 + `lastRemoteEventId` 重放 | ✅ `colocate/auto/pinned` | ✅ checkpoint 门控   | **三重关闭 + 仅 headless**            |
| 5   | 桌面 → 远程宿主                  | `RoutingTransport`                                  | —                                      | 显式激活                  | 会话级，重启回本地   | 开（默认不激活）                      |
| 6   | 定时任务                         | 各宿主自有 `CogniaSchedulerDB`                      | ✅ 本宿主内                            | ❌ **永不跨宿主移交**     | ✅                   | 开                                    |
| 7   | 工作流触发                       | `trigger-bridge` 原地 `runWorkflow()`               | ❌                                     | ❌ 无放置                 | run-lease            | 开                                    |
| 8   | Issue 运行                       | `IssueRunAdapter`                                   | ❌                                     | ❌ 无宿主维度             | `reconcileIssueRuns` | 开                                    |
| 9   | CLI ↔ 桌面                       | `cli-endpoint.json` loopback                        | ❌                                     | **仅本机**                | —                    | 开                                    |
| 10  | 服务器运维                       | `cognia-deploy-agent` ← ops-controller              | ✅ Postgres claim/lease/heartbeat      | ✅                        | ✅                   | 独立控制面                            |
| 11  | 终端会话                         | `cognia-server desktop-host` daemon                 | PTY 存活                               | 参与者名单（ADR-0133）    | ✅ replay            | 开，但远程接入需 GUI 应用在跑         |

**注意第 1 条是唯一"生产级"的派发通道**：`lib/db/mobile-outbound-types.ts` 里 24 个命令，每条都要求 UI 入队点 + Rust `KNOWN_COMMANDS` + 处理器 + 幂等键四项对齐，注释里写明了漂移会表现为 `404 unknown_command`。这是整个仓库里最应该被复用的派发范式，但它**只有客户端→宿主一个方向**。

---

## 3. 缺口清单

### P0-1 桌面宿主收得下 worker，却一帧都派不出去（静默惰性）

- `/ws/worker` 注册在共享的 `server.rs:561`，桌面与 headless 都提供。
- worker 接入后被 `install_worker` 装入内存表、`publish_fleet_update` 广播为**在线**（`ws_worker.rs:345-346`）。
- 但 `send_worker_attach` 走 `send_worker_bridge_frame` → 依赖 `SOCKET_BRIDGE`；桌面的 brain 是 WebView，不是 socket bridge。`announce_all_workers` 在 `ws_worker.rs:166` 直接早退（`current_brain_account_id()` 为 `None`）。
- attach 与 frame 的失败都被吞掉（`let _ =` / `log::debug!`）。
- `installRemoteWorkerRuntime` **全仓只有一个调用点**：`cli/src/serve/serve-command.ts:180`。桌面永远没有 `RemoteWorkerRuntime`。
- UI 侧 `components/settings/fleet/execution-workers-card.tsx`（157 行）里**没有任何 `isTauri` 分支、没有惰性提示**，桌面用户可以生成 enrollment、看到 worker 上线、然后永远等不到任何派发。

> 这同时违反工作规则 7（惰性必须在类型 + UI + 测试三条轴上标注）。

### P0-2 远程派发实际不可达：三个默认关闭的开关串联

`lib/ai/agent/execution/feature-flags.ts:114` 的 `isAgentTeamRemoteDispatchEnabled` 要求：
`agentTeamRemoteDispatch`（默认 false）**且** `agentExecutionResolverV2`（默认 false）**且** `developer.taskWorkspace`（`packages/agent-config-types/src/index.ts:4817`，注释明写 "Default off until the full runtime matrix reaches GA"）。

同类默认关闭还有：`durableWorkSubmission`（ADR-0125，chat 的崩溃可恢复语义）、HostState 迁移阶段 `lib/sync/host-state-store.ts:143` 默认 `legacy-authoritative`。

结论：**08-12 那份分析里标为 "Confirmed P0 integration gap" 的跨宿主派发，代码已经在 `lib/ai/agent/team/dispatch-teammate.ts:918-1010` 完整落地了**（选 worker、PII 二次校验、租约 CAS、`rebindResolvedAgentExecutionHost`、`preflightCrossHostDispatch`、checkpoint 恢复），但没有任何默认路径能到达它。这已经从"没造出来"变成了"造好了没通电"。

### P0-3 没有放置层（placement）

ADR-0097 的 `## Not done` 一节原文：_"Nothing chooses where a run executes. A cron or webhook trigger fires in whichever process received it — `trigger-bridge` calls `runWorkflow()` in place — and there is no desktop-liveness probe, no executor election and no handoff."_

代码侧佐证：全仓 grep 不到 `runOn` 字段（ADR-0061 的 L1 层），工作流节点没有放置约束；`IssueRunTarget`（`lib/issues/run/types.ts:24`）只有 `issue` + `project`，无宿主维度；调度器 `lib/scheduler/scheduler-host-target.ts:6-10` 注释明写 _"placement is HOST-OWNED … nothing hands tasks between hosts"_。

### P0-4 headless brain 不能做远程步骤，也不能给设备发运行事件

- `lib/workflow/runtime/remote-step-broker.ts:97`：非 Tauri 直接 `throw new Error("remote step dispatch requires the desktop companion server")`。
- `lib/workflow/runtime/companion-run-events.ts:81`：非 Tauri 静默 `return`，于是 `workflow://run-status`、`sync://invalidate`、`workflow://run-terminal` 推送在云宿主上**全部不发**。
- ADR-0128 补了入向桥（`workflow-trigger-bridge.ts`）和通知桥（`remote_notification_publish`），但**出向的运行事件扇出没有补**。

### P1-5 设备选择不看在线状态、无排队、无故障转移

`lib/workflow/nodes/actions/mobile.ts:55-62`：候选只过滤 `revokedAt`/`pausedAt`，然后 `sort((a,b) => b.lastSeenAt - a.lastSeenAt)` 取第一个。三天前见过的手机会被选中，然后阻塞 120s 超时失败——不排队、不等设备上线、不换下一个候选。
`capability-preflight.ts:85` 的 `remoteCapabilityUnion` 同样只看撤销/暂停，不看活性，于是预检通过、派发失败。

### P1-6 事件重放是内存环，宿主重启即丢

`companion_api/event_bus.rs`：`VecDeque` 上限 10,000 帧 / 24h 保留，进程内。宿主重启后离线设备的重放游标失效，只能退回 sync-pull 对账。跨设备派发如果要"宿主重启后仍然把结果送达"，这条通道扛不住。

### P1-7 设备/宿主清单碎片化（8 个来源）

1. `SecurityStore`（Rust SQLite）— 宿主侧权威设备 + grants
2. `pairedDevices`（Dexie）— 宿主侧镜像，带 `capabilities` / `capabilitiesReportedAt` / WebRTC room / 终端描述符
3. Credential Book（`lib/companion/credential-book/`）— 客户端侧"我配对了哪些宿主"
4. `stores/remote-host/remote-host-store.ts`（localStorage `cognia.remoteHosts.v1`）— 桌面能驱动的远程宿主
5. `RuntimeTargetRegistry`（`lib/runtime/target-registry.ts`）— 客户端激活目标
6. `WORKERS` / `WORKER_HISTORY`（`ws_worker.rs` 内存）+ `SecurityStore::list_worker_devices`
7. Fleet registry（`src-tauri/src/fleet/registry.rs`）— 本机 agent 会话投影
8. ops-controller agents（Postgres）— 服务器运维面

"我有哪些设备、哪些在线、哪些能跑什么"目前没有单一答案。`fleet_hosts()` 做了 6+8 的局部合并，但没有 1–5。

### P1-8 宿主离线 = 全面停摆，且无唤醒手段

- 退出应用会走 `RunEvent::ExitRequested` 拆解：关闭 CLI-bridge socket、关掉 cua 沙箱、**杀掉外部 agent / ACP 子进程**（`src-tauri/src/shutdown.rs`）。进行中的 agent 轮次直接死掉。
- 缓解手段存在但都不完整：托盘常驻（`CloseBehavior::Tray`，`lib.rs:2009`）、登录自启（`tauri-plugin-autostart`）、boot 恢复可达性。
- 缺口：无 WoL、无电源断言、push 默认 Noop，所以"手机想用桌面，桌面睡了"没有任何补救路径。
- `webview_watchdog.rs` 只在**窗口可见**时看护，托盘隐藏状态下白屏/冻结不自愈。

### P1-9 没有跨设备会话接管

ADR-0061 P4 明写延后："the symmetric session-handoff envelope + share-server blob relay for artifacts is a chat-session feature with a cross-service dependency"。`lib/task-workspace/handoff.ts` 是**工作区**接管，不是设备接管。`cli/src/handoff/` 是**本机 loopback**。"在手机上接着刚才桌面那个会话继续"目前只能靠 HostState（默认暗）+ 同步镜像。

### P2-10 worker 不是受管服务

`cli/src/cli/worker-command.ts` 只有 `enroll | bind | list | remove | connect`。`connect` 是前台阻塞循环（有指数退避重连，`worker-connect.ts:104-110`），但**没有** `daemon start/stop/status/logs`、没有 PID 文件、没有日志落盘、没有 profile 隔离、没有开机自启、没有版本漂移自重启。对比 multica 的 `multica daemon start/stop/status/logs --profile <name>` + `daemon.pid` + `daemon.log`。

### P2-11 手机无后台执行

`lib/capacitor/` 有 camera / barcode / geolocation / share / local-notifications，但**没有 background fetch / background task**。远程步骤只能前台执行——ADR-0061 P3 自己也把 "an OS background-runner path" 列为延后项。

### P2-12 调度器不能跨宿主接管

ADR-0128 决策 6 是明确的设计选择（每个宿主自己的库，客户端只选"管哪一个"）。代价是：桌面上创建的日程在桌面关机时不跑，即使账户下有一个 always-on 的云宿主。这是 P0-3 放置层缺失在调度域的具体表现。

---

## 4. daemon 问题的正面回答

### 4.1 仓库里已有的三个 daemon 前例

| daemon         | 二进制                       | 安装方式                                                                                                                                                                           | 职责                                                                   |
| -------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 终端宿主       | `cognia-server desktop-host` | macOS LaunchAgent(`RunAtLoad`+`KeepAlive`) / Linux systemd user unit + XDG autostart 兜底 / Windows `schtasks /SC ONLOGON` — 全在 `src-tauri/src/terminal_host_service.rs:230-360` | 拥有 PTY，跨应用退出存活；owner-only socket + keyring bootstrap secret |
| headless brain | `cognia-server serve`        | 容器 / compose / k8s（`deploy/`）                                                                                                                                                  | 完整宿主：数据面 + brain + sidecar + gateway                           |
| 部署 agent     | `cognia-deploy-agent run`    | systemd 系统服务（`deploy/agent/linux/`）                                                                                                                                          | 外联 mTLS WS，enrollment token，state store，只做部署操作              |

**三平台安装器已经写好了**（`set_platform_login_service`），是可直接复用的资产。

### 4.2 multica daemon 做的事，cognia 已有的对应物

| multica daemon 职责                                   | cognia 对应                                                                  | 差距                                                                                                      |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 认证接入服务端                                        | `worker enroll` → Companion 设备凭据 + DPoP + socket ticket                  | 无（cognia 更强：单次票据 + TLS pin）                                                                     |
| 3s 轮询领任务 + 15s 心跳                              | `/ws/worker` 推送 + 25s 心跳 / 90s 离线判定                                  | 无（cognia 更强：WS 推送优于轮询）。但 **cognia 没有轮询兜底**，socket 打不通就完全静默                   |
| 声明本机可用的 CLI 为 runtime                         | `AgentWorkerManifestV1.executionProfile` + `resolveWorkerExecutionProfile()` | multica 自动发现 20 个 CLI 并**每个注册一条 runtime**；cognia 一个 worker 只报**一条** `executionProfile` |
| 每任务独立 workspace                                  | Task Workspace（`crates/cognia-task-workspace/`）+ `worker bind`             | cognia P0 明确"不自动 clone"，只能预绑定一个仓库                                                          |
| 任务生命周期 queued/dispatched/running/...            | `AgentTeamChildRun` + 60s 租约 CAS + `lastRemoteEventId`                     | 无                                                                                                        |
| GC（workspace/artifact/repo cache TTL）               | 无对应                                                                       | **缺**：worker 侧没有磁盘回收策略                                                                         |
| `daemon start/stop/status/logs`、PID、profile、自更新 | 无                                                                           | **缺**（P2-10）                                                                                           |

**所以：不需要"模仿 multica 增加 daemon 进程"这件事本身**——协议、认证、租约、重放、恢复都已经比 multica 更严谨。需要的是把 worker 的**进程生命周期**补齐，以及把桌面接上派发能力。

### 4.3 如果要做，最小形态

复用 `terminal_host_service.rs` 的三平台安装器，给 `cognia-agent worker` 加：

- `worker daemon start|stop|status|logs [--profile]`，PID + 日志落在 `~/.cognia/worker/<profile>/`
- `worker service install|uninstall` → LaunchAgent / systemd user unit / schtasks，`KeepAlive`
- 轮询兜底：WS 连不上时降级到低频 HTTP 拉取（multica 的 3s 轮询在这里是**正确的冗余**，不是落后设计）
- 磁盘 GC：worker 侧 workspace / 日志 TTL

---

## 5. 建议的实施顺序（每条注明复用的既有权威）

| 序  | 事项                                       | 复用                                                                                                | 禁止新造                    |
| --- | ------------------------------------------ | --------------------------------------------------------------------------------------------------- | --------------------------- |
| 1   | **桌面宿主可派发 worker**                  | `ws_worker.rs` + `BridgeWorkerRpcPool` + `installRemoteWorkerRuntime`                               | 第二套 worker 协议          |
| 2   | **worker 惰性在 UI 标注**                  | `SettingsAlert`（`execution-workers-card.tsx`）                                                     | —                           |
| 3   | **三重开关收敛成一个可用默认**             | `feature-flags.ts` + `DeveloperSettings.taskWorkspace`                                              | 第四个 flag                 |
| 4   | **放置层（placement）**                    | `run-lease.ts` + `pairedDevices.capabilities` + `host_capabilities` RPC + `cross-host-preflight.ts` | 第二个调度器 / 第二个租约库 |
| 5   | **派发前的活性门 + 排队 + 故障转移**       | `mobileOutboundQueue` 的幂等/退避/死信范式，反向复制成 host→device 出向队列                         | 新的通用队列                |
| 6   | **headless 出向事件扇出**                  | `companion-run-events.ts` 抽出宿主中立 emit（照 ADR-0128 的通知桥做法）                             | —                           |
| 7   | **worker 受管服务化 + 轮询兜底 + GC**      | `terminal_host_service.rs::set_platform_login_service`                                              | 新的安装器                  |
| 8   | **统一设备/宿主清单投影**                  | `fleet_hosts()` 已合并 2 个来源，扩到 8 个                                                          | 第二个 fleet monitor        |
| 9   | **唤醒**（push 默认可用 / WoL / 电源断言） | `push_creds.rs` + `dispatchers.rs`                                                                  | —                           |

---

## 6. 不建议做的事

- 不要为了跨设备再引入一个任务表 / 租约库 / fleet 监视器 / 事件账本——08-12 那份分析的"强制复用映射"依然成立。
- 不要照抄 multica 的"默认不沙箱、bypassPermissions"执行姿态。
- 不要因为 multica 用轮询就认为 cognia 该改成轮询；应该是 **WS 主 + 轮询兜底**。
- multica 是 source-available 自定义许可（非 Apache-2.0），代码不可直接借用。

---

## 7. 已确认的方向（2026-08-20，与 Max 确认）

| #   | 问题         | 决定                                                                                                        |
| --- | ------------ | ----------------------------------------------------------------------------------------------------------- |
| 1   | 目标场景     | **团队多机器执行**优先——把 Agent 任务派到多台机器的 worker                                                  |
| 2   | 桌面派发架构 | **WebView brain 直接持有 worker runtime**（不新增 socket brain 进程）                                       |
| 3   | 常驻服务     | **接受完整 daemon 化**：`worker daemon start/stop/status/logs` + PID/日志 + 三平台自启 + 轮询兜底 + 磁盘 GC |
| 4   | 放置层       | **这轮做完整放置层**（含 `runOn`、活性探测、执行者选举、运行接管）                                          |

设计规格见 `docs/superpowers/specs/2026-08-20-cross-device-placement-and-worker-daemon-design.md`；
按 WORKFLOW.md，该规格必须先过 grill（stage 3）再进 plan。
