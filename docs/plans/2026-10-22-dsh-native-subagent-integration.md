# DSH 原生 subagent：接入、派生选模与已有 child 切模方案

日期：2026-10-22，Asia/Shanghai。状态：待评审方案，未实施。基线是当前共享工作树，包含尚未提交的 Codex 原生子代理接入，不能据此推定已发布版本支持。

## 1. 建议先交付原生派生与选模，已有 child 切模独立验证

**建议复用 DSH 的原生服务和 Cognia 的既有模型计划、网关、Host 控制面及 UI。** 首先为 `dsh-sdk` 增加显式启用的受管组合，登记原生身份，再交付 spawn 时动态选模。已有 child 切模属于另一项控制扩展：上游有公开的底层选模原语，但没有完整的 SDK child-model 操作，必须经过有退出条件的试验后才能开放。

| 用户能力                             | 上游 `0.2.1-rc.2`                                    | 当前 Cognia                         | 本方案交付边界                                       |
| ------------------------------------ | ---------------------------------------------------- | ----------------------------------- | ---------------------------------------------------- |
| 原生本地 spawn                       | 原生插件支持                                         | 三种受管 profile 均未组合           | P0–P1：SDK 两个权限 profile 显式启用                 |
| 原生本地 fork                        | 支持复制已完成 turn 前缀                             | 未组合                              | 权限与历史 PII 验收后开放；初期固定模型              |
| spawn 时选 provider/model/effort     | 有受控工具参数，默认关闭                             | 无 DSH child role，网关仅投影主模型 | P2：同一 Cognia provider/account、同一任务有限候选集 |
| 已有本地 child 后续采样改模型        | 有 `installModelSelection`；没有完整 child-model RPC | 无                                  | P3：受限试验，未通过则明确保持 unsupported           |
| 修改已发出的模型请求                 | 不支持                                               | 不支持                              | 不承诺；不会自动打断、重发当前推理                   |
| ACP root 配置修改 child              | ACP 不把原生 child 当普通可控 Session                | 无                                  | 首轮不开放 ACP 原生 child 控制                       |
| 外部 SDK/ACP/Codex/Claude child 后端 | 可选 provider；控制和权限语义各异                    | 未组合                              | 不纳入本地原生接入，避免扩大认证面                   |

这里的 P0–P3 是实施阶段；下文 `schemaVersion: 2` 是拟议的 **Cognia 公共契约版本**，均不是 DSH 内部存在 V1/V2 backend。

验收目标：G1 真实组合且能力可信；G2 child 身份及生命周期可查；G3 派生选模走原任务网关且严格受限；G4 已有 child 切模语义与恢复可证明，或明确报告不可用；G5 不重复实现调度器、票据、模型选择器或子代理 UI。

## 2. 当前缺口横跨组合、身份、模型计划和控制契约

以下为代码核对事实，非新增实现；上游证据固定到 `dsh-v0.2.1-rc.2`。当天调查时 npm latest/next 与该版本一致，后续实施仍须重新认证版本。

| 现有所有者                                                  | 已有能力                                                   | 需要补齐                                                                                      |
| ----------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `packages/agent-dsh/runtime/launcher.mjs`、`host.sdk-*.yml` | 严格受管组合、网关 LLM、MCP、启动 readiness、沙箱          | 原生插件及受控 child preset；必要的窄 SDK 控制入口                                            |
| `packages/agent-dsh/src/channel.ts`、`manifest.ts`          | profile/plugin inventory、协议与有效能力分离               | native-enabled 认证、真实来源证据与细分操作能力                                               |
| `sdk-client.ts`、`event-codec.ts`                           | lineage 路由、等待 descendants、过滤 child 正文            | 原生 child 快照、根会话 native resume、控制投影；不能把现有 `children` 集合当 native registry |
| `model-slots.ts`、`model-plan.ts`                           | 共享 role/default/candidate 编译、有限集合、fingerprint    | DSH `subagent.default` 与受认证的 spawn overrides 描述                                        |
| `gateway-task.ts`                                           | DSH Cognia provider、任务票据；其他 runtime 已用多模型计划 | 从冻结计划投影完整模型集及准确 metadata，当前 DSH 分支只有 primary                            |
| `manager.ts`                                                | 原生操作路由到实际 gateway adapter/session、候选模型复核   | runtime-neutral 的契约分支和 DSH capability gate                                              |
| `agent-contracts/src/session-operations.ts`                 | 原生 snapshot/change 契约                                  | 当前含 Codex backend、thread identity、current/future turn 语义，不能直接假装适用于 DSH       |
| `runtimes/remote/remote-run-{client,service}.ts`            | Host 所有权、会话操作 RPC                                  | 协商后的新分支；旧 Host 必须拒绝而非丢字段降级                                                |
| `RoleModelFields`、`ExternalAgentSessionOperations`         | 模型角色编辑、原生 child 卡片与模型控件                    | 由每项真实 capability 驱动可见性、scope 和状态                                                |

架构遵循 ADR-0090 的同任务网关授权及跨 provider/account 的编排边界、ADR-0217 的 package/Host-port 分层。子代理 preset 若来自 Harness Evolution，沿用 ADR-0237 的批准版本，不另造可由模型写入的权限配置。

## 3. 一条受管控制链连接现有 UI、Host 与原生服务

下图的新增责任是 DSH 桥接和能力投影；执行、权限、票据和模型 UI 仍由现有模块拥有。

```text
RoleModelFields / ExternalAgentSessionOperations
            | shared model plan / versioned session operations
            v
ExternalAgentManager -- existing paired Host RPC when remote
            | resolves actual task owner and gateway session
            v
@cognia/agent-dsh adapter + existing JsonRpcPeer/process Host
            | one stdio reader/writer
            v
managed DSH SDK entry
  standard requests -> official HarnessSdkJsonRpcServer
  Cognia extension  -> bounded child query/control bridge
            |
            +-> native subagent service, spawn/fork providers, control tools
            +-> official LLM adapter -> existing Cognia gateway task lease
```

初期配置只增加一个 typed opt-in，例如 `dshOptions.nativeSubagents.enabled`，默认 false；名称为提案。child 默认模型与候选继续使用现有 `modelRoles`，不另设 `dshModels`。并发与深度先固定为受管配置：`maxDepth=1`、`maxActiveSubagents=8`，与当前上游默认一致；不能由模型参数拓宽。

同一 DSH process 内运行 native child。Cognia 现有 teammate/job 系统继续拥有跨 runtime/provider/account 的任务，不接管这些 native child，不创建镜像任务树或第二套持久化调度器。

### 3.1 先认证 profile，再宣告支持

扩展现有 managed manifest/overlay，不替换为完整 Web bundle。启用时组合上游 `dsh-subagent`、`dsh-subagent-spawn-in-process`、`dsh-tool-subagent`、`dsh-tool-subagent-control` 及其 `/list-agents` 入口；fork provider 在通过相应验收后组合。默认关闭时保持既有行为。实际 import 的包加入 runtime direct dependencies，版本精确锁定。

同步更新 runtime lockfile、overlay digest、installer/package closure、channel inventory 和 manifest refinement；不能只把 `subagents: false` 改成 true。SDK wire 支持 lineage 并不证明 native producer 已加载。

能力来源应包含 runtime package version、profile digest、实际加载插件、桥接协议版本和已认证操作。受管运行时不匹配、未完成 readiness 或无法读取能力时，返回 unknown/unsupported，不按版本字符串猜支持。

readonly/workspace 必须各自认证。child 使用 Cognia 允许的 preset，保持根会话 authority ceiling；禁止模型提供任意 preset 路径、persona 或 toolFilter。上游 child 不会自动复制父 agent-local 工具限制，必须验证 child preset 的工具集合。不能把 native FS readonly 等同于 Cognia MCP 工具也只读；MCP 委托必须沿用已有 broker 的授权与身份链，未验证前不向 child 开放相应 governed tools。

### 3.2 SDK 控制入口复用官方 server，不能增加第二个 stdin reader

标准 SDK 仅有 initialize、prompt、resume、wait、working-directory get/set、shutdown，没有 child 查询/选模操作。内置 SDK entry 的 transport/server 是 `apply` 局部变量，不能靠 sibling plugin 注册新 RPC。

推荐先争取上游提供 request-extension hook。若当前固定版本没有该 hook，则在既有 runtime 下增加一个窄 managed SDK entry，使用公开的 `HarnessSdkJsonRpcServer`、`handleRequest`、`JsonRpcLineTransport`：标准请求全部委托官方 server，只有 Cognia namespace 的能力与 child 查询/控制由桥接处理。只替换 SDK transport entry，保持原 readiness、通知、关停 flush 和 root dispose 顺序。

新 entry 是必要的新文件：现有 launcher 负责受管服务装配，官方 entry 没有扩展点；不应把一套完整 SDK server 塞进 launcher 或重写协议引擎。目录及文件名在实施时按实际 exports 确定。不得读取官方 server 私有 session map、另起 HTTP 服务或在 renderer 引入 DSH kernel。

此入口替换先作为独立试验验证；不能把“公开 class 可导入”当作完成兼容证明。如果失败，仍可研究仅靠现有 lineage 的有限只读展示，但不把它宣告为完整 P0/P1 身份与控制支持。

## 4. 原生身份以 durable Session 和实时 activation 双重绑定

原生 child 的 Agent id、Session id、activation generation 各自有含义，不假定它们相等。UI 需要稳定的 child Session 身份；控制命令需要实时且受本任务拥有的 Agent。

| 字段/事实                              | 所有者与用途                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| root/parent/child Session id           | DSH header、原生 descriptor 与父级 `subagentCatalogProjectionDefinition`；恢复、展示和 ancestry |
| live Agent id + direct creator         | 公共 `ctx.agents.get`、`ctx.agents.isOwnedBy(childId, exactParent)`；运行时所有权               |
| processGeneration                      | Cognia process 生命周期，重启后拒绝旧请求                                                       |
| activationGeneration                   | 桥接维护的 child activation 代数；同一 durable child 冷恢复后必须变化                           |
| planFingerprint                        | 冻结网关模型计划；拒绝旧授权操作                                                                |
| activity / task outcome / continuation | 分开记录：inactive 不代表任务成功，接受 interrupt 不代表 descendants 已停止                     |

身份采用两阶段登记：在可等待的 `agent/created` 内，使用 exact creator 与 child own descriptor 建立 provisional identity，并在 P3 安装唯一 selector，然后返回；parent catalog 提交后再确认 durable ancestry 并发布可操作快照，publication 失败撤销 provisional 记录。**不得在 `agent/created` 内等待 parent catalog**：上游要等 `agents.create()` 返回后才写 catalog，否则形成循环等待。selector 需要早于首次工作释放，但 UI 控制权必须等完整归属确认。`subagent.started/finished` 和 `request/header` 驱动投影与对账，单条通知不是任意 child 的授权凭证。恢复时同样验证 own descriptor、实时 creator 与完整 ancestry。

父级 native catalog 是持久化事实源，adapter 仅保留有界快照、generation 和待处理操作，不增加 Dexie child 表。对账只读取本根可达的 catalog，递归模式受深度与数量约束；分页建议每页 128、单快照最多 256 条，必须携带 truncated/cursor。未显示目标不能因知道 id 就获得控制权限。

### 4.1 根 Session 原生恢复是跨进程恢复 child 的前置项

当前外层 `DshSdkClientAdapter` 没有 native resume，`GATEWAY_RUNTIME_TRAITS['dsh-sdk'].continuity` 是 `transcript`。重新接续会生成新 root 并回放 transcript，不能据此读取原 root 的 child catalog。上游有 `session/resume` 并不代表 Cognia 已接通它。

因此 P1 的首批身份/消息能力先限定在现存 root process；重启后 UI 标记旧 children 不再可控，不把新 root 的 children 合并到旧树。另设 **P1b native root resume**：经现有 adapter/manager resume 契约和任务连续性路径保存并恢复原 root Session id、受管 session root、profile digest 与冻结计划；在同 owner/device/provider/account 下取得新 lease，要求已存策略、默认/继承模型与新授权完全兼容，调用标准 `session/resume`，再从 owned catalog 重建 children/generations。不得在普通 child 查询中自动 resume 或发 prompt。

绑定只保存非密钥身份/恢复 metadata，复用既有会话与任务 metadata 所有者；token 不持久化，不新建 child 数据表。P1b 通过之前，SDK continuity 维持 transcript；只有 opt-in、已认证 native profile 可以宣告 native-resume。P3 的产品级冷恢复验收必须依赖 P1b，S2 直接操作上游 SDK 的恢复测试只能算 runtime 可行性证据。

保留现有正文隔离：child 文本、工具结果与最终输出不直接混入 root answer stream；展示 child 摘要应复用已有脱敏/结果展示规则。不要复制含隐私的全文进 lineage metadata。`session/wait` 仍由现有 adapter 等待根及 descendants，不能因根 idle 提前结束网关票据。

## 5. 派生选模直接连接既有 model plan 与上游开关

**P2 不需要新派生引擎。** 模型调用原生 `subagent` 工具，上游创建 child；Cognia 决定允许候选与 child 默认值，并供给原任务网关路由。

1. `model-slots.ts` 为受认证、已启用 native 的 `dsh-sdk` 声明 `subagent.default` 与 spawn overrides 支持；ACP 不宣告。`RoleModelFields` 自动复用现有角色、候选模型和同 provider/account 选择逻辑。
2. `model-plan.ts` 编译既有 primary、child default、`allowedSpawnModels`，保持有限并集最多 32 个模型及既有层级覆盖语义。计划冻结后生成 fingerprint，不在运行中修改 allowlist。
3. `gateway-task.ts` 将完整计划交给现有 multi-model lease，复用票据、预算、审计与到期处理；DSH config 的 `providers.cognia.models` 同步投影所有准入模型，而不是只列主模型。不能只改模型列表而保留单模型 ticket。
4. DSH 内部 provider 统一为 `cognia`；候选是精确 `(cognia, modelId)`。真实 provider/account 仍由网关绑定，不把账户 key 发给 child，不允许工具传任意 endpoint/provider/env。
5. 在现有受管启动服务组合公开的 `@deepseek-ai/dsh-tool-subagent/model-selection-settings`，设置 enabled 与精确 allowedModels。只有 spawn tool 启用 `modelSelectionSettings`，避免多个实例争抢 `list_subagent_models`；fork 保持 false。
6. child 默认模型写入 spawn 的 `agentOptions`。启用动态选模后，模型可传 provider/model/effort；provider/model 必须成对，effort 必须受该模型能力约束。未知或越权路由在创建 child 前拒绝，网关再独立校验 ticket。

上游会把策略保存到新 root Session，并由 children 继承；旧 Session 没有策略时保持关闭。导入设置、修改全局候选或新增模型不悄悄放宽运行中的任务，需新建任务/重新批准计划。恢复时不尝试原地缩窄上游首条生效的策略：必须在 root admission 前证明已存候选及 default/inherit 路由均仍在新 lease 授权内，且当前治理允许恢复原冻结计划；否则拒绝整个 native resume，提示显式新任务。仅重投影较小模型列表不足以改变旧策略，也不能阻止默认/继承路径创建 child。没有已验证的公共 pre-delegation hook 时，不承诺“取交集后继续恢复”。不得回退直连 provider。

### 5.1 第一批候选需限定兼容性，不能只看模型 id

现有 DSH gateway 投影含 provider 级 compatibility 配置，子代理又会继承部分 agent options。新增 candidates 时要核对每个模型的 context/output、tool calls、输入模态、reasoning effort 和协议兼容性，不能复制 primary 的 metadata 给所有 child 模型。

P2 首批只允许相同 provider/account、已验证 Chat Completions/tool-call 兼容的候选 cohort。若 provider 级开关无法表达模型差异，则拒绝该组合，而非声称任意网关模型可混用。child 的受管 token 上限取候选可承受的共同上限；root 上限不受牵连。变更 route 时未显式传 effort 应遵循上游清除旧 route effort 的规则；不把 `maxTokens` 变成模型可任意指定参数。

模型候选清单用于发现，执行时的 exact allowlist 与 gateway ticket 才是授权。默认 child 与动态候选的最终集合由共享编译器产生，不能各自在 UI、launcher、adapter 维护另一份规则。

## 6. 已有 child 切模的准确语义是“下一次尚未开始的 prompt assembly”

**P3 是带技术退出条件的控制扩展，不是直接调用标准 SDK setModel。** 公开 `installModelSelection(agentCtx, ref)` 可在 assembly 开始捕获 `ref.current`，最终模型请求使用捕获值。若本次 assembly 已开始，切换只能影响再后面的采样；已发出的 HTTP 请求不变。

| 场景                                 | 计划行为                                                              |
| ------------------------------------ | --------------------------------------------------------------------- |
| live child，下一次 assembly 尚未开始 | 接受选择，随后通过实际 request header 确认模型                        |
| assembly 已开始或 HTTP 在途          | 当前请求继续旧模型；新选择等待后续 assembly                           |
| idle、仍驻留的 child                 | 记录选择，不自动 prompt、不唤醒、不花费推理；有后续工作才生效         |
| 冷 child                             | 初版拒绝切模；恢复流程先重放已持久化选择，再由显式 follow-up 开始工作 |
| disposed / foreign / generation 变化 | 拒绝，不自动替换 child，也不把新 child 冒充旧身份                     |
| 新请求发生前 child 已结束            | 保留“已接受但尚未观测使用”，不能显示实际生效                          |

DSH 拟议 scope 为 `subsequent-requests`：选择持续影响该 child 后续请求及后续 turn，直到下一次有效选择。**不声称它具有 Codex 的 current-turn-only / future-turns 两个独立设置面。** 首轮限制同 cohort 的受管文本模型，fork child 的切模在恢复与继承授权验证完成前不开放。

### 6.1 四个实质缺口必须解决后才能发布

| 缺口                        | 具体实现要求                                                                                                                               | 发布判据                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| 无标准 SDK child-model RPC  | 复用第 3.2 节窄 entry 与现有 Host 操作链；一 child 只有一个 selector owner                                                                 | 标准 SDK 流量及关停无回归；旧客户端不会误解           |
| descriptor 不能代表后续选择 | `subagent/descriptor` v3 为首条生效，不能追加第二条覆盖；另用受控事件和投影保存选择意图、revision 与 lastUsed                              | 冷恢复仍选 B；不靠改写历史文件或私有字段              |
| 输入准入仍读创建时 options  | 上游 image admission 使用 `agent.options.provider/model`，可能与 selector 不一致；争取共享 effective-route hook，不能修改 borrowed options | 不兼容输入确定拒绝；输入准入与实际选模一致            |
| runtime 选择不等于实际使用  | 区分 requested selection 和 lastUsed；以 `request/header` 更新实际模型                                                                     | 只接受未推理时 UI 为 pending；真实新请求后才 observed |

持久化先复用上游已有 `model/selection` / `request/header` 的选择和 lastUsed 语义；其投影目前由 Web controller 注册，SDK 中不能假设自动存在。operationId、单调 selectionRevision 等额外控制事实只有在公开扩展机制允许时记录 Cognia namespace，不另造一套模型历史。不写 key/prompt。追加事件还不等于持久化完成：必须等待 `session/flush` 的 durability checkpoint，之后才能发布 durable accepted；checkpoint 失败则返回失败/结果未知并对账。冷恢复使用 `Session.ownEvents()` 或 `inheritedEventCount` 之后的 owned events，先核对新 lease 授权再恢复 ref。不能用 `firstLiveSeq` 过滤继承：冷恢复时它也排除本 child 全部旧事件。fork 的 inherited selection 不得自动成为 fork 自己的授权。

这些事件会进入 SDK `session.event`。**实施前必须确定公共注册/投影 API 和当前完整 wire schema 是否接纳扩展事件。** 若接纳，在 adapter 明确验证 Cognia namespace 后转换，其他未知上游事件仍触发 `DshVersionDriftError`；若不接纳，需要上游扩展机制，P3 保持关闭。不能放宽全局未知事件校验绕过兼容问题。

上游 Web `SessionController` 已有 selection/projection/输入串行机制，但明确拒绝 native-child Session；不能把 Web 服务整体挂进 SDK，也不能同一 child 安装两套 selector。优先上游抽取共享的小型持久化选择与 effective-route 接口；固定版本的受限实现仅在公开 API 足以闭合上述四项时采用。

### 6.2 先做两个有退出条件的试验

- **S1：SDK entry / 身份桥接，预算 1 个工程日。** 使用固定 runtime 和 managed Node，实测 readiness、标准方法委托、native catalog 查询、exact owner、通知顺序、shutdown flush/drain。缺公开 API 或生命周期不可保真时停止自建入口，转上游 hook。
- **S2：child 选模 / 恢复，预算 2 个工程日。** 真实 DSH process 配 loopback LLM 的 A/B 同能力模型，验证 assembly 前后、在途、不唤醒、cold resume、fork inherited events、输入兼容、重复操作及断连恢复。任何一项无法公开 API 闭合，P3 unsupported；P0–P2 可独立交付。

预算是止损上限估计，不是已经执行的时间或可发布日期。试验应扩展现有 launcher/services smoke 与 DSH adapter smoke，复用已有 fixture server；不再创建一套平行验证框架。

## 7. 公共原生操作契约先去除 Codex 假设，再复用 UI

现有 `ExternalAgentNativeSubagents` 含 `backend=v1/v2`、Codex feature flags、thread id 与 current/future scope。直接塞 DSH 数据会造成能力误报。建议在同一 `session-operations` 合同和 Host dispatch 内增加协商后的 v2 分支，而非复制一套 DSH 专属 UI/RPC transport。

| v2 需要表达                                      | 规则                                                                 |
| ------------------------------------------------ | -------------------------------------------------------------------- |
| `runtime`, `nativeIdKind`, root/parent/child ids | DSH 使用 session 身份；live Agent id 留在受管控制器内                |
| per-child operations                             | 分开 read、send、interrupt、modelChange；可接收消息不等于可切模      |
| supported model-change scopes                    | DSH 只在 P3 通过后列 `subsequent-requests`；Codex 保持实际 scope     |
| requested / lastUsed / selectionRevision         | 不把接受回执当实际模型；无后续采样可一直 pending                     |
| process/activation generation、fingerprint       | 所有 mutation 都校验；读取快照也标明来源与是否截断                   |
| runtime-specific diagnostics                     | Codex backend/flags 放 Codex 分支，DSH 放 profile/plugin/bridge 证据 |

具体兼容策略：既有无版本调用继续返回原 Codex 契约；新 adapter/manager 增加显式 `schemaVersion: 2` 请求/响应，Host action union 增加独立可识别分支。客户端只在 Host 广告新 marker（拟议 `external_agent_native_subagent_control_v2`）时发送。新 marker 表示合同可解析，**不等于 DSH runtime 已启用**，实际能力仍来自 session snapshot。既有 `external_agent_config_model_roles_v2` 只证明角色配置格式支持，不能当作 DSH producer 认证。

协议输入采用封闭 schema；更新 canonical companion command 描述、TS/Rust 映射及生成物，保持旧分支原样。旧 Host 对 DSH opt-in、候选或 v2 mutation 返回明确升级提示，不静默删字段。新版 UI 将旧 Codex snapshot 与新分支归一到同一个 view model，Codex 已有控制必须有回归测试。

模型设置继续使用 `RoleModelFields`、`CogniaModelPicker`/既有 provider model list；child 面板继续使用 `ExternalAgentSessionOperations` 内原生卡片和 `NativeSubagentModelControls`，把当前 Codex 固定 scope 改为真实 capability 生成。所有新增用户文案使用现有 next-intl 双语 split source；不增全局 child store、TooltipProvider 或另一套模型 picker。

## 8. 操作顺序、失败恢复与权限边界由同一 owner 串行化

每个 model mutation 输入包含 operationId、根会话上下文、child Session id、expectedProcessGeneration、expectedActivationGeneration、expectedPlanFingerprint、expectedSelectionRevision、model/effort 和受支持 scope。provider/account/endpoint/token 由任务 owner 解析，客户端不能提交。

服务端顺序：验证 Host caller 与 root owner → 解析实际 gateway adapter → 检查 owned catalog/实时 creator/generations → 冻结计划与能力校验 → 按 child 串行化并 CAS revision → 持久化选择 → 更新唯一 ref → 返回 accepted-awaiting-request。每次真正采样仍需有效 lease，票据已失效则拒绝并报告，不回退直连。

控制状态如下；它与 DSH activity state 分离：

```text
idle -> validating -> accepted-awaiting-request -> observed-in-request
           |                    |
           +-> rejected         +-> outcome-unknown -> reconcile/read
```

同一 operationId + 相同 payload 返回相同结果，异 payload 冲突；未知结果先读持久化 revision/operation 记录再决定，不自动重发。根存活期内记录已接受操作，按原生 session 持久化；热缓存可有界，但不可因为 LRU 驱逐而再次执行旧 id。重启后客户端必须先读新 generation，旧 mutation 仍拒绝。

查询建议超时 5 秒、mutation 10 秒（设计目标，非实测）。超时只说明调用者停止等待，不撤销已接受选择；outcome-unknown 时锁定该 child 的后续切模，完成对账后解除。事件推送与用户刷新驱动 UI，避免高频全量轮询；lease 关闭/进程退出时使实时快照失效。

per-child interrupt 只停止它当前 turn，保留 inbox 和 descendants；清理必须使用 native dispose/drain 的语义。root cancel 沿用 Cognia 的 session-process 终止边界，处理该 root 的全部 children，等待有界 drain 后回收 lease；不影响其他 Cognia session process。

必须证明新 spawn、follow-up、tool result 触发的每次模型请求都经过既有 outbound PII gate。adapter 初始 prompt 经过 `AgentOutboundGate` 不足以证明 DSH 内部 child/工具派生请求也被脱敏；gateway 也不能仅因是受管路由就视为已检查。实施时追到实际 provider 出站边界，复用 `hasNoLeakingPii` 和现有 gate；发现缺口先补共享出站边界，不另造 DSH redactor。原生官方 DeepSeek 直连和 Cognia gateway 分别认证；不能把一条路径结果泛化到另一条。

fork 复制隐藏历史，因此在全历史出站保护、准入权限和继承策略未通过前保持关闭。纯 web 无 Host 不执行；paired web/mobile 只调用真实 Host 能力；renderer 不增加 Node/服务端依赖，保留 static export。

## 9. 实施包按现有所有权划分，各阶段可独立关闭

| 阶段 / 单一责任角色              | 主要改动位置                                                                           | 依赖                             | 验收与关闭条件                                                                                  |
| -------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------- |
| P0 / DSH runtime owner           | runtime manifest/overlays/launcher、channel/manifest、S1                               | 无；先核对并发工作树             | 真实 profile 工具可见且权限不扩大；身份桥接失败不宣告完整可控                                   |
| P1 / Agent contracts owner       | shared session-operations、DSH adapter/transport、manager、Host RPC、原生 UI 归一      | P0、v2 协商                      | 现存 root 的 children 身份/结果隔离；消息与 interrupt 按公开原生服务接入；跨进程恢复由 P1b 验收 |
| P1b / DSH continuity owner       | SDK adapter resume、manager/session metadata、gateway continuity 与 retained task home | P1、S1                           | 同 owner 下恢复原 root/catalog；新 lease 验证且旧 generation 失效                               |
| P2 / Gateway/model-plan owner    | model-slots/plan、gateway-task、settings projection、RoleModelFields                   | P0、冻结多模型 lease；UI 依赖 P1 | 第一请求即命中所选模型；越权候选零模型请求；旧任务策略不变                                      |
| P3 / DSH control owner           | S2、持久化 selector/effective-route hook、change contract/UI                           | P1+P1b+P2+公开扩展可行           | 全部切模/恢复边界通过才启用；失败保持 unsupported                                               |
| Integration / verification owner | 现有 smoke、Host/E2E、i18n、发布认证                                                   | 各阶段                           | 独立记录 headless、真实 DSH、真实 Host/UI、provider 结果                                        |

首次实施只推进 P0–P2 与 S1/S2 的受控试验；不把上游接口协调、图像任意选模或 ACP child 控制隐含在“接上插件即可完成”中。以上是责任角色，不是本轮已经派发的实施工作。

回滚按阶段 feature gate：先禁 P3 mutation，其次禁 spawn overrides，最后禁 native profile。存活任务保持已冻结的原 profile/计划，不热卸载插件或改票据；撤销授权时按任务终止清理。已有 session/catalog/选择事件保留，新 runtime 只恢复其能验证的 profile 和事件版本；不兼容时只读/拒绝恢复，不删历史。

## 10. 验收需真实 DSH 进程，fixture 通过不等于真实 provider 或桌面通过

| 编号 / 目标 | 必须执行的检查                                                                                 | 通过证据                                                                         |
| ----------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| T1 / G1     | opt-in off、SDK readonly/workspace、缺包/错 digest/未 ready、ACP                               | capability 与真实工具集一致；readonly child 写/shell/MCP 越权失败                |
| T2 / G2     | 并发 spawn、catalog 对账、恢复、伪造 ancestry、旧 activation、截断、子正文隔离                 | 稳定 child 身份且 foreign 不可操作；root 无 child 正文污染                       |
| T3 / G3     | root=A、default=B、显式 child=C、候选外 D、effort 与 metadata                                  | loopback 实际首请求分别命中 B/C；D 在创建/出站前拒绝；同一任务 token             |
| T4 / G3     | 计划变更、候选清空、旧 Session 无 policy、恢复 B→A 收窄（含无 override）、lease 过期、预算耗尽 | 策略/默认路由收窄时拒绝 root resume、零 child 创建；不扩大/回退；模型并集最多 32 |
| T5 / G4     | assembly 前后/HTTP 在途切 A→B，idle、结束、两个 child 同时修改                                 | 在途仍 A；后续 header 才 B；parent/兄弟不变；不发额外 prompt                     |
| T6 / G4     | 冷恢复、进程崩溃窗口、重复 operation、CAS 冲突、timeout、fork 继承、扩展事件 drift             | durable revision 对账；旧 generation 拒绝；未观测不能标生效                      |
| T7 / G4     | 文本/图像/工具/effort/output 能力不匹配及 selector owner 冲突                                  | 确定拒绝或唯一一致路由；不得更改 immutable options 掩盖缺口                      |
| T8 / G1–G4  | 每次模型请求 PII 哨兵、fork 历史、follow-up、tool output、两个 provider 路径                   | 实际出站无泄漏；门禁拒绝时不发送 provider 请求                                   |
| T9 / G2     | root idle 但 child running、interrupt、dispose/drain、root cancel                              | 不提前完成/回收 ticket；root cancel 后全部 owned child 清理                      |
| T10 / G5    | 旧 Codex/旧 Host、版本协商、paired owner、纯 web/mobile、UI 双语                               | 旧分支行为保留；未认证时禁用并给原因，无静默降级                                 |

测试入口：扩展 `packages/agent-dsh/src/*.test.ts`、runtime 的 launcher/services smoke、`scripts/smoke/deepseek-harness-adapter-smoke.ts` 及现有 model-plan/gateway/manager/remote/UI 相邻测试。Jest 通过根 `pnpm test`；Node smoke 使用其实际 package script/现有 runner；实施时先核对当前命令，避免绕过项目准备流程。

按用户约束跳过 typecheck 和 Tauri build；不运行 coverage。未来实施需要相关 lint、静态导出检查、i18n build/check/lint 和 focused tests。真实 Host/UI、真实 provider 验收单列，缺环境时明确未完成，不能用 loopback 冒充。当前旧研究的 4 suites / 203 tests 只证明当时 adapter 基线，不证明本方案新能力。

日志只记 runtime/profile/version、operationId、状态/拒绝原因、耗时及受控诊断 id，不记 token/prompt/child 全文。指标聚合到 runtime/profile/action/status，避免 session/model id 的无界标签。出现归属不一致、恢复无法读懂选择事件、outbound gate 拒绝时停用该控制并告警；不得继续猜测状态。

## 11. 待决策项有默认建议，实施前核对技术闸门

| 问题                        | 选项与建议                                                            | 决策角色 / 截止                           |
| --------------------------- | --------------------------------------------------------------------- | ----------------------------------------- |
| Q1 首发协议与权限           | 建议 SDK readonly/workspace opt-in；ACP 后续单独认证                  | Maintainer / 实施启动前，日期待排期       |
| Q2 第一期交付               | 建议原生 spawn、身份、消息/中断和派生选模；fork 通过 PII/恢复验收再开 | Maintainer / 实施启动前，日期待排期       |
| Q3 已有 child 切模          | 建议 S2 先证明完整边界；优先上游共享 hook，失败不承诺产品能力         | Runtime owner / S2 结束，日期待排期       |
| Q4 跨 provider/account 候选 | 建议继续走 Cognia 编排；native task 内仅同一绑定                      | Gateway owner / P2 设计冻结前，日期待排期 |

未确定开工日期，不虚构 ISO 发布 DDL。试验相对预算见第 6.2 节；排期确定后由对应 owner 写入绝对日期。用户本轮仅要求方案，不执行上述实施或外部发布。

## 12. 评审记录与证据

评审主张：能复用现有模型/Host/UI 资产完成原生接入，但已有 child 切模只有在身份、采样边界、持久化与输入准入同时闭合后才可宣告支持。反证条件：必须依赖私有字段、SDK 入口不能保真、选择恢复会回旧模型或输入按旧 route 准入。

| 日期       | 评审                              | 结果                                                                                                          |
| ---------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 2026-10-22 | 当前工作树及固定版本公开 API 核对 | 已分清 upstream/profile/wire，识别 SDK entry、冷恢复、输入准入与 Codex-shaped 合同缺口                        |
| 2026-10-22 | 独立反向审查                      | 完成；修订 root native resume 前置、旧 policy/default 与新 lease 不兼容时拒绝恢复、created/catalog 两阶段登记 |

本文件是新增的执行方案；已有 research report 继续作为能力事实报告，Codex plan 继续描述其自身实施，不在那些文档里混入不同 runtime 的实施契约。

### Sources

- [当前 DSH 能力调查与基线验证](../reports/2026-10-22-deepseek-harness-subagent-research.md)；固定源码/package cache：`.cache/research/dsh-subagents-2026-10-22/`。
- [统一子代理模型/网关方案](2026-10-20-subagent-model-catalog-gateway-unification.md)、[Codex 原生控制方案](2026-10-21-codex-native-subagent-model-control.md)。
- [ADR-0090](../content/docs/en/adr/0090-unified-agent-execution-and-gateway-compatibility.md)、[ADR-0217](../content/docs/en/adr/0217-agent-integrations-are-packages-behind-host-ports.md)、[ADR-0237](../content/docs/en/adr/0237-an-agents-harness-evolves-through-probed-approved-versions.md)。
- [原生 delegation tool 与选模配置](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/subagent/tool-subagent/README.md)。
- [原生服务与生命周期](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/subagent/subagent/src/manager.ts)。
- [request-time selector](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/core/agent/src/model-selection.ts)。
- [SDK wire 合同](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/sdk/protocol/src/types.ts)、[SDK server entry](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/sdk/server/src/index.ts)。
- [Web SessionController](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/api/session-controller/src/index.ts)：仅参考其机制；不是可直接用于 native child 的控制入口。实施时按 pinned package 实际导出核实 API。
