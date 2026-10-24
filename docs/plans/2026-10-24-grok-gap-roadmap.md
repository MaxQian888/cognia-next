# Grok Bot 能力差距：复用现有实现的补齐路线

| 项目        | 内容                                                                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态        | Roadmap 草案，决策已与用户逐项确认；未开工，无代码改动                                                                                             |
| 作者 / 日期 | Claude / 2026-10-24，Asia/Shanghai                                                                                                                 |
| 来源        | [Grok Bot 对比调研](../research/2026-10-24-grok-bot-cognia-comparison.md)，以及本次对其中 9 项差距的源码复核（haiku Explore × 4 + 关键行人工核对） |
| 原则        | 不新建第二套 Bot 引擎、审批平台、记忆库、调度器、App 容器或视频子系统；差距优先用“连接现有实现”补齐                                                |
| 产品边界    | 维持 ADR-0224：Always-on Host 由用户自带。本期不提供托管云 Host、不由官方分配邮箱地址、不做支付卡与联系人资料自动填充                              |
| 后续        | 每项开工时单独走 [WORKFLOW](../development/WORKFLOW.md)，需要的单独写 ADR；本文只定方向、复用点与验收                                              |

## 1. 结论

九项差距里，五项判断成立，四项瞄错了目标：

- **合盖继续运行**：用户态程序在笔记本合盖后无法保持运行（仅外接显示器 + 电源的 clamshell 模式例外）。Host mode 只持有 `PreventUserIdleSystemSleep`，[cognia-power](../../crates/cognia-power/src/lib.rs#L257)，防的是空闲睡眠，不防合盖。所以目标应是**睡眠前把工作放到 always-on Host 上**，同时修正设置文案 “Keeps the computer from sleeping”（[desktop.json](../../i18n/messages/en/settings/desktop.json#L121)）。
- **视频进 IM**：放开 [build-options.ts:3052](../../lib/claude/build-options.ts#L3052) 的 gate 什么也解决不了。IM 根本没有投递 agent 产出媒体的通路：[`action.connector.send`](../../lib/workflow/nodes/connectors/index.ts#L68) 只发文本和 A2UI。真正的目标是“agent 产出的媒体能投递到 IM 和移动端”。
- **大附件**：常量属实（[prepare.ts:19](../../lib/chat/attachments/prepare.ts#L19)），但远端分块续传已经存在。真正的缺口是限额互相冲突、本机 composer 直接拒绝超限文件、移动端不能接收分享的文件。
- **原表漏掉了一项 P0**：[`cancelDelegation`](../../lib/ai/agent/team/delegation-orchestrator.ts#L838) 处理了 background、twin、team 三类目标，没有 external 分支。

## 2. 优先级与依赖

| 优先级  | 工作                                  | 依赖                                        |
| ------- | ------------------------------------- | ------------------------------------------- |
| P0      | §3 按用户意图授权 + 拒绝屏障          | 无                                          |
| P0      | §4 外部委派取消                       | 无                                          |
| P1      | §5 Skill → Bot → Routine              | §3（Bot 无人值守发送前要有授权边界）        |
| P1      | §6 持续维护的 Artifact                | §3（自动应用与自动发布走同一授权边界）      |
| P1      | §7 合盖交接 + Host mode 文案修正      | 无（文案修正可立即单独提交）                |
| P1      | §8 Vault 第一步：人工接管可发现       | 无                                          |
| P2      | §9 媒体投递到 IM 与移动端             | §3                                          |
| P2      | §10 大附件：统一限额 + 超限按引用绑定 | 无                                          |
| P2      | §11 IMAP/SMTP 邮件 connector          | §3（发送）、§7（收信在 Host 上常驻）        |
| P2      | §8 Vault 第二步：远端安全填充         | §8 第一步                                   |
| 依赖 P6 | §12 共享 Team Bot                     | 多用户计划 P6（成员 agent turn 与组织凭据） |

P0 必须先于任何提高无人值守自主性的工作。

## 3. P0：按用户意图授权 + 拒绝屏障

**现状**

- Auto-mode 只判断 shell 命令：[`COMMAND_TOOLS`](../../lib/claude/permissions/command-from-tool.ts#L14) 之外的工具，[auto-mode-runner](../../lib/claude/permissions/auto-mode-runner.ts#L53) 返回 `null`，回落到普通审批。judge 的输入不包含用户本轮请求。
- ActionReview 的契约与 receipt 已存在：[契约](../../packages/agent-config-types/src/action-review.ts)、[registry](../../lib/policy/action-review/registry.ts)、[receipt 存储](../../lib/db/action-review-receipts.ts)；聊天工具和 Squad gate 已接入。但契约里写的策略引擎 `lib/policy/action-review/policy.ts` **不存在**；connector 渠道的 projection 疑似 dormant。代码里标注的 “ADR-0102” 与实际 ADR-0102（可观测性）不符。
- 拒绝记忆仅限会话：[`rememberDenial`](../../lib/claude/permissions/session-denials.ts#L81) 把显式拒绝写进本会话规则集。它与用户指令无关，也不跨子任务或后台触发。
- 草稿模式存在：[`ConnectorMode`](../../packages/plugin-contract/src/types/connectors/policy.ts#L45) 有 `draft`。但外发**没有按收件人的白名单**。
- Workflow 用自己的 [node-risk](../../lib/workflow/runtime/node-risk.ts#L70)，connector 外发不经过 [`classifyRisk`](../../lib/policy/risk/classify-risk.ts#L204)。

**已定决策**

- 在现有 ActionReview 与 receipt 上扩展，不另建审批平台，也不把 auto-mode 推广成所有工具的模型审批员。
- **授权来源：确定性默认 + 显式授予。** 发送类操作默认只起草。收件人和“可以发送”由审批卡片或会话 / Bot 策略显式授予，并记入 receipt。模型可以从用户请求里提议范围，但只能收紧、不能放宽。确定性上限和撤销始终优先。
- **拒绝屏障：** 被拒绝的操作按指纹（工具、目标、收件人、资源）记录，并绑定到“用户指令纪元”。在新的人工指令之前，同一操作无论走哪个工具、哪个子任务都被拦截；后台触发不算新的人工授权。
- 覆盖面：connector 外发、browser 提交类动作、MCP 写类工具，以及 workflow 的 `action.connector.send`。

**复用**：ActionReview 契约与 registry、`session-denials`（升级为纪元化的屏障，而不是另起一份存储）、ADR-0198 capability grant 的上限、`ConnectorMode.draft`、`permission-resolve` 的 HITL 默认。

**验收**

- “给 A 起草一封邮件，不要发。”任何工具、浏览器路径或子任务都不会发出去。
- 拒绝后，同一操作经另一个子任务重发仍被拦截；用户发出新指令后才重新评估。
- 定时触发的 Bot 运行在没有显式授予时只产出草稿，不把“定时触发”当作授权。
- 每个放行或拦截都能从 receipt 回答：谁授权、授权范围是什么、依据哪条指令。

**设计**：[ADR-0239](../content/docs/zh/adr/0239-an-outbound-action-is-authorized-by-the-request.md)（提议中）。ADR-0070 的 Phase 2 状态已由其 2026-08-13 修订说明更正，无需再改。

## 4. P0：外部委派取消

**现状**：[`cancelDelegation`](../../lib/ai/agent/team/delegation-orchestrator.ts#L838) 只对 background、twin、team 三类目标做了中止。external 委派用的是自己的 watchdog `AbortSignal.timeout`（[执行入口](../../lib/ai/agent/team/delegation-orchestrator.ts#L133)），取消后只是把状态改成 `cancelled`。

**做法**：先写复现测试，确认三件事：取消后外部子进程是否真的停止；迟到的完成结果会不会触发后续工作或重新拉起父任务；挂起中的审批是否过期。确认后在取消路径补 external 分支，把 AbortSignal 串到外部 manager。保留现有 Squad Stop 与审批过期行为（[squad-control](../../lib/ai/agent/team/squad/squad-control.ts#L271)）。

**验收**：停止一个带活跃外部子任务的父任务后，子任务执行结束，挂起审批过期，迟到的结果不会重启父任务，已完成的副作用如实记录。

## 5. P1：Skill → Bot → Routine

**现状**

- 录制 → 生成 → 审核 → 受控试运行 → 确认启用已完整实现：[`startControlledTrial`](../../lib/skills/recording/controller.ts#L604)、[确认启用](../../lib/skills/recording/controller.ts#L623)。但确认后 [stage-save](../../components/skills/recorder/stage-save.tsx#L88) 只显示一段文字，没有下一步。
- Bot 没有 skill 字段，skill 只能经 character 进入（[bot-types](../../lib/db/bot-types.ts#L47)，[build-options](../../lib/claude/build-options.ts#L1613)）。
- Bot 的定时触发已经会转成调度任务：[reconcile-timed-triggers](../../lib/bot/schedule/reconcile-timed-triggers.ts#L45)。
- 通用的“预填新建任务”交接已存在：[`stageScheduledTaskDraft`](../../lib/scheduler/task-draft-handoff.ts#L44)，目前唯一的调用方是 composer 的定时建议。

**已定决策**

- “把 Skill 交给 Bot”用 **BotInstallation 上挂 ADR-0198 `AgentCapabilityGrantV1`**（[契约](../../packages/agent-config-types/src/agent-capability-grant.ts)），按次运行授予，经过过滤器、Restricted Mode、上限和 finalizer。不改 character，不新增 `skillIds`。
- Routine 挂在 **Bot 的 timed trigger** 上，继承 Bot 的策略、安装和工作区。用户不选 Bot 时，才用 `stageScheduledTaskDraft({ type: "skill" })` 创建独立的 skill 任务。
- 在确认试运行后的界面加两个下一步：“交给 Bot” 和 “设为定时”。

**验收**：演示一个流程，审核生成的 Skill 并通过试运行，交给一个 Bot 并设定时；关掉客户端后，在手机上通过 always-on Host 看到这个 Bot 的下一次结果和审批。整个过程不需要重新配置 Skill、工作区或策略。

## 6. P1：持续维护的 Artifact（Pages）

**现状**

- Artifact 有版本、历史与恢复（[saveArtifactVersion](../../stores/artifact/artifact-store.ts#L1734)），有默认开启的逐块审核门（[artifact-builtin-tools](../../lib/claude/artifact-builtin-tools.ts#L431)），workflow 也有更新节点（[artifacts 节点](../../lib/workflow/nodes/artifacts/index.ts#L154)）。但默认门开启时，无人值守的更新不会真正生效。
- 直接写入没有基版本校验，最后一次写入覆盖之前的。
- Artifact 没有 owner、刷新状态和上次/下次刷新时间；scheduler 的 [run 链接](../../lib/scheduler/run-artifact-link.ts#L22) 没有 artifact 类。
- 分享是客户端加密快照（[share types](../../lib/share/types.ts#L3)），不跟随最新版本。[Sites 版本化发布](../../lib/sites/publish-version.ts) 存在，但需要手动发布。
- 相近的实现：Radar 的滚动报告（[radar-runner](../../lib/radar/radar-runner.ts#L52)），独立存储，没有分享目标。

**已定决策**

- 载体是 **Artifact**。workflow 的 Canvas 后台写入保持不支持（[边界](../../lib/workflow/nodes/artifacts/index.ts#L15)）。
- **人是负责人，Bot 是维护者。** 负责人决定刷新策略、自动应用还是审核、是否自动发布；Bot 只按授权刷新。多人协作等 P6 之后再扩展。
- **由 Bot 或定时任务驱动刷新**：给 scheduler 加 artifact 类的 run 链接。
- **冲突处理：比对基版本。** 刷新开始时记录基版本，提交时发现人工改过就走现有 `proposeArtifactUpdate` 逐块审核；没有冲突时按负责人的策略自动应用。
- **稳定共享目标**：复用 `lib/sites` 的版本化发布。刷新成功后，按负责人的策略自动重新发布；Sites 已有回滚窗口（[artifact-gc](../../lib/sites/artifact-gc.ts)）。
- 新增字段：负责人、维护者（Bot installation）、刷新策略、上次成功/失败、下次刷新。字段的存放位置在 ADR 中确定；改 Dexie schema 要走 dexie-migration 流程。

**验收**：创建一份报告，在刷新运行期间手动编辑它。人工改动被保留，冲突以 diff 形式呈现等待审核；共享链接保持不变；界面显示上次成功/失败和下次刷新时间。

## 7. P1：合盖交接 + Host mode 文案修正

**现状**：Host mode 只持有防空闲睡眠的 assertion（[window_behavior](../../src-tauri/src/window_behavior.rs#L233)）。仓库里没有任何合盖处理。默认放置已经会选第一个探测通过的 always-on Host（[`alwaysOnTarget`](../../lib/remote-host/always-on-target.ts#L14)），也有按条目的 owner 迁移（[migration/items](../../lib/remote-host/migration/items.ts#L832)）。

**已定决策**

- 不承诺笔记本合盖后继续运行。
- **提前放置 + 睡眠时兜底**：有已配对的 always-on Host 时，计划中的 Bot、定时任务和 connector 默认放在 Host 上。正在运行的 turn 在合盖或退出前提示“在 Host 上继续（重新起跑）”，不做执行中状态的无缝迁移。macOS 的睡眠通知只留几秒，只用来尽力上报状态，醒来后再给提示。
- 没有已配对 Host 时，如实告诉用户：合盖后会暂停。
- 文案修正可以单独先做：改为“防止空闲睡眠；笔记本合盖仍会睡眠”这类准确说法，中英文同步，然后跑 `pnpm i18n:build`。

**验收**：配好 Host 后，合上笔记本（用电池）。定时任务和 Bot 按时在 Host 上运行，手机能看到结果；重新打开时，被中断的本机 turn 有明确提示，并可以在 Host 上重跑。合盖测试需要在真机上做。

## 8. P1/P2：Vault（只做登录，分两步）

**现状**：本机 vault 完整，密码只在 Rust 侧（[vault.rs](../../crates/cognia-browser-cookies/src/passwords/vault.rs#L1)）。远端 Chromium 与扩展引擎明确拒绝凭据操作（[remote-chromium-engine](../../lib/browser/remote-chromium-engine.ts#L229)，[extension-engine](../../lib/browser/extension-engine.ts#L406)）。云浏览器的人工接管已经存在，是一个人类输入租约（[remote-stream](../../lib/browser/remote-stream.ts#L127)）。没有支付卡和地址资料的存储。

**第一步（P1）**：在远端浏览器遇到登录页时，让已有的人工接管容易被发现。提示用户接管并亲自输入；agent 拿不到明文，也不把明文写进聊天或模型上下文。

**第二步（P2）**：设计 vault 到远端的填充协议。密码不离开 Host，不进入模型上下文，只填进已批准的 origin 和浏览器会话；会话过期或被撤销时拒绝填充。这是一份独立的安全设计，需要 ADR 并做安全评审。

**不做**：支付卡、联系人资料。

## 9. P2：媒体投递到 IM 与移动端

**现状**

- 视频工具与 artifact 写作共用同一个 gate，在 IM/CLI 中不提供，理由是“需要聊天界面渲染”（[build-options](../../lib/claude/build-options.ts#L3052)）。
- 部分 adapter 支持发视频（钉钉、Discord、Matrix、OneBot、Telegram、微信个人号、企业微信），飞书、Slack、QQ 官方、微信公众号不支持。
- agent 能用的外发只有文本和 A2UI。[`action.connector.forward`](../../lib/workflow/nodes/connectors/index.ts#L278) 只收 messageId，与 [artifacts 节点注释](../../lib/workflow/nodes/artifacts/index.ts#L6) 的说法不符。
- `image_generate` / `image_edit` / `image_variation` 在 [tool.ts](../../types/agent/tool.ts#L107) 中已声明，但没有对应的 agent 工具，属于 Rule 7 意义上的半休眠。

**已定决策**

- 补一条通用的媒体外发通路（图片、视频、文件、artifact 导出），各 adapter 声明自己支持的媒体类型。
- **降级顺序**：能发文件就作为文件发；不能发就用 A2UI 卡片（缩略图、标题）加打开 Cognia 或配对设备的深链。**不生成公开 URL**，以免引入托管存储。
- 通路就绪后，再按渠道放开第 3052 行的 gate。
- `image_generate` 系列：要么接上，要么在类型、UI、测试三个层面都标注为休眠。
- 修正 artifacts 节点注释与 forward 节点不符的问题。
- 外发经 §3 授权。入站媒体的默认规则保持不变（[media-model-gate](../../lib/connectors/media-model-gate.ts)：默认 `local_extract_only`）。

**验收**：在飞书群里让 Bot 生成视频，飞书收到一张带缩略图的卡片和应用内链接；在 Telegram 里收到视频文件；两条外发都留有 receipt。

## 10. P2：大附件

**现状**：composer 限制每条 6 个附件、每个 10 MiB，超限直接拒绝（[prepare.ts:81](../../lib/chat/attachments/prepare.ts#L81)）。各处限额互相冲突：

| 限额            | 位置                                                                            |
| --------------- | ------------------------------------------------------------------------------- |
| 10 MiB          | composer、[配对设备 Files](../../lib/files-library/remote/types.ts#L184)        |
| 50 MiB          | [Files 抽取](../../lib/files-library/upload.ts#L30)、collab 附件、ADR-0222 传输 |
| 500 MiB / 1 GiB | [session asset 单个 / 配额](../../lib/db/session-assets.ts#L30)                 |

远端会话已有 32 KiB 分块续传（[session-attachment-uploads](../../lib/db/session-attachment-uploads.ts)，[upload client](../../lib/companion/attachment-upload-client.ts)）。Files → 聊天已能把大文件绑定为 session asset 而不复制字节（[use-in-chat](../../lib/files-library/use-in-chat.ts)）。

**已定决策**

- 统一限额，区分三层：内联给模型、传输、存储。统一后经 [host-feature-manifest](../../lib/platform/host-feature-manifest.ts#L246) 发布给各客户端。
- composer 里超限的文件改走 session-asset 引用绑定，不再拒绝。agent 通过现有的 `attachment_*` 工具读取，解析预算沿用现有的内联 token 上限。
- 移动端接收分享文件（Android stream receiver 与 iOS share extension，后者需要人工配合）**不在本项**，另行排期。

**验收**：在桌面 composer 拖入一个 200 MiB 的 PDF，它被引用绑定，agent 能检索并读到其中内容；配对客户端上传同一个文件，可以取消、可以断点续传；各端显示的限额一致。

## 11. P2：IMAP/SMTP 邮件 connector

**现状**：没有任何邮件 adapter（[adapter-registry](../../lib/connectors/adapter-registry.ts#L49)）。外发 job 记录了来源（[outbound-jobs](../../lib/db/outbound-jobs.ts#L162)），但收件方看不到是哪个人请求的。

**已定决策**

- 使用用户自带的邮箱，接通用 IMAP/SMTP，覆盖企业邮箱和国内服务。不由官方分配地址。
- 作为 Bot 的事件来源（[bot sources](../../lib/bot/sources/)）和投递渠道，复用 connector 运行时、草稿与 HITL。
- 收信在 always-on Host 上常驻（IMAP IDLE，或退回到轮询）。
- 转发时保留格式和附件；防邮件循环（识别自动回复头和自身发出的邮件）；外发经 §3 授权，并带可见的请求人归属，且不暴露私人会话内容。
- 凭据存入现有的 secret store，不进入模型上下文。

**验收**：把一个企业邮箱接到 Bot，收到的邮件触发 Bot 处理；回复默认只起草，用户批准后发出，收件方能看到是代表谁发的；Bot 不会回复自己发出的邮件。

## 12. 依赖 P6：共享 Team Bot

**现状**：[BotInstallationRow](../../lib/db/bot-types.ts#L152) 没有成员、角色或 ACL 字段：`scope` 是 account / workspace / project，`owner` 表示放在哪台机器而不是哪个人，`credentialBindings` 指向集成账号而不是个人。组织角色在 `cognia-tenant-auth` 里已有，但没有接到 Bot。[`PERSON_BRAIN_RUNTIMES`](../../lib/headless/runtimes/index.ts#L237) 不含 Bot、调度器和 connector，Bot runner 按账号运行（[bots.ts:31](../../lib/headless/runtimes/bots.ts#L31)）。

**已定决策**：等多用户计划 P6 落地后，在 P6 的成员身份与凭据分区上建 Bot 的成员模型：团队共享知识、每人私人会话与记忆、个人 connector 授权、管理者与协作者权限。不单独设计一套 Bot ACL。

**验收**：两名成员各自私下使用同一个 Bot，各自的会话和凭据互相隔离；显式发布的经验可以共享；管理员能撤销访问；协作者无法悄悄借用别人的 connector。

## 13. 不做什么

- 托管云 Host、托管 brain、ADR-0233 managed desktop 转正：属于运营与计费层面的产品决策，不在本期。
- 官方分配邮箱地址：与上一条是同一类托管决策。
- 支付卡、联系人资料自动填充。
- 执行中 turn 的无缝跨机迁移。
- 照搬竞品的 routine 数量、启用 Skill 数量等固定配额（理由见调研文档“What should not be copied mechanically”）。
- 账号级共享电脑作为默认安全模型。

## 14. 已知文档偏差（顺带修正）

- `packages/agent-config-types/src/action-review.ts` 引用了不存在的 `lib/policy/action-review/policy.ts`，并错误标注为 ADR-0102。
- ADR-0070 仍把 Phase 2 标为 planned，但 Agent Team 与 /goal 已经接入。
- `lib/workflow/nodes/artifacts/index.ts:6-8` 说导出 PNG 交给 `action.connector.forward`，而该节点只收 messageId。
- Host mode 设置文案过度承诺（见 §7）。
