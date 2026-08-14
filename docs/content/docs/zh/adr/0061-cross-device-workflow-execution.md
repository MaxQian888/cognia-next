---
title: "0061 — 跨设备工作流执行（能力基础）"
description: "一个分层的计划，用于在桌面、移动端、浏览器和无头云上运行工作流——从平台能力词汇、节点需求、运行前检查和设备能力报告开始。"
---

# 0061 — 跨设备工作流执行（能力基础）

**状态：** 已接受（阶段 1–4 已实施；2026-08 增补持久检查点）**日期：** 2026-07-02 **分支：** `dev`

> 在开发过程中，代码注释中会以“ADR-0060”来引用;0060号同时被个人知识捕获ADR声称拥有，因此本文档为0061。引用能力/deviceId工作的代码注释ADR-0060指本文档。

---

## 背景

每个工作流运行都只在一个桌面WebView中执行。Rust（`src-tauri/src/workflow/`）拥有“工作流程何时开始”（cron daemon、webhook router、UIA watcher）和崩溃恢复;TS编曲者（`lib/workflow/runtime/orchestrator.ts`）拥有所有步骤的执行权。目前存在的每一个“远程”接口——Companion `workflow_trigger_manual` RPC 与 IM 触发器——都是*远程触发本地执行*。

对底质的研究（2026-07-02）发现：

1. **工作流程模型中没有设备身份。** `WorkflowTriggeredFrom`携带`source`但未显示*哪台设备*;伴触发的运行记录为`"ui"`。
2. **无能力模型。** 平台门槛是一个编辑器端布尔值（`NodeCatalogEntry.desktopOnly`，17个条目）;编排器在前检运行时不做，例如网页上的15个`action.desktop.*`节点在其执行者内部失败——而之前的步骤已经运行并产生了副作用。~426 个分支文件在 `isTauri()`/`usePlatform()` 上临时添加。
3. **`pairedDevices` 是认证账本，** 不是调度基底：JWT、TLS pin、rendezvous 元组、`allowRemoteControl`——没有宣告功能，也无法询问“这部手机能扫描条码”。
4. **强传输基础未被使用**：伴随的RPC允许表是spec-对等性，采用跨传输幂零测试;WebRTC DataChannel（`cognia.signaling`，ADR 0021）是对称的——电话可以*服务*RPCs;push + 移动批准卡管道存在，但从不承载工作流程事件;`lib/capacitor/`封装摄像头/定位/条码/语音/共享，没有作为工作流程节点暴露。
5. **现有的三种“切换”机制**（团队background/external切换执行器、任务委托、CLI→桌面会话传输）没有设备概念;`externalPickup.claimedBy` 是硬编码字符串`"external-bridge"`。

## 决策

### 主要模型：集线器编排远程步进

编排器停留在国家所在之处（今天：桌面;后来：ADR-0059 无头 Brain）。跨设备执行意味着集线器将*单个步骤*发送到具备能力的设备，并将结果汇入运行日志——而不是在整个设备间迁移整个运行。理由：

- 所有现有的远程接口都已经这样工作了（在状态所在处执行，然后将结果流回）。
- 运行状态深度为枢纽本地化（Dexie事件日志、`run-cancel-registry`、唤醒总线、幂零缓存、密钥环秘密）;复制它严格比发送扩展步参数+输出更难。
- 表达式由集线器在派遣前*解析，因此远程执行者无需访问`$node`/`$vars`范围。

全运行传输（一种lease/claim协议，推广团队外部采集印章和`workflowRunEvents`复制）是第四阶段“桌面关闭，云完成运行”的补充——而非基础。

### 层梯

| 层 | 什么 | 现状 |
| ----- | ---- | ------ |
| **哈哈 | 能力词汇 + 节点 `requires` + 运行预检 + 设备能力报告 | **已实现（第一阶段，本ADR）** |
| 第一语言 | Per-node/workflow安置（`runOn: device \| capability`），由枢纽解决 | 计划中 |
| L2 | `step_execute` / `step_cancel` RPC + 事件频道流媒体;电话通过对称的WebRTC信道为RPCs服务 | 计划中 |
| L3 | 切换统一：结构化`PickupTicket`（设备定向，租赁）取代`TeamExternalPickup`;`WorkflowRunRow` 租赁;跨设备取消;对称会话-切换包络 | 计划中 |
| L4 | 平台特色节点：`action.mobile.{camera,scan,location,voice,share}`、`action.approval.request`（→移动审批卡作为`decision`分支）、移动分享目标触发器 | 计划中 |
| L5 | 插件链接：验证时查阅清单`runtimeCompatibility`;插件触发每个设备运行，事件路由到枢纽;`plugin:<id>`能力标签 | 部分（类型） |

### 第一阶段（已实施）

1. **`lib/platform/capabilities.ts`** — 纯叶能力词汇。`CapabilityId` = 18个核心ID（`shell`、`pty`、`sidecar`、`keyring`、`uia-automation`、`ocr`、`camera`、`geolocation`、`barcode-scan`、`voice-record`、`share-sheet`、`push-display`、`biometric`、`webview`、`headless`、`always-on`、`connector-runtime`、`mcp-runtime`）加上`plugin:<id>`标签。`detectLocalCapabilities()`每`detectPlatform()`（tauri/移动/网页）返回一个冻结的静态基线;`headless`为ADR-0059云Brain保留。ID 是线格式——仅附加，绝不重命名。

2. **节点需求。** 在`PluginNodeDef` `NodeCatalogEntry.requires?: CapabilityId[]`且同样（+ manifest mirror），注册时复制到插件目录中。`effectiveRequires()`将一个遗留的裸`desktopOnly`映射到`["shell"]`（完全位于Tauri基线上，`desktopOnly` ≡仅Tauri）。所有17个`desktopOnly`内置节点都带有显式回填——webhook三元组→ `always-on`、git → `shell`、终端 → `pty`（脚本运行→ `shell`）——而15个未标记的`action.desktop.*`节点则需要`uia-automation`**但**不获得** `desktopOnly`（调色板可见性不变）。编辑器过滤器（`includeDesktopOnly`）被刻意保持原样。

3. **运行检查前**（`lib/workflow/runtime/capability-preflight.ts`）。`runWorkflow` 在运行行持续存在后，会对每个可执行节点（包括循环子节点;注释、种子输出和out-of-`restrictToStepIds`节点除外）与本地基线进行检查，并在 t=0 时以一次结构化、可恢复的 `capability-missing:<cap>` 错误（`WorkflowRunError.code`）失败，插件error/complete hook触发，且无副作用。`validateWorkflow`中不适用——有效性是定义的属性，运行者的能力;在网页上打开的桌面工作流程必须保持“有效”。按设计，预检重运行在恢复时：恢复装置还必须持有电容。

4. **编辑器亲和度浮现。** 共享`components/workflow/editor/capability-badge.tsx`（`useMissingNodeCapabilities`——与预检相同数学）在节点搜索侧边栏、 命令 调色板和检查器头中生成“此处不可用”徽章 + 能力提示。在 `workflows.capabilities` i18n 命名空间中显示名称（en + zh-CN）。

5. **触发设备身份。** `WorkflowTriggeredFrom.deviceId?: string`。Rust RPC层从已验证设备中的JWT注入允许列表命令的`callerDeviceId`（`rpc.rs`中`inject_caller_device_id`——覆盖任何客户端发送的值，因此无法伪造）;Companion `workflow_trigger_manual` Arm现在录制`{ source: "api", deviceId }`（之前被误标为`"ui"`）。`StartWorkflowFromRemoteInput.deviceId` 对遥控路径也同样适用。

6. **`device_capabilities_report` RPC.** 每次切换到`connected`时，移动机壳报告`detectLocalCapabilities()`（`lib/companion/capability-reporter.ts`，载荷时去重，重连时重试，由伴随启动提供商挂载）。桌面验证（`isCapabilityId`，上限为64），并持续存在到呼叫者的`pairedDevices`行（`capabilities` + `capabilitiesReportedAt`;加法非索引列——无Dexie版本提升）。故意不作为`MOBILE_OUTBOUND_COMMANDS`成员：能力报告是可刷新的快照，而非排队状态。

## 后果

### 阳性

- 对于平台不匹配节点，编排器的故障模式从“执行者在运行中因副作用而丢弃”转变为一个结构化的t=0故障，且代码可机器读取。
- 作者在按下运行前会在编辑器中查看设备亲和度，使用运行时强制执行的精确数学。
- 运行历史可以回答“是哪个设备触发了此事”——审计基底每层需要placement/handoff。
- 集线器现在知道每个配对设备能做什么——L1放置的调度基底（`runOn: { capability: "camera" }`解析基于`pairedDevices.capabilities`+活状态）。
- 全是加法：没有模式波动，能力满足的工作流程没有行为变化，插件API扩展是可选的。

### 负债/已接受债

- 基线为每个站台的静态;更细致的探查（实际上已授权摄像机许可，密钥环解锁）在呼叫时保持在`lib/capacitor`结果的假象中。能力id断言*设施*存在，而非该呼叫是否成功。
- `WorkflowNodeKind`仍是一个封闭的工会;插件类型仍通过`as never`进入（ADR 0017债务——扩展到`string`+目录验证是一个独立项目，ADR故意未捆绑）。
- 未注册的插件节点会解析为目录存根，没有`requires`，因此它们在注册表查询时仍然会失败，而不是在测试前。
- `startStepId`-bounded 对整个图进行预检（保守）;只有`restrictToStepIds`能精确定位。
- 网页调色板仍显示`action.desktop.*`条目（已有行为，现在带有徽章）;隐藏它们是UX决定，交由L1决定。

## 阶段规划（P2+）

- **P2 — 可视化 + 人工参与（已实现）:**
  - `workflow://run-status` 实时帧 + `sync://invalidate` 发布（自 ADR-0027 年以来，移动事件驱动同步频道订阅的首个发布商）+ `workflow://run-terminal` 推送，全部搭乘 `persistRunState` 漏斗（`lib/workflow/runtime/companion-run-events.ts`）。推送策略：总是失败;succeeded/cancelled只有在设备触发时才会启动;仅IDS+状态。
  - `action.approval.request`、工作流 risk gate 与 `flow.wait(event)` 现在共用持久化 `WorkflowWaitpoint` seam。pending 状态存放在 Dexie v156 与 Tauri/headless workflow SQLite mirror 中；事件日志只承担审计。重复创建保留首次绝对截止时间，决策使用“首次写入胜出”的 compare-and-set，事件先持久化后匹配且只消费一次，未匹配事件 24 小时后清理。Companion 的 `workflow_approval_list` / `workflow_approval_respond` 直接读取和决策 host-owned mirror，因此 WebView 暂停时设备仍可审批；renderer 恢复后同步终态并写入既有 Action Review Receipt。
- **P3 — 反向执行（已实现）:** 集线器编排的远程步骤，基于现有管道——代理（`lib/workflow/runtime/remote-step-broker.ts`）发出`workflow://step-execute` WS帧 + 仅 ids `workflow://step-pending`推送;手机的远程步进服务器通过`lib/capacitor`结果界面执行，并通过分块`workflow_step_result` RPC响应（64 KiB体上限下的32 KiB片;响应者身份对请求目标进行JWT-verified）。五种节点类型出货：`action.mobile.{camera,scanBarcode,location,share,notify}`带集线器代理执行器（最新设备，可钉脚）、远程感知的预检（`remoteCapabilityUnion`）和“手机运行”编辑器徽章。前景优先;延迟后续：语音录制（音频载荷需要一个blob中继，而不是分块JSON）、OS后台运行路径，以及当HTTP/WS宕机时通过对称的WebRTC DataChannel发送请求。
- **P4 — 运行租赁与索赔争议（已实施）:**
  - `WorkflowRunRow.lease`（`lib/workflow/runtime/run-lease.ts`）：在第一步前通过一次Dexie事务被认领，心跳更新（TTL/3），在每个终端路径上释放——第二个执行者会退后而不是重复执行，终端行守卫阻止续跑回放复活soft-cancelled/finished。
  - 共享取消梯（`cancel-run.ts`）在两个远程接口后：本地中止→ `cancelRequestedAt`租赁信号（拥有执行人的心跳在一拍内终止）→软取消，伴随通过P2运行状态漏斗的散开。
  - `TeamExternalPickup`发展了结构化索赔人（`{ kind: "external-agent" | "device" | "desktop", id, label }`）、`targetId`地址，以及一份10分钟索赔租赁合同，采用争夺规则：过期索赔+仍闲置的团队⇒皮卡重新广告。
  - 推迟，理由是：对称会话-交接信封+共享-服务器的BLOB中继产物是一个带有跨服务依赖（部署的共享服务器）的聊天会话功能，不属于工作流执行核心——作为独立的后续跟踪。
- **P5 — 云节点：** ADR-0059 无头 Brain在同一注册表中注册为`always-on` + `headless`设备;cron/webhook位置取决于桌面关闭时的配置。

各阶段的安全态势：PII出口复制既定模式（`redactText`向外，`hasNoLeakingPii`为通过）;无头 HITL从起源`resolveGatePolicy`继承;远程步进执行加入了每设备升级层（`control_allow_list`模式）;`keyring:*` refs 是放置约束（执行 secret 所在之处）——secret sync 是非目标。

## 参考文献

- `lib/platform/capabilities.ts` — 词汇量 + 基线
- `lib/workflow/nodes/catalog.ts` — `requires`，`effectiveRequires`，`missingCapabilities`
- `lib/workflow/runtime/capability-preflight.ts` — 进行预检
- `components/workflow/editor/capability-badge.tsx` — 编辑接口
- `lib/companion/capability-reporter.ts` + `src-tauri/src/companion_api/rpc.rs:inject_caller_device_id` — 传输 切片
- ADR 0011（工作流子系统）、0017/0034（插件扩展点）、0012/0021（传输）、0005（遥控器）、0059（无头 Brain）
