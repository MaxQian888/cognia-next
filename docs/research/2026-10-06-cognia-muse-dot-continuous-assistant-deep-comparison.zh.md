# Cognia、Muse、dot：持续型个人助手的第二轮场景对比

本轮结论：**Cognia 的主要缺口已经不是“有没有记忆、调度、多 agent、远程执行”，而是这些能力之间是否形成一个用户能长期信任的连续任务合同。** 当前源码提供了很多上一轮容易低估的能力；真正需要优先处理的是建议进入任务、关闭后的数据管理、跨渠道任务指向、受限任务的远程执行，以及“执行完成”到“交付被确认”的衔接。

## 1. 快照、范围与证据等级

- 检查日期：2026-10-06；关键源码复核截至 **12:46:45 UTC（20:46:45 UTC+8）**。起始 HEAD `2f3a9b1d1f7633ceb77b5f3bb0a741376d364966`；结束 HEAD 已由并发任务推进至 **`9449c4dd2a6e3096f7103961a045832b2416e082`**，提交时间 `2026-10-06 20:41:51 +0800`，标题 `feat(gates): verify renderer invoke argument parity`。中间还有 `a932d1086 fix(plugin): match the native signing contract`。已只读比对这两个新提交的文件清单：影响 plugin signing 与 invoke 门禁，不改本报告五项缺口的核心源文件；这些文件相对新 HEAD 也无 dirty diff。这比上一轮远端 `aa98d12` 和已知本地 `8c9edb7` 更新。
- 本轮读取的是**工作树，包括未提交变更**，不是只读 HEAD 内容。检查期间其他任务持续修改 Office、Squad 手机启动、RPC/协议及构建门禁；因此这是带时间窗口的观察，不是原子冻结快照。
- 起始 dirty 包括 `lib/companion/agent-team-write-handlers*`、`desktop-write-source*`、`lib/plugin/security/signature*`、presentations model/tools、Companion RPC，以及未跟踪的 `lib/execution/squad-start-dispatch.ts` 和另一份 Office 报告。后续增至约四十余 tracked 改动，并出现 Squad UI/测试、Office conversion、新门禁等新增文件；**全部是并发任务所有，本任务未改动、暂存、提交或还原它们**。
- 已读根 `AGENTS.md`，仓库内未找到额外 `AGENTS.md`；已读并采用 `.agents/skills/concurrent-tree-safety/SKILL.md`、`.agents/skills/map-requirement-flow/SKILL.md` 及完成清单。查阅 ADR-0019、0128、0137，并结合 ADR-0103、0204、0202、0169 所对应实现/测试核验。没有编写应用代码，因此没有启动 Next 或运行代码生成。
- 唯一写入是本独立报告：旧报告基于不同快照和较浅功能比较，保留它们有助于追踪结论变更，不适合直接覆盖。
- **未运行任何测试、安装、服务或构建；未访问 Cognia 线上部署；未读取凭据；未做攻击路径或部署安全审计。** 文中“测试证据”只表示已读测试源码，不表示本轮测试通过。

证据分三级：**P＝官方公开承诺**（只说明对外合同）；**C＝本地实现/测试源码证据**（可核验控制流）；**U＝尚未运行实测或不足以判断**。C 内再区分“直接确认”和“由代码推导的场景风险”。绝不以营销材料推断实际成功率，也不以某入口缺少功能推断全产品缺失。

所有 `path:line` 均相对 `/Users/bytedance/Project/cognia-next`，行号对应本次读取内容，dirty 文件可能继续变化。

## 2. 竞品基准：比较真实承诺，不虚构标准

| 产品       | 官方可证实的产品方向（P）                                                                                                                                | 本轮不能据此下的结论                                                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Meta Muse  | 持续个人目标、主动建议、后台工作、独立云电脑、敏感动作审批；生活场景和 WhatsApp/经营入口是重要方向。官方设计页说明记忆文件可读、编辑、下载，可请求忘记。 | 不证明每类任务成功率、崩溃后 exactly-once、离线本地机自动接替、每任务硬预算或完整交付验收模型。                                                    |
| OpenAI dot | 长期上下文、主动研究、后台并行任务、云电脑；ChatGPT/Slack/Teams 入口和 Work/Codex 插件权限共享；Activity View 可看工作并调整方向。                       | 不证明跨渠道每种权限等价或通用崩溃恢复保证。尤其不能假定逐条记忆编辑：FAQ 明确目前不支持逐项查看、改写或删除 dot 自身记忆，需要删除 dot 的上下文。 |
| Cognia     | 本轮可检查实际实现，可自选 host、runtime、模型、workflow、记忆管理、task/Issue/Squad 组织方式。                                                          | 本地有代码不等于用户当前安装已启用、远程 host 在线、权限配置充分或全流程可靠性已实测。                                                             |

公开来源：[Muse 发布说明](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)、[Muse 设计与产品页](https://introducing.muse.ai/)、[dot 发布说明](https://openai.com/index/introducing-dots/)、[dot 使用说明](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot)、[dot 隐私与控制 FAQ](https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs)。Muse 记忆文件细节同时收到独立公开研究 worker 的复核。双方公开能力并不构成质量排名。

下面的恢复、预算、版本验收要求主要来自“持续助手”的用户目标，**不是声称竞品已经保证这些行为**。

## 3. 对上一轮结论的修正

| 上一轮可能的宽泛判断                                | 本轮修正（C）                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cognia 缺长期记忆及用户控制                         | 不成立。Memory Console、更新/冲突处理/回溯/删除、召回反馈、namespace、向量清理和同步 tombstone 均存在。细粒度可见和修订是相对 dot 当前公开限制的优势。真正问题是“关闭记忆后仍能删除”的控制语义。                                                                                                                                    |
| Scheduler 只是计划列表或依赖前台 UI                 | 不成立。真实 executors、Node/Rust/renderer timing、headless runtime、goal driver、Issue 条件唤醒均存在。需区分“当前进程之外有 host 运行”和“原主机断电后凭空继续”。                                                                                                                                                                  |
| 缺任务恢复与幂等                                    | 不成立。scheduler catch-up、旧 execution 中断标记、canonical agent recovery、Squad checkpoint/recovery decision、command idempotency 都有。它们覆盖不同 run 类型，恢复合同还不是统一的。                                                                                                                                            |
| IM 只收消息、不能审批或调整任务                     | 不成立。run binding、状态卡、文本 follow-up、revision 校验、steer、handoff 都有；private 多平台文本控制不是 Feishu 独有。剩下的是同一会话多任务的文本消歧。                                                                                                                                                                         |
| 项目 coordinator 只是前台多聊天                     | 不成立。thread 持久化、pendingPrompt 重送、background hold、暂停/恢复、数量准入都存在。但死掉的已执行 turn 会标 interrupted，不会被这个模块自动重跑。                                                                                                                                                                               |
| Squad 不支持远程 worker                             | 不成立。manifest 兼容判断、容量选择、lease、remote session、事件游标和安全 checkpoint 都已实现。带继承权限约束的某些任务被主动拒绝，是协议能力边界。                                                                                                                                                                                |
| 没有成果版本、证据或失败接管                        | 不成立。Issue deliverable versions、artifact version、验证摘要、revision 关联证据、通知投递回执、人工 handoff、team recovery 已有。尚缺的是通用 delegation 完成状态与最终交付验收的明确联系。                                                                                                                                       |
| 共享 plugin forbid/撤权失效、静态 team 知识不锁版本 | 不再报告为缺口。`lib/plugin/api/api-permission-gate.ts:30` 优先检查 forbid/isRevoked；测试 `api-permission-gate.test.ts:49`、`project-api.test.ts:884` 固定合同。`lib/workflow/runtime/execution-authority.ts:184` 从静态 team 解析知识依赖，`:196` 锁定 revision；测试 `execution-authority.test.ts:162`。本轮仅核对产品控制合同。 |

此外，不能把“跨 attempt commitment”解释为永不终结的承诺：`lib/execution/delegation.ts:12` 的注释说失败不关闭，但实际 `delegation-bridge.ts:118` 在全部 child 终结、无 pending interrupt 后按最新 child 结算，包括 failed。报告以实际控制流和测试为准。

## 4. 按六个真实场景追踪

### S1：今天交代跨天任务，关闭界面，主机重启

**目标：**用户明天能知道任务是否仍被承担、在哪台机器执行，以及卡住后怎么恢复。

| 步骤                  | 入口、状态归属与存储                                                                                                     | 实际执行/反馈                                                                                                           | 证据与边界                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1-1 接下跨天工作     | `/scheduler`、goal、Issue wakeup；task/execution 属 host 自己的 `CogniaSchedulerDB`；delegation 在 execution run journal | scheduler 选择 executor，delegation 先持久化 acceptance 再计划                                                          | `lib/execution/delegation.ts:105`；`lib/scheduler/host-support.ts:118`。不是所有普通聊天自动成为常驻任务。                                               |
| S1-2 关闭当前聊天面板 | coordinator thread 的 session/pendingPrompt 持久化；background hold 保留运行 slice                                       | `startThread`/`sendToThread` 无需当前面板可继续                                                                         | `lib/project-coordinator/thread-runtime.ts:135`、`:177`；关闭面板与退出宿主进程不同。                                                                    |
| S1-3 用户退出应用     | desktop/Rust、headless/Node、browser timing 按 host 选择                                                                 | headless host 若仍运行，可独立执行；普通 web page 不在线则 timer 不执行；OS promotion 是唤起应用再委派                  | `lib/scheduler/task-scheduler.ts:367`；ADR-0128 §3–6。**部署依赖**，不能记为没有后台执行。                                                               |
| S1-4 重启后修复状态   | scheduler 扫旧 execution；coordinator 扫 running thread；agent/Squad 各有恢复记录                                        | scheduler 旧 pending/running 变 cancelled + interrupted-on-restart；未送出的 prompt 重送，已死 turn 标 interrupted      | `lib/scheduler/scheduler-db.ts:482`；`thread-runtime.ts:275`；这不是同一个模型 turn 无缝续跑。                                                           |
| S1-5 恢复工作         | canonical envelopes/anchor、connector job、Squad checkpoints/interrupt                                                   | 可恢复的 IM agent 经 `resumeCrashedAgentRun`；不明确副作用停下；Squad 可同 host retry、指定 host safe retry、重开或终止 | `lib/ai/agent/recovery/reconcile-crashed-runs.ts:199`、`:237`；`lib/ai/agent/team/durable/team-recovery.ts:42`。存在恢复，而非任意 engine 都可同等恢复。 |

测试源码：`lib/scheduler/scheduler-db.test.ts:480` 检查旧 run 中断；`task-scheduler.test.ts:4088` 检查 catch-up 过期；`thread-runtime.test.ts:200` 检查重启重送/中断；`reconcile-crashed-runs.test.ts:184` 拒绝模糊副作用；`team-recovery.test.ts:177` 检查重启恢复审批。

**判断：已实现但按执行器分层，持续在线能力依赖部署。** 没有证据证明 current install 的远程 host 可用，也没验证真实重启。交互 goal 的 boot re-arm 在 ADR-0019 明确是刻意不做；scheduler/IM goal 已有另外的 driver，不能泛化为 goal 全部停摆。

建议验收：同一任务分别关闭面板、退出客户端、重启执行 host；重开能看到“继续、等审批、待恢复、已取消”的真实状态，禁止仅凭持久化 running 字段宣称仍在工作。外部写入已发生但回执未落盘时，应显示待核对，不能无条件重放。

### S2：发现重要变化 → 解释来源 → 建议 → 接受 → 执行 → 交付

**目标：**助手发现变化时，用户能理解为何建议，接受后不必重讲任务，并能知道后续完成情况。

1. **发现：**Radar 从 memory/capture 收集窗口内内容，utility LLM 生成 report，保存 `radarReports`。`lib/radar/collect.ts:4`、`radar-runner.ts:43`。这是近期信息饮食分析；它本身不是所有 connector 的通用变化监控引擎。
2. **解释：**报告保留 verdict/actions/graveyard index，但 `RadarReport` 没保存被分析 item 的映射。`types/radar/index.ts:50`；runner `:68` 只保存数量、窗口、heatmap 和模型输出。UI `components/pet/console/radar-panel.tsx:291` 显示 `#index`，不能由该对象可靠返回当时原文。
3. **建议/决策：**actions 是 `string[]`，UI `:281` 只是列表；没有持久 suggestionId、pending/accepted/dismissed、来源证据引用或目标 taskId。**这是直接确认的特定动线缺失。**
4. **执行侧已有：**Issue wakeup 可重读 issue/rule/run，向活跃 run steer，或调用 `startIssueRun`；triage 未接受则 hold inputs；有 loop/rate/terminal 边界。`lib/issues/wakeups/executor.ts:1`、`:126`。不是整个产品没有事件→执行闭环，而是 Radar 没接进来。
5. **总开关：**`RadarPanel:84` 保存 settings，`:85` 只把 schedule 给 bridge；runner `:43` 不判断 enabled；executor `lib/scheduler/executors/radar-report-executor.ts:27` 直接调用 runner。pet teaser 则在 `lib/pet/events/sources/radar-source.ts:44` 检查 enabled。于是关闭总开关但保留 daily schedule，会出现 teaser 停、scheduled generation 仍可运行的控制合同不一致。手动 force 的语义应另定。

测试源码：runner test `:61` 覆盖生成/interval/样本不足；cron bridge test `:48` 覆盖 schedule off 删除；executor test `:21` 覆盖结果。已读测试没有把 master enabled × schedule 的组合与 suggestion lifecycle 连成验收。

**判断：Radar 默认关闭；开启后的接受闭环是真缺失，总开关是行为不一致；Issue 条件唤醒已经可复用。** 这比“加主动推送”更准确，也比把 Muse 的 Goals/Ideas 当成算法效果优越更严谨。

### S3：Mac 发起、IM 审批/调整、另一设备接手

**目标：**任何入口都操作同一件事，用户不会误批另一个任务，也不会把查看远程任务误认为迁移了 executor。

| 层次               | 已有实现（C）                                                                                                                                                         | 剩余边界                                                                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 人是谁             | `lib/db/platform-identities.ts:153` 支持 identity merge；`:208` 可 split；身份映射不是只有 display name                                                               | 不能等同所有渠道已自动关联到同一 actor 或权限；具体连接配置与实机身份未验证。                                                                                                                            |
| 当前聊哪个 session | `lib/connectors/session-bindings.ts:131` 优先 override.activeSessionId，校验绑定，fallback 最新 bound session；`:144` 处理明确历史链接                                | `/new`/`switch` 已有。没有 active 指针时 fallback 的产品行为应让用户可察觉，不能说完全没有 active session 选择。                                                                                         |
| 控制哪个 run       | `follow-up-control.ts:132` 接 private/managed thread；按 binding、TTL、allowedActions、revision、actor 调用共享 gate；`:235` steer_degraded 返回普通 inbound pipeline | 同一 private 会话多张活跃卡具有相同文本 label 时，`:165` 按 updatedAt 排序、`:178` 匹配、`:245` 第一项返回；该路径没有按用户引用的消息或询问选择目标。明确卡片动作仍可带目标，不应泛化为所有审批不可靠。 |
| 换设备查看/操作    | Companion/RPC run control 已有；dirty 的 `lib/execution/squad-start-dispatch.ts:32` 固定 launchId/host，`:107` 合并重复点击；Squad Inspector `:113` 已接入            | 是未提交实现。断网 `:60` 明确返回 offline，不自动排队；不是手机拥有本地 executor。                                                                                                                       |
| 换执行 host        | thread handoff ticket、canonical history、attachments、offer/commit、host dispatch queue                                                                              | `lib/thread-handoff/orchestrator.ts:49` 持久 offer；`:105` shared session 拒绝私有复制；service `:149` 可能降级为 transcript seed。会话迁移不保证原模型 runtime 原生无损继续。                           |

测试源码：`follow-up-control.test.ts:95` revision/actor、`:146` managed thread、`:212` 跨平台、`:294` steer；`session-bindings.test.ts`；`thread-handoff/orchestrator.test.ts:273` source-first commit、`:496` lost accept 防重复导入；`service.test.ts:383` fidelity 降级；未提交 `squad-start-dispatch.test.ts:77` double tap、`:96` lost response、`:156` host switch。

**判断：基础已实现且新 UI 仍在补齐；多任务同 label 文本控制是局部真实缺口；跨设备可用性和身份配置是部署/配置问题。**

### S4：长期偏好被纠正/删除，之后不要再错误召回

**目标：**用户能检查、纠错、回退、删除；暂停使用记忆不应迫使用户重新开启才能删数据。

1. `/memory` 的 `MemoryConsole` 经 `runManaged` 调 `manageMemory`。create/update/pin/review/conflict merge/restore/invalidate/delete 都存在。`lib/memory/control-plane/manage.ts:27`，`components/memory/memory-console.tsx:224`。
2. 更新可以 bump version、留下旧 revision；restore 也保存被替换文本。`manage.ts:323`、`:388`。硬删会删除 owner、历史 snapshots、evidence、ciphertext，并记录同步 tombstone；`lib/db/memories.ts:572`，测试 `memories.test.ts:722`、`:746`。
3. recall 不是任意旧文本命中即注入：`packages/memory/src/retrieve/retriever.ts:391` 排除非 active/过期；`:400` 排除 quarantine/conflict。向量清理失败有 reconcile 路径。不能报告为“删除仅前端隐藏”。
4. **确认的矛盾：**`manage.ts:307` 在 delete/invalidate/update/restore 之前返回 disabled；`clear` `:130` 逐项调用 delete 却不检查结果，最后返回匹配数量。Console `runBulk:341` 无论各项 boolean 都调用 onDone，clear-filtered `:612` 因而可能同时提示错误与清空成功。是静态控制流推导，未运行复现。
5. **另一个未连通设计：**`lib/memory/api/caller.ts:10` 明确当前所有 transport 的 namespaces 为 undefined，`caller.test.ts:55` 固定 account-scope 默认；底层 namespace 授权集合模型已经存在，但 per-principal grant store 尚未接到 constructors。已有 memory scope/agent privacy 过滤不等于插件/设备粒度授权集合。对单人账户这是现有边界；若产品要承诺“只给这个插件看某项目记忆”，则是待建设合同，不能叫当前部署漏洞。

**判断：记忆细粒度治理是 Cognia 已有优势；删除开关语义是真缺口；per-principal namespaces 是已有设计但未连通。** Muse 也公开承诺可编辑文件，不宜宣称 Cognia 独有；dot 当前 FAQ 的逐项管理限制则有明确对比依据。

验收应覆盖关闭后删单条、批量部分失败、历史版本和 mirror 同步、后续 live recall；外部 agent 自有记忆文件、已导出产物或历史聊天中的文本是不同数据面，不能仅删 memory row 就承诺全局消失。

### S5：并行多任务，子 agent 失败/重试/交接/预算

**目标：**多个任务能同时推进，失败不丢承诺，用户只在需要时接手，成本不因 retry 隐形增加。

- coordinator 已有创建日上限、暂停、propose-first、并发准入：`lib/project-coordinator/admission.ts:25`、`:44`。并发是 soft limit，显式用户 Start 可以越过；daily cap/paused 是 hard limit。不能把 UI 里的并发数字一律解释成绝对硬上限。
- delegation `acceptDelegation` 持久 commitment/run/binding；children 用 parentRunId；`delegation-bridge.ts:73` 幂等重投影；`delegation-handoff.ts` 从已有 journal 投影人工 brief，不另造可能过期的摘要数据库。
- Squad remote placement 检查 runtime/model/deployment/capability/workspace/sandbox/capacity：`lib/ai/agent/team/workers/remote-worker-runtime.ts:57`。执行进入 worker RPC session：`worker-rpc-pool.ts:103`、`:118`、`:140`，有 commandId 和事件游标。
- uncertain side effects 进入 recovery decision，不盲目重跑；`team-recovery.ts:53`，`:341` 处理 retry。这里停下来是正确合同，不应为了追求“全自动”删掉控制边界。
- 预算不仅是显示：`lib/ai/agent/execution/run-budget-governor.ts:29` 子任务/重试/失败计入 root；`:70` USD cost controller；`:97` root pool；`dispatch-teammate.ts:1197` allocate/recordAttempt。**并非没有成本控制。** 仍未验证所有外部 runtime 上报 usage 的准确性及真实账单上限。
- **真实 remote 能力限制：**`dispatch-teammate.ts:1217` 导出 inherited ceiling；`:1222` 发现 ceiling、sandbox 或 tools 限制便抛出“handoff protocol 无法 enforce”的错误。远程执行能用，但不能承接这些受约束任务。manifest 的一般 capability 匹配不能替代策略承诺。

测试源码：`remote-worker-runtime.test.ts:136` 对不兼容 fail closed；`team-recovery.test.ts:222` 组合真实 retry/resume state machine、`:343` 跨 host 无安全 checkpoint 拒绝；`dispatch-teammate.test.ts:511` root budget accounting；`delegation-handoff.test.ts:185` 人工交还。

**判断：多 agent、预算、恢复和交接已实现；受限任务的 remote handoff 合同不完整，默认配置/rollout/host runtime 也是独立前提。**

### S6：找到最终成果，确认版本与执行证据

**目标：**用户能够回答“最终交付是什么、哪版、怎么验证、发到哪里、我是否接受”。

1. artifact 及版本可持久化，`lib/db/artifact-types.ts:40`、`:53`；Issue 的显式 deliverable 与 engine 自动收集痕迹分开，`lib/issues/deliverables.ts:1`。
2. 同 label deliverable 跨 run 形成版本序列，最新优先但旧版可访问，`deliverables.ts:49`；UI `components/issues/deliverables/issue-deliverables-section.tsx:31`、`:53` 提供切换。scheduler 也有 `components/scheduler/run-artifact-links.tsx` 和 `lib/scheduler/run-artifact-link.ts`。
3. execution artifact 可带 verification passed/failed/inconclusive、detailsRef，`types/execution/run.ts:193`、`:219`。Squad `durable-dispatch.ts:360` 处理测试后再次修改导致证据不再覆盖，`:405` 记录 revision。多仓库交付 graph 有 CI、approval、remediation、headSha，`delivery/delivery-graph.ts:31`、`:185`、`:212`。
4. 通知也不是 fire-and-forget：`lib/notifications/delivery/receipts.ts:140` 把平台 message receipt 与 acceptedContentHash 归到 publication。**平台接受投递不等于用户接受成果**；incident acknowledgement 也不是 artifact version 验收。
5. **较窄的剩余合同：**通用 delegation 的 `maybeSettleDelegation` 在无 pending interrupt、所有 children terminal 后，按全局最新 updatedAt child 状态结算（`delegation-bridge.ts:145`）。这里没核对 milestone obligations、交付版本、投递 receipt 或用户接受。顺序 retry 成功的测试 `delegation-bridge.test.ts:118` 合理，但模型本身没有区分“同义替代 attempt”和“并行独立必需成果”。若独立 A 失败、B 后成功且都挂同一 delegation，算法会按 B completed 结算；该风险由控制流推导，未证实所有真实 producers 会构造此拓扑。

**判断：成果与证据管理已实现且比单一链接丰富；缺口是特定通用 commitment 的 outcome 合同和跨入口一致消费，不是全产品没有版本/审批。**

## 5. 最重要的五个缺口及最小闭环

排序按对持续助手可信度的影响，不是工期估算，也不是竞品成功率排名。

| 优先级/缺口                                                 | 用户影响、证据状态                                                                                                        | 现有复用点                                                                                                             | 最小闭环                                                                                                                                                                           | 可观察验收标准（建议，未实现）                                                                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1：Radar 建议没有进入承担/跟踪闭环，总开关不统一           | 用户看到“下一步”却不能明确接受/忽略并持续跟踪；关闭仍可能生成。直接 C：Radar types/Panel/runner/cron executor             | RadarReport、Issue triage/wakeup、acceptDelegation、execution binding、governed notifications                          | 持久化 suggestion identity、来源 item refs/时间、决策与目标 run/Issue；接受去重后走已有 executor；ignored 可保留理由；scheduled generation 与 master 开关统一，manual run 单独定义 | 相同建议连点只开一任务；接受后能返回来源和当前状态；重启保留决策；关闭后自动任务不调用模型；原始来源消失显示 unavailable 而不伪造证据             |
| G2：关闭记忆后删不了，批量完成反馈可能虚报                  | 用户为删除数据被迫重开；清空成功提示不代表删除。直接 C 控制流，尚无运行复现                                               | manageMemory、hardDeleteMemory、revision cascade、vector reconcile、sync tombstones、runManaged boolean                | 将学习/召回开关与用户管理删除分离；按实际成功数汇总，失败保留可重试选择；调用方不把 settled 当 success                                                                             | enabled=false 下单删/clear 都按约定成功；注入部分失败时成功数准确且不提示全部清空；重启和同步后旧版本不被 live recall                             |
| G3：普通 IM 文本回复缺少多任务消歧                          | 用户面对两张卡说“同意/停止/调整”可能指向最新更新项，不是心中那项。直接 C：follow-up-control:165–178；实际触发概率 U       | run binding、platformMessageId、run revision、explicit card action、active session resolver                            | 优先引用消息/明确 run token；有多个匹配时显示候选而不是默认 newest；成功回执说明任务标题与动作                                                                                     | 同私聊两个同 label pending run，改变卡更新时间不改变明确回复目标；模糊回复不执行；旧卡/过期/权限不足沿原 gate 拒绝；不影响单任务简便回复          |
| G4：受约束任务不能透明交给 remote worker                    | 越需要限制工具或 sandbox 的任务，越不能沿现有 handoff 移到远程。直接 C：dispatch-teammate:1217–1232，这是能力拒绝而非绕过 | execution spec/fingerprint、worker manifest、placement reasons、HandoffEnvelope、checkpoint/recovery                   | 先在预检/UI 明确可迁移范围；仅为双方能证明执行的策略增加版本化协议与确认；不支持继续明确拒绝，避免用重试掩盖不兼容                                                                 | 支持的工具/sandbox ceiling 在目标 host 可验证；不支持预检可见且不启动；重启/换 host 不丢约束；撤销沿现有控制平面生效。只用合同测试，不做攻击路径  |
| G5：通用 commitment 的 completed 没与必需成果和验收建立关系 | child 结束、平台收到消息、用户认可结果是三件事；顺序 retry 与独立并行成果混用可能误报完成。部分直接 C、并行拓扑风险为推导 | delegation journal、Issue deliverables、artifact versions、revision-bound evidence、publication receipt、human handoff | 明确 attempt 替代关系/必需 milestone；通用 run 完成与 deliverable ready/delivered/accepted 分层；只在任务要求验收时等待用户，普通问答不新增强制确认                                | 独立 A 失败、B 成功不能直接把全部目标判成功；A retry 成功可覆盖 A 旧失败；v2 验收不能由 v1 回执满足；投递失败显示待交付，用户返工有版本与 lineage |

G4、G5 的验收是 Cognia 自身产品目标，不能说 Muse/dot 已提供同等级合同。

## 6. 不该归为“真实缺失”的项目

| 类别               | 当前结论                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 默认未启用         | Radar `DEFAULT_RADAR_SETTINGS.enabled=false`；某些 IM goal 驱动、remote rollout/能力需 opt-in。需说清前提，不能以默认关闭判不存在。                                                               |
| 部署依赖           | headless host、runtime/model/workspace/capability、网络、OS promotion；本轮没有检查用户实际部署。云电脑是 Muse/dot 的公开产品承诺，Cognia 的 remote/host 能力不能自动视作交付了同等开箱即用服务。 |
| 已实现但碎片化     | scheduler execution、goal、coordinator thread、connector inbound job、Squad checkpoint 的恢复语义；Issue/artifact/notification/delegation 的成果状态。这需要统一呈现及路由，不需要重写所有引擎。  |
| 已有设计但未连通   | memory per-principal namespace grants：底层集合支持，所有 transport constructors 当前没有提供集合。若保持单人 account-scope，先把合同说清；若支持多角色隔离，再建设授权面。                       |
| 进行中的未提交实现 | Squad mobile/remote start dispatch 已从 UI 到 handler 出现，测试源码覆盖双击、掉响应和 host switch；不能沿旧快照再报“手机无法启动 Squad”。这些代码尚未作为本轮验证成果。                          |
| 未核验             | 真正断电/重启/跨手机审批、后台多天运行、外部副作用 exactly-once、产物跨设备完整性、真实成本、任务成功率、特定连接器身份映射。没有运行实测。                                                       |

## 7. Cognia 已有甚至更可定制的部分

- **可管理记忆而非仅靠隐式上下文：**逐项查看、纠错、冲突处置、历史修订、恢复、召回反馈、删除级联。相对 dot 当前公开逐项不可管理的限制，是明确可说的能力优势；与 Muse 的文件可编辑路线则是不同交互形态。
- **执行组织可组合：**单次 agent、goal、plan、workflow、Issue wakeup、project threads、Squad；用户可选 host/runtime/model，而不只接受固定个人助手运行面。
- **远程/恢复的可解释边界：**worker 不兼容理由、safe checkpoint、human handoff、pending interrupt 都存在，很多拒绝是保护用户意图的正确实现。
- **工程工作成果较丰富：**Issue 交付版本、CI/revision 证据、多仓库 delivery graph、PR/branch/session 关联已经提供明确复用基础。
- **预算及管控可配置：**root run budget、attempt/failure 记账、USD scope、project daily cap、并发/propose-first，不应简单用“主动性弱”把这些当作缺少能力。

这些是代码形态与可定制性的结论，不能转写成“Cognia 全面强于竞品”或“效果已经持平”。

## 8. 分阶段建议与验收顺序

**阶段 A：先修用户可观察的合同错误。** G2 删除开关及批量成功反馈；G1 master switch 与 schedule；G3 模糊文本多任务指向。范围小、可以在现有模块补充针对性测试。当前报告不实施这些修改。

**阶段 B：把已有引擎接成持续任务。** 从一个具体用例开始：Radar 给出有来源的建议，用户接受，生成一个 delegation 或 triage Issue，交给现有 executor，失败进入同一个任务的恢复入口，最终挂载 deliverable 和投递结果。保持 T0/T1/T2，不为所有短答新建 Issue。

**阶段 C：完善跨 host 与结果合同。** 为受限 remote worker 定义双方可验证的策略协议；明确任务和 attempt、成果和版本、delivery 和 acceptance 的关系；若产品承诺插件/设备粒度记忆范围，再接 per-principal grants。避免为了自动继续而绕过 uncertain-side-effect 恢复门。

**阶段 D：做真正的场景验收。** 在单独测试环境执行六条用户旅程：退出/重启；变化到接受；两张 IM 卡同时 pending；关闭记忆后删除及重新召回；子任务失败/预算/换 host；v1→v2 交付/返工。验证重点是用户能否解释当前状态和找回最终成果，不是多出几个开关或函数。

运行实测所需环境、test account、远程 host 和允许的副作用均未在本任务中准备；因此本报告状态为 **Complete for review（可供评审）**，不是已经通过场景验收。没有实现、提交、推送或部署。
