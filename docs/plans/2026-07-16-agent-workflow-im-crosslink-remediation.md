# Agent × 工作流 × IM 跨子系统联动与跳转 — 缺口修复计划

**日期**: 2026-07-16
**状态**: 待评审(未实施 —— 下文每一项都是本会话亲手 read/grep 复核过的缺陷或缺口,不是设想)
**范围**: 三子系统之间的**跨系统联动** + **跳转/导航** + **PII 安全** + **跨端一致性**。四波 —— W1 安全红线(P0)、W2 跳转/导航闭环(功能性 bug + 反向导航)、W3 反向联动边、W4 跨端与一致性。
**参考 ADR**: 0009/0025/0036(平台连接器 + A2UI)、0002/0022/0032(Agent Team)、0011(工作流)、0070(风险→仪式策略)、`lib/connectors/CONTEXT.md`

> **与既有计划的边界(务必先读)**:本仓已有 `docs/plans/2026-07-16-workflow-linkage-remediation.md`,它覆盖的是**工作流引擎内部**联动(发布→技能→工具的收敛、`flow.*` 控制流、`trigger.workflow.completed` 工作流链式触发、v1/v2 版本、结构化输出)。**本计划不重复那些**,只处理**跨子系统(IM/Agent/工作流之间)** 与 **跳转导航** 的缺口。两处唯一交叠是 `flow.wait` event stub —— 归既有计划 W3.2,本文不再规划。gap 用 **X 系列**编号以免与既有 G 系列混淆。

---

## 0. 如何使用本文档

每个工作项自成单元:**问题 → 证据 → 修法 → 验收**。除非标 **依赖**,否则彼此独立,一项一个 commit。沿用既有计划的置信标签。

| 标签            | 含义                                        | 你必须做什么                     |
| --------------- | ------------------------------------------- | -------------------------------- |
| **[CONFIRMED]** | 本文作者本会话亲手 read/grep 到 file:symbol | 可信,但**行号会漂,按符号重定位** |
| **[AGENT]**     | subagent 提供证据,作者未逐行复核            | **动手前先自行复核这条具体主张** |
| **[OPEN]**      | 真正未决,需人拍板                           | **不要默默替它做决定**,见 §8     |

> 调研由三个 subagent(后端编排 / 工作流引擎 / 前端跳转)完成,X1(PII)另经 `pii-gate-auditor` 专项对抗式复核。随后作者对 **X1–X8 的全部承重 file:symbol 做了一手 read/grep 复核**(含阳性对照)。X9/X10 部分仍 [AGENT]。

### 0.1 证据标准(不可妥协)

凡「某门/某工具不存在」主张,均以引号包裹 grep + 阳性对照确认:

```bash
# 阳性对照:已知存在的门必须命中,否则零才可信
rtk grep -rn "hasNoLeakingPii" lib/connectors/runtime.ts        # 必须命中(runtime.ts:245)
rtk grep -n  "hasNoLeakingPii\|isInboundTextPiiSafe" lib/connectors/bus.ts  # fanout 段(913-970)此时的零才可信
```

---

## 1. 研究结论(先读这节 —— 它推翻了"要给这三者加联动"的默认假设)

第一直觉是"IM、Agent、工作流之间要补联动能力"。**事实相反:后端编排上,三者已近乎双向闭环。** 一条 IM 消息可按 dispatch-rule 分别拉起「单角色对话 / 整个 Agent Team / 工作流」;工作流能反过来 `action.agent.turn` / `action.team.run`(且把 IM origin 带进合成运行,进度 fan back 到原会话);IM 实时步骤卡片(`workflow-progress-runner` + `buildCumulativeStatusSurface`)已在跑。

真正的缺口是**三类**,且都是"数据/路径已存在但被绕过或未消费"型 —— 静态看代码都在,只有真跑一遍才暴露:

1. **一条安全红线被绕过(P0)**:会话绑定路径补了 PII 门,但**平行的触发节点扇出没补**,原始 IM 文本可越过 redaction 红线直达 LLM 或回发到渠道。作者已在 `runtime.ts` 的门自带注释里找到自陈的"confirmed bypass",且桌面事件扇出**有**同款门而 connector 扇出**没有** —— 证明是遗漏非设计。
2. **跳转/导航几乎全缺(P1)**:底层来源数据(`triggeredFrom.conversationKey` 等)全都写好了,但 UI 从不消费它 —— Inbox 活动日志"已派发"事件点不进去、Agent Team 工作区/工作流 run-detail 无任何回到 IM 来源的链接、IM 卡片生成的 `cognia://workflow-run` 深链在桌面根本不被解析、审批通知 href 拼错落 not-found。这是**性价比最高**的一块:只差 UI 去消费已有数据。
3. **一条结构性反向边不存在(P1)**:工作流→Agent 很丰富,但**运行中的 headless agent / 外部 MCP 客户端无法反向拉起工作流**(external-bridge 无 `workflow_run`,`action.team.delegate` 目标不含 workflow)。

> **所以本计划不是"加联动功能",而是"堵一条安全漏、把跳转接上已有数据、补一条反向边、统一跨端默认值"。**

---

## 2. 现有跨子系统联动全景(调研可复用产出 —— 也是"详细研究现有联动"的交付物)

### 2.1 三子系统之间的有向边(核心路由器 = `resolveEffectiveRouting`,优先级 **Team > Workflow > Character**)

| 有向边                          | 状态                      | 关键接缝(file:symbol)                                                                              |
| ------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------- |
| IM → 单角色对话                 | 🟢 全通                   | `runtime.ts` ai-run → `safeSendPrompt`(自带 `hasNoLeakingPii`)                                     |
| IM → Agent Team                 | 🟢 全通                   | `runtime.ts:767 startTeamRunFromIM` → `runTeamLifecycle`,`triggeredFrom.source="im"`               |
| Agent → IM(富文本回投)          | 🟢 全通                   | `a2ui-to-segments` → 各平台 mapper + 回调闭环 `connector-callback-handler.ts`                      |
| IM → 工作流                     | 🟢 全通(**两条独立路径**) | ① 会话绑定 `runtime.ts:823 startWorkflowFromIM` ② 触发节点扇出 `bus.ts:607 fanOutWorkflowTriggers` |
| 工作流 → IM(发送节点)           | 🟢 全通                   | `action.connector.send` → `enqueueOutbound`;`action.connector.waitReply` = 工作流侧 IM 反馈回路    |
| 工作流 → Agent/Team             | 🟢 全通                   | `action.agent.turn`、`action.team.run`(带 IM origin `ctx.trigger.binding`)                         |
| **Agent(headless/MCP)→ 工作流** | 🔴 **缺口**               | external-bridge 只有 `agent_dispatch`/`team_run`,无 `workflow_run`(X4)                             |
| **Team delegate → 工作流**      | 🔴 **缺口**               | `team-ops.ts:40` target = `twin\|background\|external\|team`,无 workflow(X4)                       |

> 注:**在会话内 chat agent** 可经 `workflow-ai` 插件工具(`wf_run_workflow_by_name` 等)跑工作流 —— 那条路径 + 其"幽灵工具"缺陷归**既有计划** G1/G5。本文 X4 只处理 **headless / 外部 MCP** 与 **team delegate** 这两条本文独有的反向边。

### 2.2 跳转 / 导航层现状

- **三套互不统一的 `cognia://` 解析器**:桌面 Tauri(`use-tauri-events.ts`,认 chat/settings/workspace)、移动 Capacitor(`lib/capacitor/deeplink.ts`,认 session/workflow-run/share)、Connector OAuth(双端)。同一"打开会话"桌面叫 `chat/` 移动叫 `session/`,词表分叉是多个 bug 的根因。[AGENT + 部分 CONFIRMED]
- **通知中心**(`notification-center.tsx`)是唯一的跨面持久跳转层,对 `record.href` 做 `router.push`。
- **来源数据齐全但 UI 不消费**:`triggeredFrom{source,adapterId,conversationKey}`(`team-dispatch.ts:125`)、`WorkflowRunRow.triggeredBy.conversationKey`(`types/workflow/visual.ts`)都持久化了,但 Inbox 活动日志 / Agent Team 工作区 / 工作流 run-detail **均不渲染成跳转**。

---

## 3. 缺口总表(按严重度 + 修复性价比排序)

| ID  | 缺口                                                                      | 级别     | 波次 | 置信                  | 改动量    |
| --- | ------------------------------------------------------------------------- | -------- | ---- | --------------------- | --------- |
| X1  | IM→工作流触发扇出绕过 PII 红线(4 个 sink)                                 | 🔴 P0    | W1   | [CONFIRMED + auditor] | 小–中     |
| X2  | 桌面 Tauri 不解析 `cognia://workflow-run`/`session` → IM 卡片深链点开失败 | 🟠 P0/P1 | W2.1 | [CONFIRMED]           | 小        |
| X3  | 工作流审批通知 href 拼错 → 落 not-found                                   | 🟠 P1    | W2.2 | [CONFIRMED]           | 微        |
| X5  | 反向导航一片空(activity-log 不可点 + 工作区/run-detail 无回链)            | 🟠 P1    | W2.3 | [CONFIRMED]           | 中        |
| X4  | Agent(headless/MCP)/Team-delegate → 工作流 反向边缺失                     | 🟠 P1    | W3   | [CONFIRMED]           | 中        |
| X6  | Web/移动端 cron/webhook/github 触发器静默失效(纯 Rust)                    | 🟡 P1/P2 | W4.1 | [CONFIRMED]           | 大        |
| X7  | bot 模型 pin 对 IM 团队成员不生效                                         | 🟡 P2    | W4.2 | [CONFIRMED]           | 小        |
| X8  | risk-gating 默认不对称(IM→工作流 OFF vs IM→Team ON)                       | 🟡 P2    | W4.3 | [CONFIRMED]           | 小(+决策) |
| X9  | 无 `cognia://team/<id>` 深链;三套 parser 词表分叉                         | 🟢 P2    | W4.4 | [AGENT]               | 中        |
| X10 | 全局命令面板到不了 workflow/agent-team/inbox/connector                    | 🟢 P2    | W4.4 | [AGENT]               | 中        |

---

## W1 — 安全红线(P0,先修)

### W1.1 · X1 · IM→工作流触发扇出绕过 PII 红线 [P0] [CONFIRMED + auditor]

**问题**:会话绑定的 IM→team/工作流 dispatch 在 `runtime.ts:738` 有 fail-closed PII 门(`isInboundTextPiiSafe`);但**平行、独立的第二条入口** —— 触发节点扇出 `bus.ts:607 fanOutWorkflowTriggers` —— **完全不经过该门**,把含 `plainText`(已折入 inbound 图片 OCR 文本)的完整 event 原样下发进工作流 orchestrator。叠加下游工作流 LLM/agent 节点**默认无门**,构成两条端到端外泄出口:① 原始 IM 文本 → LLM;② 原始/派生文本 → 回发到节点参数指定的**任意** adapterId/conversationKey(含跨渠道)。这正是 ADR-0009 声称已关闭、但只关了一半的红线。

**证据**(本会话 read + auditor 双重坐实):

- 门在会话绑定侧生效:`lib/connectors/runtime.ts:738` `if ((effectiveTeamId || effectiveWorkflowId) && !isInboundTextPiiSafe(event))` → 写 `pii_blocked` 审计并 break(:754),在 team(:763)/workflow(:823 `startWorkflowFromIM`)分支之前。门实现 `runtime.ts:244-246` `return hasNoLeakingPii(event.plainText)`。
- **门的 docstring 自陈这是已知绕过**:`runtime.ts:230-243` 原文 "the team and workflow branches dispatch `event.plainText` straight into their own runtimes … and never reach that gate — **a confirmed bypass**. Mirror the same fail-closed check here" —— 但作者只给 route-handler 一侧补了门,**没给并行的 `fanOutWorkflowTriggers` 补**。
- 扇出侧无门:`lib/connectors/bus.ts:607` 无条件调用 `fanOutWorkflowTriggers`(仅 blocked/drop 时跳过);`bus.ts:913-970` 全段 **无** `hasNoLeakingPii`/`isInboundTextPiiSafe`/`redact` —— `:916 findMatchingWorkflows(..., { plainText: event.plainText })` → `:945 dispatchTrigger({ payload: event })` 原样透传;下游 `lib/workflow/runtime/trigger-bridge.ts:43-63 runWorkflow` 也不 gate。
- **决定性阳性对照(证明遗漏非设计)**:同样调 `dispatchTrigger` 的桌面事件扇出**有**门 —— `lib/workflow/runtime/desktop-event-trigger.ts:128-129` `// PII red-line` `const safeName = payload.name && hasNoLeakingPii(payload.name) ? payload.name : undefined`。connector inbound 扇出缺此同款门。
- 下游节点默认无门(auditor 坐实全三项):
  - `lib/workflow/nodes/ai/pii-gate.ts:44` `if (!mode || mode === "off") return { … redacted: false }`;`params-schemas.ts:1186` `piiGate: z.enum(["off","block","redact"]).optional()` 无 default ⇒ 未配置即 passthrough(`ai-prompt-v2.ts:73`、ensemble/council 同)。
  - `lib/workflow/nodes/actions/agent-turn.ts` 全文 **零** redact 引用;`:157 executeAgent(prompt, …)` 原样喂模型;`lib/ai/agent/agent-executor.ts` grep redact/Pii/hasNoLeaking = **0**。
  - `action.connector.send`(`built-ins.ts:2165 enqueueOutbound`)不重扫;`outbound-runner.ts:836 hasNoLeakingPiiDeep` **只在**插件 transform 分支(:834)生效,正常发送路径对原始 segments 无门。

**修法**(推荐 A,B/C 为纵深防御的后续):

- **A [推荐,最小正确,直接堵住主漏]** 在 `fanOutWorkflowTriggers` 内、`dispatchTrigger` 之前对 `event.plainText` 做与 `isInboundTextPiiSafe` **同款 fail-closed 检查**:不通过则**跳过该 workflow** 并写 `pii_blocked` 审计,镜像 `desktop-event-trigger.ts:129`。为复用,把 `isInboundTextPiiSafe` 从 `runtime.ts` 提到共享位置(如 `lib/connectors/pii-guard.ts`)或直接在 bus 调 `hasNoLeakingPii(event.plainText)`(bus.ts:57 已导入同族 `hasNoLeakingPiiDeep`,再加标量导入)。
- **B [纵深,建议随附]** 给 `action.agent.turn` 接入 `applyPiiGate`(与 `ai-prompt-v2.ts:73` 一致),并对 **connector-triggered** 运行强制 `piiGate` 非 `"off"` 默认(node 参数或 orchestrator 依 `triggeredBy.source==="im"` 覆盖)。
- **C [纵深]** `action.connector.send` enqueue 前 `hasNoLeakingPiiDeep(segments)`,或 outbound-runner 主发送路径对原始 segments 无条件 gate。

**验收**:

- verify: 构造一条含 PII 的 inbound 事件命中一个订阅 `trigger.connector.inbound` 的工作流 → 扇出被拦、写 `pii_blocked` 审计、工作流不启动(方案 A);无 PII 事件正常触发。
- 新增/更新 `lib/connectors/bus.workflow-trigger.test.ts`:含**失败复现测试**(先证明当前放行,再证明修后拦截)。
- 若做 B/C:`agent-turn.test.ts` / `built-ins`(connector.send)补 PII 门测试。
- **[OPEN Q1]** "把 inbound 原文经工作流回发到**同一**会话"是否算越线?文本本就来自该渠道,可争论;但回发到**不同** adapterId/conversationKey 属跨渠道外泄,明确越线。建议:门只拦"进 LLM"与"跨渠道回发",同会话回显可豁免 —— 需拍板(见 §8)。
- **changeset**:patch(安全修复,用户可见行为=之前会泄的现在被拦)。

---

## W2 — 跳转 / 导航闭环(P1,性价比最高:只差 UI 消费已有数据)

### W2.1 · X2 · 桌面 Tauri 不解析 `cognia://workflow-run` / `session` [P0/P1] [CONFIRMED]

**问题**:IM A2UI 进度卡片生成 `cognia://workflow-run/<wf>/<run>` 深链,但桌面 Tauri 的深链 switch **只认 chat/settings/workspace**,`workflow-run`/`session` 落到 `default → warn("unhandled deep link")`。桌面用户点 IM 卡片的"Open run detail"**直接失败**(移动端反而能路由)。功能性 bug。

**证据**:

- 卡片生成:`lib/connectors/a2ui-bridge/workflow-to-a2ui.ts:173-174 buildWorkflowRunDeepLink` → `` `cognia://workflow-run/${wf}/${run}` ``,`:400` 用于卡片 action。
- 桌面 switch 缺分支:`hooks/system/use-tauri-events.ts:102-121` `switch(action.kind)` 只有 `case "chat"`(:103)/`"settings"`(:110)/`"workspace"`(:114),`default:` `console.warn("unhandled deep link", raw)`(:121)。无 `workflow-run`/`session`。

**修法**:给桌面 switch 补 `case "workflow-run"` → `router.push(\`/workflows/run?id=${wf}&runId=${run}\`)`(与移动 `deeplink-router.ts`及真实路由一致,见 X3),补`case "session"`→ 复用 chat 打开逻辑(或统一到`chat`,见 X9)。深链 target 词表应有**单一真源**:抽一个 `parseCogniaDeepLink` 供桌面/移动共用,消除三 parser 分叉的一半(与 X9 联动)。

**验收**:verify: 桌面收到 `cognia://workflow-run/a/b` → 打开 `/workflows/run?id=a&runId=b`(而非 toast);`cognia://session/x` → 打开对应会话。补 `use-tauri-events.test.ts`。changeset patch。

### W2.2 · X3 · 工作流审批通知 href 拼错 → not-found [P1] [CONFIRMED]

**问题**:HITL 审批通知点开落到不存在的路由 —— href 拼的是 path 式 `/workflows/${wf}/runs/${run}`,而静态导出下**只有** query 式 `/workflows/run?id=&runId=`,无 `[id]/runs/[runId]` 动态段。审批跳转损坏。

**证据**:

- `lib/workflow/runtime/approval-notify.ts:76` `href: \`/workflows/${entry.workflowId}/runs/${entry.runId}\``。
- 实际路由(静态导出):`app/workflows/` 下仅 `run/page.tsx`(单数,query 参数)与 `runs/page.tsx`(复数,列表),**无** `[id]/` 动态段 → path 式 URL 落 not-found。
- 对照正确写法:`components/workflow/runs/run-detail.tsx:215 <Link href={\`/workflows/runs?id=${wf}\`}>`、`workflow-run-toaster.tsx:84`、移动 `recent-runs-feed.tsx:75` 全用 query 式。

**修法**:`approval-notify.ts:76` 改为 `` `/workflows/run?id=${encodeURIComponent(entry.workflowId)}&runId=${encodeURIComponent(entry.runId)}` ``(与 toaster / 移动 / run-detail 统一)。同时 grep 全库有无其它 path 式 `/workflows/<x>/runs/` 误拼。

**验收**:verify: 触发一次工作流审批 → 点通知 → 落 run detail(非 not-found)。补 `approval-notify.test.ts` 断言 href 为 query 式。changeset patch。

### W2.3 · X5 · 反向导航一片空白(数据齐、UI 无) [P1] [CONFIRMED]

**问题**:三处"两个相关上下文并存却无跳转",来源数据全都写好了:

1. **Inbox 活动日志的 `workflow.dispatched`/`team.dispatched`/`task.dispatched` 事件不可点** —— 纯 `<span>`,唯一 onClick 是折叠开关。用户看到"已派发某工作流/某团队"却进不去。
2. **Agent Team 工作区无任何回到来源的链接** —— 底层 run 的 `triggeredFrom.conversationKey`(IM 来源)从不被工作区 UI 消费。
3. **工作流 run-detail 不回链触发它的 IM 会话** —— `WorkflowRunRow.triggeredBy.conversationKey` 存在却不渲染。

**证据**:

- 数据已写:`lib/connectors/team-dispatch.ts:125-135 const triggeredFrom = { source, adapterId, conversationKey }`。
- 活动日志无链接:`components/inbox/conversation-activity-log.tsx` —— 事件类型标签(:47-55),条目 `<li>`(:136)内全 `<span>`(:142/145/148),唯一 onClick 是折叠(:116)。无 Link/router.push。
- 工作区无回链:`components/agent/workspace/overview.tsx` / `workspace-header.tsx` 不引用 `triggeredFrom`/`conversationKey`(阳性对照:grep 二者零命中于该目录)。
- run-detail 无反向链:`components/workflow/runs/run-detail.tsx` 的 Link/router.push 只指 `/workflows/runs`(:93/:215)、导出、re-run,不含 `triggeredBy`/`conversationKey`/inbox。

**修法**(三处独立,可拆 commit):

- ①**[快赢]** 活动日志 dispatched 事件按类型渲染成可点行:`workflow.*` → `/workflows/run?id=&runId=`、`team.*` → `/agent-teams/workspace?teamId=`、`task.*` → 对应 run。事件已带足够 id(`team-dispatch.ts` 侧 teamId/runId);若某类缺 id,补写入事件 payload。
- ② 工作区 header 加"来源"链:当底层 run `triggeredFrom.source==="im"` 时渲染一条 `→ 回到 IM 会话`(`/inbox/c?key=<conversationKey>`)。
- ③ run-detail 加对称回链:`triggeredBy.source==="im"` 时显示 `→ 触发它的 IM 会话`(同上)与(若某节点 spawn 了 agent session)`→ 打开 agent 会话`。
- 所有新文案 i18n 双语(en/zh-CN)。

**验收**:verify: IM 触发一个团队/工作流 → Inbox 活动日志点"已派发"进入对应 run/工作区;工作区/ run-detail 各有回到 IM 会话的链且能打开。补三处组件测试(query by role/link)。changeset minor(新增可见跳转)。

---

## W3 — 反向联动边(P1)

### W3.1 · X4 · Agent(headless/MCP)/ Team-delegate → 工作流 反向边缺失 [P1] [CONFIRMED]

**问题**:工作流→Agent/Team 很丰富,但反向缺两条:① **headless / 外部 MCP 客户端**无法拉起可视化工作流 —— external-bridge 编排面只暴露 `agent_dispatch` + `team_run`,**无 `workflow_run`**;② `action.team.delegate` 的目标枚举不含 workflow,团队无法把子问题委派给一个工作流。(注:会话内 chat agent 经 workflow-ai 插件工具**能**跑工作流 —— 那条路径的缺陷归**既有计划**,本项只补这两条本文独有的反向边。)

**证据**:

- `lib/external-bridge/handlers/orchestration.ts`:顶部契约(:5-7)只列 `agent_dispatch`/`team_run`;dispatch case 表(:363-365)仅这两 case;全文无 `workflow_run`/`runWorkflow`。
- `sidecar/builtin-tools/` grep `run_workflow\|workflow_run\|runWorkflow` = **0**。
- `lib/workflow/nodes/actions/team-ops.ts:40` `target?: "twin" | "background" | "external" | "team"` —— 无 `"workflow"`;delegate 分支(:217+)无 workflow 处理。

**修法**:

- ① external-bridge 新增 `workflow_run` handler:入参 `{ workflowNameOrId, input?, waitForCompletion? }`,renderer 侧复用 `wf_run_workflow_typed` 的核心(要求 `published`、校验 interface、`runWorkflow`),**沿用 `agent_dispatch`/`team_run` 同款 PII 门 + 审计**(orchestration.ts:28 已有 PII 说明,照抄)。注册进 MCP 工具 schema。
- ② `action.team.delegate` target 加 `"workflow"`:入参携带 `workflowId` + `input`,内部委托 `runWorkflow`(带 team origin + 深度守卫,复用 `flow.subworkflow` 的 `MAX_SUBWORKFLOW_DEPTH` 思路防环)。
- 二者与既有计划的 `trigger.workflow.completed`(G3)正交,可独立落地;若同期做,注意 delegate→workflow 与 completed-trigger 组合的链路深度共用一个守卫。

**验收**:verify: ① 外部 MCP 客户端调 `workflow_run` → 一个已发布工作流跑完并回类型化输出,含 PII 门拦截用例;② 一个团队 delegate 到 workflow target → 子工作流以团队上下文启动、结果回 blackboard。补 `orchestration.test.ts` + `team-ops.test.ts`。changeset minor。

- **[OPEN Q2]** headless `workflow_run` 是否受 X8 的 risk-gating 约束?建议:external/MCP 触发视同 headless,强制 `riskGating` 生效(与 IM→Team 对齐),见 §8。

---

## W4 — 跨端与一致性(P1/P2)

### W4.1 · X6 · Web/移动端 cron/webhook/github 触发器静默失效 [P1/P2] [CONFIRMED]

**问题**:`trigger.cron`/`trigger.webhook`/`trigger.github.webhook` 纯靠 Rust daemon(`crates/cognia-scheduling/src/workflow/triggers/`);`!isTauri()` 时 Tauri bridge **优雅 no-op** ⇒ 这三类定时/webhook 自动化**在桌面外静默永不触发**,无 TS 兜底(connector/chat/goal/team 触发是纯 TS,处处可用)。另:webview 真正关闭(非最小化)时,Rust 只重发 resume 事件、每个节点仍在 TS webview 执行 —— IM/cron 拉起的长 `action.team.run` 无法后台推进。

**证据**:

- `lib/workflow/runtime/tauri-bridge.ts:6` docstring "wrappers no-op gracefully when running outside Tauri";`:38 if (!isTauri()) return null`;`:103` subscribe 返回 no-op unsubscribe。
- 对照:纯 TS 触发(connector.inbound `bus.ts:913`、chat.message `messages.ts`、goal/team completion `completion-linkage-core.ts`)不依赖 Rust,全端可用。

**修法**(大改,分级):

- **[OPEN Q3]** 是否给 web/移动补 TS 侧 cron 兜底?选项:(a) 明确**产品降级**——在编辑器对 cron/webhook 触发标"仅桌面",web/移动运行时给可见提示(小改,诚实);(b) web 侧接一个轻量 TS 定时器兜底 cron(webhook 无 HTTP server 天然做不到,静态导出限制,见 CLAUDE.md 静态导出 caveat)。建议先做 (a) 止血 + 文档,(b) 视需求再议。
- 长团队运行的后台推进属 headless 执行范畴,与 `docs/plans/2026-07-16-headless-full-parity.md` 交叠 —— **交叉引用,不在本文重复规划**。

**验收**:verify(方案 a): web 模式打开一个带 cron 触发的工作流 → 编辑器显示"仅桌面"提示;桌面不变。补 trigger 表单测试。changeset patch。

### W4.2 · X7 · bot 模型 pin 对 IM 团队成员不生效 [P2] [CONFIRMED]

**问题**:单角色 IM 回复遵守 bot 实例模型 pin(deliberately BEATS `character.model`),但**团队路径绕过 `resolveSendOptions`**,团队成员用自己的 `modelOverride ?? character.model` —— bot pin 到某模型时,其团队成员**静默不 pin**。契约漂移("bot pin 打败 character.model"只对单角色成立)。

**证据**:

- 单角色 pin:`lib/claude/build-options.ts:1011` 注释 "The bot-instance default deliberately BEATS `character.model`",逻辑在 987-1023 的 IM 分支(`imDefaultModel = imAdapterRow?.defaultModel`)。
- 团队成员无 pin:`build-options.ts:725 model: member.modelOverride ?? character.model` —— 不读 `imAdapterRow.defaultModel`。
- `team-dispatch.ts` docblock 自陈不改 `resolveSendOptions`,确认团队路径不走 IM 模型分支。

**修法**:团队成员解析模型时,若该 run 有 IM origin(`triggeredFrom.source==="im"` 且能取到 `adapterId`),在 `member.modelOverride ?? adapterRow.defaultModel ?? character.model` 顺序里插入 bot 默认(优先级低于成员显式 override、高于 character.model,与单角色语义一致)。需把 adapterRow/defaultModel 透传进团队成员的 build-options 分支。

- **[OPEN Q4]** 这是否是期望行为?"bot pin 应约束它拉起的整个团队"符合直觉,但也可能有意让团队成员保留各自模型。需产品确认(见 §8)。

**验收**:verify: 一个 pin 了模型 M 的 bot 从 IM 拉起团队 → 成员默认用 M(除非成员有显式 override)。补 `build-options.test.ts`(注意记忆:该套件有 pre-existing red,gate 你自己的断言)。changeset patch。

### W4.3 · X8 · risk-gating 默认不对称(IM→工作流 OFF vs IM→Team ON) [P2] [CONFIRMED]

**问题**:同样从 IM 拉起、同样 headless,走 Team 默认开风险门(fail-closed),走**工作流默认关**(opt-in)。IM 触发的危险工作流(含 shell/desktop/computer-use 节点)因此**不经** IM→Team 那条等价路径强制的 fail-closed 门。

**证据**:

- 工作流默认 OFF:`lib/workflow/runtime/risk-gate.ts:86-88 return workflow.settings?.riskGating === true`;docstring(:78-84)明写这是 **ADR-0070 决策 #2**,`undefined→OFF`,理由是避免回溯破坏既有无字段工作流(`zhihu-content-pipeline` 模板带真 terminal 节点)。
- 团队默认 ON:`lib/ai/agent/agent-team-runtime.ts:387 (team.config.riskGating ?? true) && requiredCeremony(...).requirePlanApproval`;headless "im" 运行 fail-fast(:395-401)。`:383` 注释确认风险判定 origin-blind。

**修法**(这是 ADR-0070 有意取舍,**非纯 bug** —— 需拍板后再动):

- **[OPEN Q5]** 三选一:(a) 维持现状,仅在文档/编辑器把这条不对称显式化(最小,尊重 ADR-0070);(b) 对 **IM/外部触发的 headless 工作流运行**特判:即使 `settings.riskGating` 未设,也强制风险门(与 IM→Team 对齐)—— 更安全但可能破坏既有 IM 触发工作流,需迁移公告;(c) 编辑器对含高危节点的工作流强制 `riskGating:true`(已对新建工作流盖 true,扩到"含高危节点"即可)。作者倾向 (b) 仅限 IM/external 触发路径 + (c) 编辑器兜底,但涉及兼容,需产品拍板。

**验收**(视选项):verify: 一个 settings 无 riskGating、含 `action.system.terminal` 的工作流经 IM 触发 headless 运行 → 按选定策略被门拦/放行。补 `risk-gate.test.ts` + orchestrator headless 用例。若改默认:changeset minor + 迁移说明。

### W4.4 · X9 / X10 · 深链与全局导航补位 [P2] [AGENT]

- **X9 [AGENT]** 无 `cognia://team/<id>`(IM 卡片能深链 workflow-run 却深链不到团队看板);三套 `cognia://` parser 词表分叉(桌面 chat/ vs 移动 session/)。**动手前复核** `lib/capacitor/deeplink.ts` 的 `DeeplinkRoute` 联合类型有无 team 分支。修:抽单一 `parseCogniaDeepLink`(桌面/移动共用,与 X2 联动),补 `team` target → `/agent-teams/workspace?teamId=`;A2UI 团队卡片生成该深链。
- **X10 [AGENT]** 桌面全局命令面板(`components/desktop/command-palette.tsx`)到不了 workflow / agent-team 工作区 / inbox 会话 / connector。**动手前复核**其可达项。修:加这四类目标的命令项(复用各自的 liveQuery 列表)。
- 二者均新文案 → i18n 双语。

**验收**:verify: 命令面板搜到并跳转一个工作流/团队/inbox 会话;IM 团队卡片深链在桌面打开团队看板。补面板/深链测试。changeset minor。

---

## 8. 待决策 [OPEN]

- **Q1(X1)** 经工作流把 inbound 原文回发到**同一**会话是否算越线?建议门只拦"进 LLM"与"跨渠道回发",同会话回显豁免。**这是修 X1 的方案边界,必须先定。**
- **Q2(X4)** headless `workflow_run` 是否强制受 risk-gating(与 IM→Team 对齐)?建议是。
- **Q3(X6)** web/移动 cron 兜底:先"仅桌面"降级提示 + 文档(a),还是接 TS 定时器(b)?建议先 (a)。
- **Q4(X7)** bot 模型 pin 是否**应当**约束它拉起的团队成员?建议是,但需产品确认这是期望语义。
- **Q5(X8)** risk-gating 不对称:维持(a)/ IM·external 触发强制门(b)/ 编辑器对高危节点强制 true(c)?这直接改 ADR-0070 决策 #2,需产品拍板。

---

## 9. 执行顺序与门禁

**顺序**(尊重依赖 + 严重度):

1. **W1.1 (X1) 先行** —— P0 安全,独立,先堵漏。
2. _*W2.* (X2/X3/X5) 一批_* —— 跳转闭环,性价比最高,X2/X9 的深链单一真源可一起抽。
3. **W3 (X4)** —— 反向边,minor feature。
4. _*W4.* (X6/X7/X8/X9/X10)_* —— 跨端与一致性,X8 待 §8-Q5 拍板后再动。

**每项落地必须**(本仓硬规则,见 CLAUDE.md):

- **co-located 测试**:改动 `lib/**`、`components/**`、`plugins/**`、`src-tauri/src/**` 每个文件配 `*.test.ts(x)` / `#[cfg(test)]`;覆盖率 ≥90%(`pnpm test:coverage:changed -- --strict`,scoped)。X1 必须含**失败复现测试**。
- **i18n 双语**:X5/X9/X10 的新文案 + X6 的降级提示 → `i18n/messages/{en,zh-CN}.json` 同步,`pnpm lint:i18n` 过基线。
- **changeset**:用户可见项 `pnpm changeset` 选 `cognia-next`(X1 patch、X2/X3 patch、X5 minor、X4 minor、X6 patch、X7 patch、X9/X10 minor)。
- **preflight**:提交前跑 `preflight` skill(test-gap / i18n / static-export / tauri-rust / **pii-gate** / wiring 六审)—— X1 尤其必过 pii-gate 审。
- **verify-before-done**:每项按其"验收"跑真流程(不只单测),贴输出。

**门禁基线注意**(见项目记忆):typecheck/lint 现绿(16384 heap + storybook-static ignore);i18n-sort / coverage:changed 有 pre-existing 红,**只 gate 你自己的文件**;`build-options.test`(X7 相关)有 pre-existing red,只断言你新增的部分。

**与既有计划协同**:本文与 `2026-07-16-workflow-linkage-remediation.md` 无重叠工作项(唯一交叠 `flow.wait` 归后者)。若两计划同期推进,共享 `flow.subworkflow` 深度守卫思路(X4)与 A2UI/工作流卡片渲染(X2/X5)。
