# 工作流联动 — 跳转、逻辑组合与"可调用单元"收敛修复计划

**日期**: 2026-07-16
**状态**: 待评审(未实施 —— 下文每一项都是已核实的缺陷或缺口,不是设想)
**范围**: 四波 —— W1 承重缺陷(改动小、收益高、改变真实行为)、W2 联动闭环收敛(D5 + 链式触发)、W3 逻辑表达力与半成品补完、W4 低危 + 文档补位
**参考 ADR**: 0011(workflows 主 ADR)、0017(插件节点/触发扩展点)、0022(并发调度)、0034(编辑器完备性 + error-branch)、0061(跨设备执行)、`lib/workflow/CONTEXT.md`(编排 harness 决策 D1–D7)、拟新增 **0077**(工作流可调用单元收敛 + 完成触发,见 W2/W4.3)

---

## 0. 如何使用本文档

每个工作项自成单元:**问题 → 证据 → 修法 → 验收**。除非标注 **依赖**,否则彼此独立,一项一个 commit。沿用本仓 `2026-07-16-scheduler-subsystem-remediation.md` 的置信标签约定。

| 标签            | 含义                                         | 你必须做什么                                   |
| --------------- | -------------------------------------------- | ---------------------------------------------- |
| **[CONFIRMED]** | 本文作者亲手 read/grep 核实,file:symbol 已对 | 可信,但行号会漂 —— **按符号重新定位,别按行号** |
| **[AGENT]**     | 由 subagent 提供证据,作者未独立复核          | **动手前先自行复核这条具体主张**               |
| **[OPEN]**      | 真正未决,需要人拍板                          | **不要默默替它做决定**,见 §8                   |

> 本次调研由三个 subagent 完成(控制流语义 / 工作流互调 / 结构化输出构件),随后作者**对 W1、W2 的全部承重主张 + W3 的 G6/G7/G8/G9 做了一手复核**(read 到具体符号)。凡出现「零 / 不存在 / 从不」的主张均已跑阳性对照。W4 的部分 LOW 项仍是 [AGENT]。

### 0.1 证据标准(不可妥协)

凡「某工具/某触发不存在」的主张,均以引号包裹 grep + 阳性对照确认:

```bash
# 阳性对照(引号必须有):已知存在的符号必须命中,否则工具坏了
rtk grep -rn "wf_run_workflow_typed" plugins --include="*.ts" -l   # 必须命中
rtk grep -rn "wf_<slug>|trigger.workflow.completed" --include="*.ts" .  # 此时的零才可信
```

---

## 1. 研究结论(先读这节,它推翻了「本仓工作流不支持联动」的默认假设)

第一直觉是「要给工作流加联动/跳转能力」。**事实相反:引擎已是成熟的 n8n 式编排器,联动/跳转/逻辑组合的骨架基本齐备。** 真正的问题不是"没有",而是三类:**① 联动闭环的最后一环接线断了(发布出的技能指向一个从未注册的幽灵工具);② 有些控制流通过了校验却在运行期是死的(顶层回边不迭代、flow.wait event 模式是 no-op);③ 一批默认值/版本互相打架(maxConcurrency 1 vs 4、新节点默认 v1 退化版)。**

- **图内逻辑跳转/组合**已完备:11 个 `flow.*` 节点(branch/switch/loop/split/join/subworkflow/wait/break/continue/catch/set),v2 分支有 15 算子 + all/any 组合,error-branch 用 error 句柄做失败跳转(ADR-0034 已实现)。[CONFIRMED]
- **工作流互调**已有 `flow.subworkflow`(id 解析、深度守卫 10、接口 JSON-Schema 校验)+ 三个 agent 可调的通用 runner(`wf_run_workflow_typed`/`wf_run_workflow_by_name`/`wf_run_workflow`)。[CONFIRMED]
- **可组合构件**(CONTEXT.md 自陈的 D3/D6 三大"未实现"缺口)**其实早已 ship**:结构化输出(agent.turn/ai.prompt v1 已带校验+重试)、ai.ensemble/council、data.aggregate 七操作 reducer、eval.gate/run 真 harness —— **CONTEXT.md 的 D 段是过时的**。[AGENT,W4.4 复核后更新]

> **所以本计划不是「加联动功能」,而是「把已建成的联动接好线、把死的半成品激活、把打架的默认值统一」。**
> 一句话总结:**引擎是好的;发布→技能→工具的收敛在最后一环断线(W1.1);顶层循环在静默不循环(W1.2);并发默认值四处对不上(W1.3);工作流之间没有原生"完成即触发下一个"(W2.2);还有 flow.wait event、ai.prompt v2 校验等半成品(W3)。**

**为什么没被发现**:这些是"过校验但运行期无效"或"数据模型存在但运行时未消费"型缺陷 —— 静态看代码都在,只有真跑一遍联动闭环才暴露。

---

## 2. 现有能力全景(本次调研的可复用产出 —— 也是"详细研究现有联动功能"的交付物)

### 2.1 图内逻辑跳转与组合(`flow.*`,11 节点)

| 节点                               | 语义                                                                                                                            | 表达力                                       | 状态   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------ |
| `flow.branch` v2                   | `evaluateConditionGroup` → `true`/`false` 句柄                                                                                  | 15 算子 + all/any + caseSensitive,无 JS eval | 🟢     |
| `flow.switch` v2                   | 有序 case,首个命中 group 胜,decision=case id                                                                                    | 同条件语言                                   | 🟢     |
| `flow.loop` v2(容器)               | 真循环:forEach/times/while(pre/post)、iterationConcurrency、batchSize、onItemError、break/continue、`$item`/`$loop`、共享累加器 | 全引擎最富节点                               | 🟢     |
| `flow.join`                        | all(默认)/any/race(并取消败支),可内联 aggregate                                                                                 | 隐式 DAG join 本就一等公民                   | 🟢     |
| `flow.split`                       | 纯透传,靠多出边扇出                                                                                                             | 无 copy/partition 语义                       | 🟢(薄) |
| `flow.catch`                       | 终局安全网,run 失败后作独立子 run 跑,错误经 `$catch` 注入                                                                       | 非常规 DAG 一环                              | 🟢     |
| `flow.set/break/continue`          | 变量写入 / 循环哨兵                                                                                                             |                                              | 🟢     |
| `flow.subworkflow`                 | 见 2.2                                                                                                                          |                                              | 🟢     |
| `flow.wait`                        | **duration 可用;event 模式 no-op**(W3.2)                                                                                        |                                              | 🟠     |
| `flow.{branch,switch,loop}` **v1** | 遗留:v1 分支 isTruthy 把任意非空串当真;v1 loop **只产数组不跑循环体**;新节点默认走 v1(W3.4)                                     |                                              | 🟠     |

**错误路由**(逻辑跳转的隐藏一环,两层独立机制):节点级 `errorHandling.onError`(continue/defaultValue/errorBranch)优先于工作流级 `settings.errorPolicy`(branch/continue/stop);errorBranch 走 `sourceHandle==="error"` 错误边。ADR-0034 已完整实现。[AGENT]

### 2.2 工作流互调与可调用单元(D5)

| 机制                                                                                                 | 如何工作                                                                                                         | 状态                                        |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `flow.subworkflow`                                                                                   | 按 workflowId 解析,`MAX_SUBWORKFLOW_DEPTH=10` 深度守卫,新 runId 内进程跑,若目标声明 interface 则校验输入/输出    | 🟢 扎实                                     |
| `io.output` 类型化终值                                                                               | 校验 run 终值 vs outputSchema,onSchemaViolation 默认 fail                                                        | 🟢                                          |
| `wf_run_workflow_typed`                                                                              | 通用 runner:取 `name`、要求 `published`、校验输入输出、requiresApproval                                          | 🟢                                          |
| `wf_run_workflow_by_name` / `wf_run_workflow` / `wf_list_workflows` / `wf_subscribe_workflow_fanout` | IM/编辑器 run + 列举 + 订阅进度                                                                                  | 🟢                                          |
| 工具触达 chat/连接器 agent                                                                           | builtin 插件 `cognia-workflow-ai`(startup) 用 `ctx.agent.registerTool` 注册                                      | 🟢(依赖插件启用)                            |
| `publishWorkflow`                                                                                    | 从 `trigger.manual.inputSchema`+`io.output.outputSchema` 派生 interface,盖 published,建 `kind:"workflow"` 技能行 | 🔴 **正文指向幽灵工具**(W1.1)               |
| 工作流即技能(`kind:"workflow"`)                                                                      | 技能行带 workflowId                                                                                              | 🟠 **仅数据模型,渲染/工具注册未特判**(W2.1) |

### 2.3 跨系统 / 跨设备联动

- **调度器**:`workflowTriggers` 投射为统一定时项,`runNow`→`runWorkflow`(shipped)。[CONFIRMED]
- **跨设备**(ADR-0061):hub 编排、**按步**派发到有能力设备(camera/scan/location/share/notify),能力词表 + 运行前 preflight + run lease 争用,L0–P4 已实现;整 run 迁移待 P5。[AGENT]
- **A2UI/IM**:`workflow-to-a2ui.ts` 把 run 进度投射为平台富内容。[AGENT]
- **11 类 trigger**:manual/cron/webhook/chat.message/connector.inbound/goal.completed/team/desktop.event/pet.event/terminal.command/github.webhook —— **但没有 `trigger.workflow.completed`**(W2.2)。[CONFIRMED]

---

## 3. 缺口总表(按严重度 + 修复性价比排序)

| ID  | 缺口                                                   | 级别        | 波次 | 置信        | 改动量      |
| --- | ------------------------------------------------------ | ----------- | ---- | ----------- | ----------- |
| G1  | 发布出的技能指向一个从未注册的 `wf_<slug>` 幽灵工具    | 🔴 CRITICAL | W1.1 | [CONFIRMED] | 小          |
| G2  | 顶层回边过校验却不迭代,校验器文案还误导                | 🟠 HIGH     | W1.2 | [CONFIRMED] | 中          |
| G4  | `maxConcurrency` 默认值 1/4 四处打架                   | 🟠 HIGH     | W1.3 | [CONFIRMED] | 小          |
| G5  | 图体技能启用时不注册工具、不特判渲染                   | 🟠 HIGH     | W2.1 | [CONFIRMED] | 中          |
| G3  | 无原生"工作流完成→触发下一个"联动                      | 🟠 HIGH     | W2.2 | [CONFIRMED] | 大(feature) |
| G8  | `ai.prompt` v2 / classify / extract 丢失结构化输出校验 | 🟡 MEDIUM   | W3.1 | [CONFIRMED] | 中          |
| G7  | `flow.wait` event 模式是 no-op stub                    | 🟡 MEDIUM   | W3.2 | [CONFIRMED] | 中          |
| G6  | 表达式/条件只能读直接前驱,无全局 `$node[]`             | 🟡 MEDIUM   | W3.3 | [CONFIRMED] | 中          |
| G9  | 新节点默认 v1(退化 loop / isTruthy 陷阱)               | 🟡 MEDIUM   | W3.4 | [CONFIRMED] | 小          |
| G10 | 子调用输入是裸 JSON 文本框,无类型化字段                | 🟡 MEDIUM   | W4.1 | [AGENT]     | 中          |
| G11 | split 无 partition;循环体内 join 静默降级 all          | 🟢 LOW      | W4.2 | [AGENT]     | 小          |
| G13 | `data.transform` reduce 只 sum,易误当通用 fold         | 🟢 LOW      | W4.2 | [CONFIRMED] | 小          |
| G14 | `cognia-workflow-ai` 自述低估 agent 直跑路径           | 🟢 LOW      | W4.2 | [AGENT]     | 微          |
| G15 | `CONTEXT.md` D3/D6 段过时,误导后续开发                 | 🟢 LOW      | W4.4 | [AGENT]     | 文档        |

---

## W1 — 承重缺陷(快赢:改动小、收益高、改变真实行为)

### W1.1 · G1 · 发布出的技能指向一个从未注册的幽灵工具 [CRITICAL] [CONFIRMED]

**问题**:发布一个工作流后,生成的 `kind:"workflow"` 技能正文指示模型"call the `wf_<slug>` tool",但**全库没有任何地方注册叫 `wf_<slug>` 的工具**。模型启用该技能后被指向一个不存在的工具,联动闭环在最后一环彻底断裂。这是 D5"published callable unit"表面①(每工作流类型化工具)的落空 —— 真正 ship 的是**一个通用分发器** `wf_run_workflow_typed`(取 `name` 参数),而技能正文从不提它。

**证据**:

- `lib/workflow/publish/publish-workflow.ts` · `toolNameForWorkflow()` 生成 `wf_${slug}`;`workflowSkillContent(name, toolName)` 把它烤进正文("call the \`${toolName}\` tool")。**注意**:同文件顶部 docstring(:10)声称正文指向 `wf_run_workflow_typed`,与实际生成的 `wf_<slug>` **自相矛盾**。
- `plugins/workflow-ai/src/tools/*` 注册的全部工具名:`wf_list_workflows`/`wf_run_workflow_by_name`/`wf_subscribe_workflow_fanout`/`wf_run_workflow_typed`/`wf_run_workflow`/`wf_read_*`/`wf_*` —— **无 `wf_<slug>`**。`toolNameForWorkflow` 仅在 `publish-workflow.ts` 内部被引用(阳性对照已跑)。
- 真 runner `plugins/workflow-ai/src/tools/run-typed-tools.ts` · `wf_run_workflow_typed`:要求 `workflow.published`(否则 `not-published` 错误)、校验 `interface.inputSchema`/`outputSchema`、`runWorkflow` 跑图 —— 功能完整,只是名字对不上、且技能不指它。

**修法**(二选一,先做①,②列为 D5 完整化的后续):

1. **[推荐,最小正确]** 改 `workflowSkillContent`:正文改为指示"call the `wf_run_workflow_typed` tool with `{ name: <workflow.name> }`",并说明它会跑图返回类型化输出。同时 `published.toolName` 字段保留仅作展示,不再暗示同名工具存在。
2. **[完整,交付 D5 表面①]** 让发布真正注册一个绑定该 workflow 的每工作流类型化工具 `wf_<slug>`(内部委托 `wf_run_workflow_typed` 并预绑 name),经 `cognia-workflow-ai` 的注册通道下发。代价:需处理工具生命周期(发布→注册、下架→注销)与命名冲突。

**验收**:

- verify: 发布一个工作流 → 读其 `kind:"workflow"` 技能正文,断言含 `wf_run_workflow_typed`(方案①)或存在同名注册工具(方案②),且**不含**悬空 `wf_<slug>` 文本。
- 新增/更新 `lib/workflow/publish/publish-workflow.test.ts`:断言生成正文引用真实可调用工具名。
- 手工 E2E:在启用 workflow-ai 插件的会话里启用该技能 → 模型能真正调用工具并跑完图。
- **依赖**:与 W2.1(G5)强相关 —— 正文指对了,还得保证工具在会话里(见 W2.1)。

### W1.2 · G2 · 顶层回边过校验却不迭代,校验器文案误导 [HIGH] [CONFIRMED]

**问题**:一个经典反馈循环 `A → flow.wait → A`(或经 `flow.loop@1`)**能通过校验**,但运行期**每个节点只跑一次**,不迭代。用户以为搭了循环,实际是静默单次通过。真循环只有 `flow.loop@2` 容器。更糟:校验器的报错文案主动建议"加 flow.loop 或 flow.wait 让回边显式化",把陷阱说成了解法。

**证据**:

- `lib/workflow/runtime/orchestrator.ts`:`backEdgeIds = new Set(sortResult.backEdges…)`;`topLevelForwardEdges` 用 `!backEdgeIds.has(e.id)` **把回边过滤出依赖图**,`stepDeps` 因此永不含回边 —— 回边被丢弃,从不重新遍历。
- `lib/workflow/definition/validate.ts` · `collectUnauthorizedCycleNodes()`:授权条件是环上有 `flow.loop` **或** `flow.wait` 节点(不校验 loop 的 typeVersion),`flow.loop@1` 退化版也能"授权"。报错文案:`"Cycle detected through nodes: … Add a flow.loop or flow.wait node to make the back-edge explicit."`(:454)—— 误导。
- `flow.loop@1` 本身只产数组不跑循环体(见 W3.4),叠加此洞双重坑。

**修法**(推荐 A,B 为长期):

- **A [推荐]** 收紧校验:顶层环若不是被 `flow.loop@2` 容器包裹,判**非法**,报错改为"把需要循环的区域放进 flow.loop 容器"。同时把 `flow.wait` / `flow.loop@1` 从 `BACK_EDGE_KINDS` 授权里移除(event-wait 是 stub、v1 loop 退化,二者当前都无可用的回边语义)。
- **B [长期,大改]** 让编排器对授权回边做真不动点迭代 —— 风险高(等价于把 DAG 调度器改成带回边的迭代器),不建议在本波做。

**验收**:

- verify: `A → flow.wait → A` 的顶层图 → 校验失败,报错清晰指向 flow.loop 容器;`flow.loop@2` 容器图仍校验通过并真迭代。
- 更新 `lib/workflow/definition/validate.test.ts` + `orchestrator.test.ts`。
- **[OPEN]** 是否保留 `flow.wait` 作为未来 event-resume 的授权回边(见 §8-Q3):当前建议移除,待 W3.2 落地 event 模式后再议。

### W1.3 · G4 · `maxConcurrency` 默认值四处打架(1 vs 4) [HIGH] [CONFIRMED]

**问题**:同一工作流是顺序跑还是 4 并发,纯看持久化 `settings` blob 里有没有 `maxConcurrency` 字段 —— 因为四个默认源不一致。这直接影响 `flow.split` 扇出、ai.ensemble、并行分支的实际并发度,是不可复现行为的温床。

**证据**(四处):

- `lib/workflow/definition/validate.ts`:`maxConcurrency: z.number().int().min(0).max(100).optional()` —— **无 `.default()`**,校验从不回填。
- `types/workflow/visual.ts` · `DEFAULT_WORKFLOW_SETTINGS.maxConcurrency = 4` —— 新建/seed 工作流盖 4。
- `lib/workflow/runtime/orchestrator.ts`:`… ?? createConcurrencyController(validated.settings.maxConcurrency ?? 1)` —— 兜底 **1**,且注释(:12/:119)自陈"默认 1 保留 legacy 顺序行为"。
- `components/workflow/editor/inspector/forms/index.tsx`:`readNumber(params,"maxConcurrency",4)` 显示默认 **4**;`settings-tab.tsx` 侧显示 `?? 1`([AGENT],作者仅复核了 forms 侧的 4)。

**修法**:选定唯一默认值,四处对齐。

- 给 zod schema 加 `.default(N)`,让校验回填;`orchestrator` 兜底改为 `?? DEFAULT_WORKFLOW_SETTINGS.maxConcurrency`;两个编辑器表单统一显示同一默认。
- **[OPEN Q1]** N 取 1 还是 4?
  - 取 **4**:与新建工作流现状(DEFAULT=4)一致,联动/扇出更快;但**把 legacy 无字段工作流从 1→4** 可能改变有副作用节点的并行行为。
  - 取 **1**:与 orchestrator 文案(ADR-0022 legacy 顺序)一致、最安全;但与"新建即 4"矛盾,需把 DEFAULT 也改回 1。
  - 作者倾向 **4**(新建工作流早已 4-wide,legacy 手搓无字段 settings 极少见),但这是产品/兼容决策,需拍板。

**验收**:

- verify: 一个 settings 无 `maxConcurrency` 的持久化工作流,跑起来的实际并发度 = 选定默认;两个编辑器表单显示同一数字。
- 新增 orchestrator 测试:无字段 settings → 并发控制器初始值 = 默认。

---

## W2 — 联动闭环收敛(把 D5 接完,补原生链式触发)

### W2.1 · G5 · 图体技能启用时不注册工具、不特判渲染 [HIGH] [CONFIRMED]

**问题**:D5 称"启用 `kind:"workflow"` 技能时 (a) 用 `renderSkillsCatalog` 渐进披露注入、(b) 注册一个跑图的工具"是"新颖不可逆的部分"。实际两半都没做:workflow 技能与普通 markdown 技能**同路渲染、无特判**;启用技能**不注册/不保证任何工具**,能否跑图完全取决于环境里恰好有通用 runner(且名字还对不上,见 W1.1)。技能与 runner 解耦。

**证据**:

- `lib/db/skills.ts` · `renderSkillsSection()` / `renderSkillsCatalog()`:对每个技能一视同仁(`## name\n\ncontent` 或 `- id — name: desc`),**不特判 `kind:"workflow"`**(阳性对照:`grep 'kind === "workflow"' lib/skills lib/db/skills.ts` 零命中,`load_skill` 等已知符号命中)。
- `lib/claude/build-options.ts`:workflow 技能经通用技能投射路径注入,无工具注册副作用。[AGENT]

**修法**:把"启用图体技能"与"该图可被调用"耦合起来。

- 在技能投射处(build-options 的 skills → tools 环节)特判 `kind:"workflow"`:当有 workflow 技能激活时,**确保 `wf_run_workflow_typed` 在会话工具清单中**(若 workflow-ai builtin 插件未启用则自动补齐该工具,或直接注册一个绑定 workflowId 的最小 runner)。
- 渲染侧:catalog 行/正文明确指向真实工具 + workflow name(与 W1.1 方案①统一)。

**验收**:

- verify: 在**未手动启用 workflow-ai 插件**的会话里启用一个已发布工作流技能 → 模型仍能调用 runner 跑图(工具被自动补齐)。
- 单测:技能投射在含 workflow 技能时,产出的工具清单含 runner。
- **依赖**:W1.1(正文指对工具名)。二者应在同一波内一起验收,否则任一单独修都不闭环。

### W2.2 · G3 · 无原生"工作流完成→触发下一个"联动 [HIGH] [CONFIRMED]

**问题**:子系统内**没有**工作流链式触发。不存在 `trigger.workflow.completed` 触发种类;可视化编排器完成时只 fire `onWorkflowComplete` **插件 hook**,不向任何总线发事件。唯一的"完成→跑下一个"是**调度器**的事件任务,且仅当首个工作流以 `task.type:"workflow"` 调度任务启动时成立 —— `flow.subworkflow`/工具调用/trigger 节点/编辑器 Run 都不触发。⇒ 用户想搭"工作流 A 完成 → 工作流 B 启动",今天只能靠 `flow.subworkflow` 显式内嵌(父吞子),无法解耦编排。

**证据**:

- 阳性对照:`grep "trigger.workflow.completed|workflow:completed" lib/workflow types/workflow` —— 仅 `orchestrator.ts` 一条**注释**提到 `onWorkflowComplete`;无触发种类、无事件发射。
- `lib/workflow/runtime/trigger-subscriptions.ts` 订阅的触发种类里无 workflow-completed。
- 调度器侧的 `workflow:completed`(`lib/scheduler/task-scheduler.ts`)只在 scheduler 任务路径发,不覆盖 orchestrator 直跑。[AGENT]

**修法**(net-new feature,拟归 ADR-0077):

1. 新增触发种类 `trigger.workflow.completed`:catalog 条目 + i18n(en/zh-CN) + 检查器表单(选源工作流 + 可选状态过滤 succeeded/failed/any) + `trigger-subscriptions.ts` 订阅。
2. 编排器在 run 终态时,除现有插件 hook 外,向工作流触发总线(复用 `wake-bus` 或新建轻量 emitter)发 `{ workflowId, runId, status, output }`;`trigger.workflow.completed` 订阅消费之并 `runWorkflow` 目标工作流,payload 携带源输出。
3. **防环/防风暴**:沿用 `flow.subworkflow` 的深度守卫思路,给链式触发加深度上限 + 同 workflowId 自触发防护(A 完成触发 A 直接拒),记录链路 depth 到 trigger payload。

**验收**:

- verify: 工作流 A 挂一个 completed-trigger 指向 B(状态过滤 succeeded)→ 跑 A 成功后 B 自动以 A 的输出启动;A 失败时 B 不启动。
- 新增测试:订阅消费 + 编排器发射 + 深度守卫拒绝自触发环。
- changeset:minor(用户可见新触发类型)。

---

## W3 — 逻辑表达力与半成品补完

### W3.1 · G8 · `ai.prompt` v2 / classify / extract 丢失结构化输出校验 [MEDIUM] [CONFIRMED]

**问题**:D3 keystone 的结构化输出在 `action.agent.turn` 与 `ai.prompt` **v1** 已完整(JSON-Schema 校验 + 一次自动修复重试 + 接入 errorPolicy),但 **v2 路径丢了这半**:v2 只把 schema 注入 prompt、对返回**只做 `parseStructured` 不校验、不重试**;且 param 名是 `jsonSchema`,而共享 `AiPromptParams` 对外宣称的是 `outputSchema`/`onSchemaViolation` —— v2 静默丢弃后者。走 v2 的 `ai.classify`/`ai.extract` 一并继承此洞(extract 只做存在性 + 类型强转,非 JSON-Schema 校验,无自动修复)。新建节点默认 v1(见 W3.4),但一旦用户选 routed 模式/PII 门/streaming 就落到 v2,**失去校验**。

**证据**:

- `lib/workflow/nodes/ai/ai-prompt-v2.ts` · `AiPromptV2Params`:有 `responseFormat`/`jsonSchema`,**无 `outputSchema`/`onSchemaViolation`**;`finalize()` json 模式仅 `parseStructured(out.completion)` → `structured`,无 `validateAgainstJsonSchema`、无重试、无 `schemaValid`。
- v1 对照:`lib/workflow/nodes/actions/structured-turn.ts` · `runStructuredTurn`(校验 + 一次 auto-fix 重试)被 v1/agent.turn 复用。
- `ai.classify`/`ai.extract` 委托 v2(built-ins)。[AGENT]

**修法**:让 v2 json 模式复用 v1 的 `runStructuredTurn`(或直接调 `validateAgainstJsonSchema` + `summarizeZodError` + 一次 auto-fix 重试),消费 `outputSchema`/`onSchemaViolation`;统一 param 名(`jsonSchema` ↔ `outputSchema`,保留一个,另一个做兼容映射)。classify/extract 随之获得校验。

**验收**:verify: v2 json 模式带 outputSchema 时,不合规输出触发一次重试、仍不合规则按 onSchemaViolation 处理(fail 入 errorPolicy / soft 标 `schemaValid:false`)。补 `ai-prompt-v2.test.ts`。

### W3.2 · G7 · `flow.wait` event 模式是 no-op stub [MEDIUM] [CONFIRMED]

**问题**:`flow.wait` 的 `event` 模式直接返回 `{ skipped: "event mode not yet implemented" }`。按事件等待编排的工作流会**瞬间放行、无报错**,一个明显的静默半成品。

**证据**:`lib/workflow/nodes/built-ins.ts` · `flow.wait` executor:`if (mode !== "duration") return { output: { skipped: "event mode not yet implemented" } }`。

**修法**:用已存在的 `wake-bus`(现服务 resume)实现 event 等待:节点阻塞订阅 `${runId}:${stepId}` 或用户定义事件键,直到被唤醒或原超时预算到期。唤醒源接 Rust 触发守护(桌面)/companion。可先桌面落地,web 明确降级提示。落地后回看 W1.2-[OPEN Q3](是否恢复 flow.wait 作授权回边)。

**验收**:verify: `flow.wait(event, key)` 阻塞 → 外部发同键唤醒 → 继续;超时走超时。补测。**依赖**:与 W1.2 的授权回边决策联动。

### W3.3 · G6 · 表达式/条件只能读直接前驱 [MEDIUM] [CONFIRMED]

**问题**:`$node['id']` 只能引用**有直接边指向消费节点**的前驱;引用非相邻节点返回 `undefined`。这逼用户拉冗余透传边,且与 n8n 的全局 `$node[...]` 心智模型背离,限制了 branch 条件跨节点组合逻辑的能力。表达式语法也刻意极简(无算术/拼接/三元)。

**证据**:

- `lib/workflow/runtime/expression.ts` · `evalToken()`:`$node` → `scope.upstream[head.id]`。
- `lib/workflow/runtime/topo-sort.ts` · `upstreamOf()`:`edges.filter(e => e.target === nodeId).map(e => e.source)` —— 仅直接前驱进 `scope.upstream`。

**修法**(增强,非纯 bug):把 scope 扩为可读**所有已完成节点**输出 —— 编排器已持有 `stepOutputs: Map`,在构造 step scope 时额外暴露一个 `$nodes['id']`(全局,已完成才有值,未完成/未排序返回 undefined)。保留 `$node`(直接前驱)语义不破坏兼容。**[OPEN Q2]**:全局引用无边序保证,需文档明确"被引用节点须在拓扑上先于消费者(有路径),否则读到 undefined";或要求一条(可非数据)依赖边。

**验收**:verify: branch 条件引用一个非相邻但拓扑更早的已完成节点输出 → 读到值;引用未排序节点 → undefined 不崩。补 expression/orchestrator 测试。

### W3.4 · G9 · 新节点默认 v1(退化 loop / isTruthy 陷阱) [MEDIUM] [CONFIRMED]

**问题**:拖入新的 `flow.loop`/`flow.branch`/`flow.switch` 默认 `typeVersion: 1` —— 而 v1 loop **只产数组不跑循环体**、v1 branch 的 `isTruthy` 把 `"false"`/`"0"` 等任意非空串判真。用户默认拿到的是退化/带陷阱的版本。

**证据**:`components/workflow/editor/canvas.tsx`:`typeVersion: 1`(:517)、`node.data.typeVersion ?? 1`(:790)。v1 loop:`built-ins.ts` `flow.loop@1` 只返回 `{ iterations, items }`。v1 isTruthy:`built-ins.ts` `isTruthy` 非空串即真。

**修法**:新建 `flow.loop`/`flow.branch`/`flow.switch` 默认改为 `typeVersion: 2`(catalog 提供各 kind 的"最新版本"元数据,canvas 建节点时取之而非硬编码 1);保留 v1 executor 供既有图运行(不破坏兼容)。可在 palette 对 v1 标"legacy"。

**验收**:verify: 拖入新 branch/switch/loop → 创建为 v2;打开一张既有 v1 图 → 仍正常运行。补 canvas/catalog 测试。

---

## W4 — 低危 + 文档补位

### W4.1 · G10 · 子调用输入是裸 JSON 文本框 [MEDIUM] [AGENT]

**问题**:`flow.subworkflow` 输入在检查器是**裸 JSON 文本框**(`inputJson`),无 schema 驱动字段 / drag-to-map。运行期虽按目标 `interface.inputSchema` 校验,编辑期无类型化 affordance —— D3b/D5 的"可见契约、drag-to-map"体验缺失。**动手前先自行复核** `components/workflow/editor/inspector/forms/index.tsx` 的 subworkflow 表单。

**修法**:当目标工作流已发布且声明了 inputSchema,用检查器表单基建按 schema 生成类型化字段 + 上游输出 drag-to-map;未发布/无 schema 回退现有 JSON 文本框。

**验收**:verify: 选一个已发布带 inputSchema 的目标 → 检查器渲染类型化字段;选未发布目标 → 回退 JSON。

### W4.2 · G11 / G13 / G14 · 低危打磨 [LOW]

- **G13 [CONFIRMED]**:`data.transform` reduce 只 sum,易误当通用 fold。修:检查器对 reduce 明示"仅数值求和,通用折叠请用 `data.aggregate`",或直接把 transform.reduce 标 deprecated 指向 aggregate。
- **G11 [AGENT]**:`flow.split` 无 partition/copy;循环体内 `flow.join` 静默降级 all(忽略 race/any)。修:文档化 + 循环体内选 race/any 时给校验警告。
- **G14 [AGENT]**:`cognia-workflow-ai` 插件描述"Open a workflow editor to use them"低估了两条 agent 直跑路径。修:更新 `plugin.json` 描述 + i18n。

### W4.3 · 新增 ADR-0077 · 工作流可调用单元收敛 + 完成触发 [文档]

把 W1.1 + W2.1 + W2.2 的决策与最终形态固化为 ADR-0077(下一个空闲号,已核实 max=0076):记录 D5 三面收敛的真实落地形态、`trigger.workflow.completed` 的事件契约与防环规则。用 `subsystem-docs` 约定,bilingual(en/zh)。

### W4.4 · G15 · 更新 `lib/workflow/CONTEXT.md` [文档] [AGENT]

**问题**:CONTEXT.md 的 D3/D6②/D6③ 段仍把结构化输出 / ensemble / aggregate 描述为"未实现",并引 `agent-turn.ts:133` 为"free text only" —— 与现网代码矛盾(这三者均已 ship)。会误导后续开发者重复造轮子。

**修法**:把 D3/D6 段标注"已实现(见 W3.1 遗留 v2 缺口)",删掉过时的 `:133` 引用,指向本计划。**动手前复核**:亲手 read `agent-turn.ts` / `ai-ensemble.ts` / `data.aggregate` 确认 shipped(W3.1 已复核 agent.turn/v1)。

---

## 8. 待决策 [OPEN]

- **Q1(W1.3)** `maxConcurrency` 统一默认取 **1 还是 4**?作者倾向 4;涉及 legacy 无字段工作流的并行行为变更,需产品/兼容拍板。
- **Q2(W3.3)** 全局 `$nodes[]` 引用无边序保证 —— 采"best-effort + 文档警告"还是"要求一条依赖边"?
- **Q3(W1.2 / W3.2)** `flow.wait` 是否保留为授权回边?建议:W1.2 先移除(消除不循环陷阱),待 W3.2 event 模式落地后再评估是否需要"等事件再回边"的合法语义。
- **Q4(W1.1)** G1 修法取①(最小:正文指向通用 runner)还是②(完整:每工作流注册类型化工具,真交付 D5 表面①)?作者建议①先闭环,②列为 D5 完整化后续。

---

## 9. 执行顺序与门禁

**顺序**(尊重依赖):W1.1+W2.1 一起(联动闭环,必须同波验收)→ W1.3(一行级快赢)→ W1.2 → W2.2(feature)→ W3.* → W4.*。

**每项落地必须**(本仓硬规则):

- **co-located 测试**:改动 `lib/**`、`components/**`、`plugins/**` 的每个文件配 `*.test.ts(x)`;覆盖率 ≥90%(`pnpm test:coverage:changed -- --strict`)。
- **i18n 双语**:W2.2 新触发、W3.4/W4.2 的新文案 → en.json + zh-CN.json 同步,`pnpm lint:i18n` 过基线。
- **changeset**:用户可见项(G1/G3/G4/G7/G9)`pnpm changeset` 选 `cognia-next`;纯文档/测试(W4.3/W4.4/G15)跳过。
- **preflight**:提交前跑 `preflight` skill(test-gap / i18n / static-export / tauri-rust / pii-gate / wiring 六审)。
- **verify-before-done**:每项按其"验收"跑真流程(不只单测),贴输出。

**门禁基线注意**(见项目记忆):typecheck/lint 现绿(16384 heap + storybook-static ignore);i18n-sort / coverage:changed 有 pre-existing 红,只 gate 你自己的文件。
