# 目标管理面板（`/goal` 子系统）— 缺口修复与能力补齐计划

**日期**: 2026-07-17
**状态**: 待评审（未实施 —— 下文每一项都标了置信级别；凡 [CONFIRMED] 均为本会话亲手 read/grep 复核过，不是设想）
**范围**: `/goal` 子系统的**面板 + 运行时**全表面 —— 入口/挂载、`lib/goal/` 后端、连接器入站、UI 可发现性、i18n、文档漂移。**不含**：Agent Team 的 `goal` 任务字段（同名但无关，属 team-dispatch）、`/loop` 引擎内部（复用同一 runtime，归 loop 计划）。
**参考 ADR**: 0019（`/goal` 主 ADR）、0070（风险→ceremony，goal 已接 `risk-input.ts`）、0009/0025（平台连接器 / A2UI↔IM 桥，G1 复用）、0002/0079（scheduler，headless 驱动复用）

---

## 0. 如何使用本文档

每个工作项自成单元：**问题 → 证据 → 修法 → 验收**。除非标 **依赖**，否则彼此独立，一项一个 commit。

### 0.1 置信标签 —— 动手前先读这节

沿用 `2026-07-17-bot-connector-mechanism-remediation.md` / `2026-07-16-scheduler-subsystem-remediation.md` 的约定。**标签不是装饰。**

| 标签            | 含义                                                      | 动手前你必须做什么                 |
| --------------- | --------------------------------------------------------- | ---------------------------------- |
| **[CONFIRMED]** | 本文作者本会话亲手 read/grep 到 file:symbol（含阳性对照） | 可信，但**行号会漂，按符号重定位** |
| **[AGENT]**     | subagent 提供证据，作者未逐行复核                         | **动手前先自行复核这条具体主张**   |
| **[OPEN]**      | 真正未决，需人拍板                                        | **不要默默替它做决定**，见 §5      |

> 调研由三个 subagent 完成（UI 面板全貌 · `lib/goal/` 运行时后端 · 建成即休眠接线审计），三路交叉印证。随后作者对 **G1–G8 的全部承重 file:symbol 做了一手 read/grep 复核（含阳性对照）**；仅 G1 的「驱动模型」摆放属 [OPEN]。

### 0.2 证据标准（不可妥协）

凡「某调用/某门/某文案不存在」主张，均以引号包裹 `rg` + 阳性对照确认零才可信（`rtk grep` 不吃 stdin，会把 `-v` 当成对全仓的新搜索 —— 本次已踩坑，一律用 `rg -g '!*.test.*'`）：

```bash
# 阳性对照：同形状 grep 必须命中一个已知存在的符号，否则那个零无意义
rg -n "getGoalRuntime|handleTurnComplete" lib/connectors -g '!*.test.*'   # 预期 ZERO（连接器不驱动 goal）
rg -ln "getGoalRuntime" lib/goal hooks/chat -g '!*.test.*'                # 阳性对照：必须命中
```

---

## 1. 研究结论（先读这节，它推翻了「这面板是半成品」的默认假设）

第一直觉是「目标管理面板还停在 ADR-0019 的 Phase 1」。**事实相反：它已是一个成熟、全接线、全测试的子系统，远超 ADR 描述。**

- **入口齐全，无孤儿**：独立路由 `app/goals/page.tsx`（桌面 `GoalConsole` 六段 tab / 移动 `GoalsMobileBody`），已进导航目录 `types/shell/sidebar.ts:43`（`feature` 组，默认固定在 guild rail）；chat composer 挂了 `GoalStatusPill`（`components/chat/composer.tsx:1462`）；Settings→Goals 已注册（`settings-nav-config.ts:463`）。三路审计**未发现任何 built-but-unmounted 组件**。
- **`lib/goal/` 18 个模块全部 IMPLEMENTED 且有真实调用方**，无一 STUB。
- **ADR-0019 的 7 项 Future Work，6 项已完成**：静默续跑（`use-claude-chat.ts` `scheduleGoalContinuation` → `sendRef.current(msg,…,{skipUserAppend:true})`）、子目标分解（`subgoals.ts` + `subgoals-tab.tsx`）、judge 模型覆盖（`GoalConfig.judgeModel/Provider`）、workflow 触发（`completion-linkage.ts` 发 `trigger.goal.completed`）、cron 续跑（scheduler `goal` executor + `runGoalLoopHeadless`）、模板库（`seed-templates.ts` 4 内置 + CRUD）。子系统还额外长出 completion-promise 防伪完成门、acceptance 验收门、自适应 pacing、ADR-0070 风险门、`/loop` 互斥 —— 均已接线且有测试。

> **所以本计划不是「补功能」，而是「补一个真功能空洞 + 一组打磨」。**
> 一句话：**引擎是好的；唯一的功能空洞是「连接器入站目标」只做了守卫、没做入站路由（G1）；重启不自主续弦是个需拍板的契约问题（G2）；其余是 judge 模型选择器的可发现性/健壮性（G3/G4）、一处错因文案（G5）、和一批陈旧文档/死代码/孤儿 key（G6–G9）。**

---

## 2. 目标面板全景（「详细研究」的可复用交付物）

### 2.1 入口与挂载链（全部 [CONFIRMED] / [AGENT]）

| 表面                | 挂载点                                                                                        | 状态            |
| ------------------- | --------------------------------------------------------------------------------------------- | --------------- |
| `/goals` 控制台     | `app/goals/page.tsx` → `GoalConsole`（桌面）/ `GoalsMobileBody`（移动）；导航 `sidebar.ts:43` | WIRED           |
| 控制台六段 tab      | `goal-console.tsx:103-124`：overview / history / analytics / templates / defaults / tracker   | WIRED           |
| composer 状态 pill  | `components/chat/composer.tsx:1462` `<GoalStatusPill sessionId=…>`                            | WIRED           |
| 详情 Sheet（4 tab） | `goal-status-pill.tsx:147`、`history-table.tsx:223`、`active-goal-card`、mobile body          | WIRED           |
| 分析面板            | `goal-console.tsx:114`、`goals-mobile-body.tsx` `<GoalAnalyticsPanel goals=…>`（喂真数据）    | WIRED           |
| Settings→Goals      | `settings-nav-config.ts:463` 注册 → `settings-shell.tsx:527` `case "goals"`                   | WIRED           |
| `/goal` slash 命令  | `lib/slash-commands/builtin.ts:417` 注册 → composer picker → `dispatchGoalSubcommand`         | WIRED（仅桌面） |

### 2.2 `lib/goal/` 后端模块（全 IMPLEMENTED，节选承重件）

| 文件                           | 职责                                                                                            | 主要调用方                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `runtime.ts`                   | `GoalRuntime` 单例：create/pause/resume/stop/update/preempt、子目标、风险门、IM 守卫            | slash / chat hook / pill / plugin API / workflow / scheduler |
| `turn-driver.ts`               | 纯编排：持久化 delta → exits → promise 门 → judge → 子目标标记 → `commitExit`                   | `use-claude-chat.ts`、`goal-headless-runner.ts`              |
| `judge.ts` / `judge-client.ts` | 单次 judge LLM，strict-JSON、fail-OPEN；支持 `judgeModel/Provider` 覆盖                         | `turn-driver.ts` / chat hook / headless runner               |
| `pacing.ts`                    | 纯 `gateContinuation`：hold / defer / send（手动、静默时段复用 `isInQuietHours`、间隔、自适应） | `use-claude-chat.ts` `scheduleGoalContinuation`              |
| `completion-linkage.ts`        | 终态扇出：桌面通知 + `trigger.goal.completed` + scheduler `goal:completed` + 插件 hook          | `commitExit`、`stopGoal`、`preemptGoal`、`acceptance`        |
| `subgoals.ts`                  | `decomposeObjective`（LLM，fail-OPEN）、`markSubgoalsComplete`（单调）                          | `runtime.generateSubgoals`、`turn-driver.ts`                 |
| `redact-objective.ts`          | 用 `@cognia/redact` + twin 主密钥红隐 objective                                                 | `runtime.ts`                                                 |

### 2.3 无头驱动器（G1 的关键复用件）[CONFIRMED]

`lib/scheduler/executors/goal-headless-runner.ts:runGoalLoopHeadless` 已把「无 chat hook 时驱动整条 goal 循环」的原语做好：
`resolveSendOptions(activeGoal)` → `runAndCaptureAssistantReply` → `handleTurnComplete` → 按 outcome `continue/exit/aborted/stale` 循环，`handleTurnComplete` 自带 exit 边界，外加防御硬顶。

**但它的两个局限正是 G1 要补的接缝**（`goal-headless-runner.ts:57-189` 亲读确认）：

1. **无逐回合投递** —— 只把 `lastResponse` 存在本地并最终 return，**不把每回合 `capture.text` 投到任何地方**；连接器需要每回合投回 IM。
2. **不 gate pacing** —— `continue` 分支直接 `nextPrompt = outcome.userMessage` 立即下一轮，**从不调 `gateContinuation`**；IM 场景的静默时段/节流尤其需要它。

### 2.4 ADR-0019 Future-Work 现状矩阵（全 [AGENT] 交叉印证 + 承重项作者复核）

| Future-Work 项     | 状态                                 | 证据                                                                                  |
| ------------------ | ------------------------------------ | ------------------------------------------------------------------------------------- |
| 子目标分解         | **DONE**（按需，非建时自动）         | `subgoals.ts:47`、`runtime.ts:654`、`subgoals-tab.tsx:64`、judge `completedSubgoals`  |
| judge 模型覆盖     | **DONE**（但见 G3）                  | `runtime.ts:162`、`use-claude-chat.ts:~2869` `buildGoalJudgeClient({model,provider})` |
| workflow 触发      | **DONE**                             | `completion-linkage.ts` 发 `trigger.goal.completed`                                   |
| cron 续跑          | **DONE**                             | scheduler `goal` executor + `runGoalLoopHeadless`                                     |
| 模板库             | **DONE**                             | `seed-templates.ts`（4 内置）+ Templates tab CRUD                                     |
| 静默续跑接线       | **DONE**（ADR 的 stale「con」见 G9） | `use-claude-chat.ts` `scheduleGoalContinuation:~467`                                  |
| **连接器入站目标** | **PARTIAL / 仍 OPEN**                | 守卫 + inbox opt-in 有；`lib/connectors` 对 goal-runtime **零引用**（G1）             |

---

## 3. 缺口总表（G 系列；按波次/严重度排序）

| ID  | 缺口                                        | 类别        | 优先级 | 置信                                  |
| --- | ------------------------------------------- | ----------- | ------ | ------------------------------------- |
| G1  | 连接器入站目标：守卫已建、入站路由从未建    | 功能空洞    | **P0** | [CONFIRMED]                           |
| G2  | 应用重启不自主续弦 active 目标              | 契约缺口    | **P1** | [CONFIRMED]（缺失）/ [OPEN]（是否要） |
| G3  | judge 模型是自由文本、藏在 Defaults、无校验 | UX + 健壮性 | **P1** | [CONFIRMED]                           |
| G4  | Tracker 卡片「去自定义」是死胡同，无导航    | UX 可发现性 | P2     | [CONFIRMED]                           |
| G5  | 无 API key 时子目标报「可重试」错因         | 正确性      | P2     | [CONFIRMED]                           |
| G6  | detail-sheet docstring 陈旧 + 误引 ADR-0013 | 文档漂移    | P3     | [CONFIRMED]                           |
| G7  | 孤儿 i18n key `subgoals.body`（占位符文案） | i18n 卫生   | P3     | [CONFIRMED]                           |
| G8  | 死导出 `useActiveGoal`（仅注释引用）        | 死代码      | P3     | [CONFIRMED]                           |
| G9  | ADR-0019 本体陈旧（6 已完成项仍列待办）     | 文档        | P3     | [CONFIRMED]                           |

---

## Wave 1 — 功能空洞 / 契约（P0–P1）

### W1.1 · G1 · 连接器入站目标：守卫已建，入站路由从未建 **[P0] [CONFIRMED]**

**问题**：Telegram/Discord 等 IM 用户**无法**打 `/goal <objective>` 启动或驱动目标；即便某 IM 会话上已有目标，回合循环也**不转** —— 连接器 AI 回复链从不调 `handleTurnComplete`。守卫（opt-in）先于功能落地，成了「只拦不放」的半成品。

**证据**（本会话亲手 rg，含阳性对照）：

- `rg "getGoalRuntime|dispatchGoalSubcommand|handleTurnComplete|getActiveGoalForSession|createGoal" lib/connectors -g '!*.test.*'` → **ZERO**；阳性对照 `rg -ln getGoalRuntime lib/goal hooks/chat` 命中 `runtime.ts`/`use-claude-chat.ts`。
- `policy-eval.ts:54` 的 `slash-command` 分支只是 `text.startsWith(prefix)` **触发器匹配**，不是 `/goal` 派发器。
- 守卫已存在：`runtime.ts:78 GoalImBlocked` + `:337-362` 读 `ConversationOverrideRow.allowGoalDriving`，未开启即抛（v49）；opt-in UI `components/inbox/overrides/conversation-override-form.tsx` 已有；审计事件 `goal.blocked.im`/`goal.started.im` 已有；i18n namespace `goalBlockedIm` 已有。
- 复用件 `runGoalLoopHeadless`（§2.3）已能无头驱动整条循环，缺「逐回合投递 + pacing 门」。

**修法**（四段，均以**复用**为主，新增面很小）：

- **G1a 入站命令路由**：在连接器入站派发链的**控制命令短路层**（`routeInbound` 之前、复用现有 `controlCommands` 机制的同一处）新增 `/goal <sub> …` 识别，转调 `dispatchGoalSubcommand`（复用 slash action，7 子命令 + 3 别名全都有），`sessionId` = 该 IM 绑定会话，`provider/model` 取当前会话解析值。`create` 天然过 `allowGoalDriving` 守卫；被拦时把 `GoalImBlocked` 映射为本地化提示（复用 `goalBlockedIm`），并附一句「在 App 的 收件箱→会话覆盖 里开启目标驱动」。
- **G1b 驱动 + 逐回合投递**：给 `runGoalLoopHeadless` 增一个可选 `onTurn?(text, turnIndex, goal)` 回调（默认 no-op，**不改 scheduler 现有行为**）。连接器侧的驱动封装在 `onTurn` 里把 `capture.text` 经 **A2UI 桥**（`lib/connectors/a2ui-bridge/*` + `a2ui-mapper.ts` → `enqueueOutbound`）投回连接器；首回合发 `safeObjective`（红隐后文本，不泄原始 PII —— runner 已如此）。驱动器由**连接器运行时**（Tauri desktop / CLI serve）持有，与 bot 生命周期同域。
- **G1c pacing 门**：在 runner 的 `continue` 分支前插 `gateContinuation`（`pacing.ts`，已复用 `isInQuietHours`）—— `hold`/`defer` 时挂起或延时再投。**这条同时修好 headless runner 对 scheduled 目标也不 gate 的既有小缺陷**（§2.3 局限 2）。
- **G1d 控制子命令 over IM**：pause/resume/stop/status/show 经 G1a 路由 → `dispatchGoalSubcommand` 已支持 → 文本结果经 G1b 投回。

**[OPEN] O1（驱动模型，见 §5）**：无头驱动（推荐，复用 `runGoalLoopHeadless`）vs 桌面驱动。注意 **Capacitor 移动壳没有连接器运行时**（`lib/headless/runtimes/index.ts` 仅被 `cli/src/serve` import）—— 故 IM 目标只在「桌面 Tauri / CLI serve」跑，移动端不支持（可接受，需在 UI 标注）。

**验收**：

- 单测：模拟 IM inbound `/goal <obj>` → 未 opt-in 时断言抛 `GoalImBlocked` 且投回本地化提示、不建目标；opt-in 后断言 `createGoal` 成功 + `goal.started.im` 审计。
- 集成：驱动一个短目标（maxTurns=2）→ 断言每回合有一次 `enqueueOutbound` 投递、静默时段内 `gateContinuation` 返回 hold/defer、终态发 `completion-linkage` 扇出。
- `pnpm test:coverage:changed -- --strict` ≥90%；新增用户可见行为 → `pnpm changeset`（minor）。

---

### W1.2 · G2 · 应用重启后不自主续弦 active 目标 **[P1] [CONFIRMED 缺失] / [OPEN 是否要]**

**问题**：应用中途关闭，前台目标停在 `status="active"` 但**空转**，直到用户重新进入该会话并完成一次 turn 才复活。没有启动时的 re-arm 扫描。

**证据**：`rg "scheduleGoalContinuation" hooks lib components -g '!*.test.*'` → 仅 `use-claude-chat.ts:445` 定义、`:486` 自身 defer 递归、`:2971` turn-complete 触发；`rg "resumeActiveGoal|resumeOnBoot|reviveGoal|hydrateGoal|rearmGoal"` → **ZERO**。`getActiveGoalForSession` 有多个调用方，但全是**按需读**（chat hook / plugin API / workflow / companion），无 boot 扫描。

**修法**（**仅当 O2 判定「要」**）：在会话加载 effect（或一个 provider 级 boot 扫描）里，对 `status="active"` 且上一回合已收尾的目标调一次 `scheduleGoalContinuation` 续弦。**必须幂等** —— 多窗口/多会话去重，且与无头/scheduler 驱动互斥（避免同一目标被双驱动）。

**[OPEN] O2（见 §5）**：「会话级前台续跑」是否本就是产品契约？

- 若**是** → 这是 dormancy-by-design：按 Working Rule 7 在类型注释标注 + UI 明示「关闭 App 后目标暂停」+ 测试锁定，即闭环，不写 boot-resume。
- 若**否** → 实现上面的 boot re-arm。

**验收**（若实现）：单测模拟 reload → 断言 active 目标被重新续弦**恰好一次**（幂等），paused/terminal 目标不被触碰。

---

## Wave 2 — judge 模型可发现性 / 健壮性（P1–P2）

### W2.1 · G3 · judge 模型是自由文本、藏在 Defaults、打错字静默降级 **[P1] [CONFIRMED]**

**问题**：judge 模型覆盖**已端到端打通**，但控件是 **Defaults tab 里的自由文本 `<Input>`**（不在直觉指向的 Settings→Goals→**Tracker**），且模型/provider 打错字被 `buildGoalJudgeClient` 的 `null` 回退**静默降级**回默认 provider，无校验、无提示。

**证据**：`goal-defaults-form.tsx:160-164` `<Input … judgeModel>`、`:170-174` `<Input … judgeProvider>`（非 `<Select>`）；`tracker-config.tsx` 全文只读，无编辑面。

**修法**：

- 把 `judgeModel`/`judgeProvider` 换成**模型选择器**。**[OPEN] O3-a 复用探查**：先 `rg` 有无现成 `ProviderModelSelect`/`ModelPicker`（provider 设置页大概率有），有则复用，无则最小自建。空值 = 继承主模型（保持现默认语义）。
- 选了 provider 但 model 不在其目录 → **内联校验提示**，杜绝静默 null 回退。
- **[OPEN] O3-b 摆放**：推荐 judge 选择器仍留 Defaults（全局默认合理），并在 Tracker 卡片加一句带跳转的说明（与 G4 合并）；或整体移到 Tracker。二选一需拍板。

**验收**：单测 —— 选无效 provider→有校验提示且不落 config；选有效 model→draft 落 `config.judgeModel` 且 `buildGoalJudgeClient` 收到该值。i18n 双语 key + `pnpm lint:i18n`。

---

### W2.2 · G4 · Tracker 卡片「去自定义」是死胡同 **[P2] [CONFIRMED]**

**问题**：`tracker-config.tsx:61` 只渲染一行 `<p>{t("tracker.customise")}</p>` 提示「去 Settings→Characters 编辑 judge 角色」，docstring 却声称「this card just links there」——**实际无任何 Link/Button/onClick**。用户被指去别处，却无一键入口。

**证据**：`rg "Link|useRouter|href|onClick|<Button" components/settings/goals/goal-tracker-config.tsx` → 仅 `:61` 的静态 `<p>`。

**修法**：加一个 `Button`/`Link` → 路由到 Settings→Characters 并定位 `char_builtin_goal_tracker`。

**验收**：单测点击断言 `router.push` 到 characters 路由并带该 characterId。

---

### W2.3 · G5 · 无 API key 时子目标报「可重试」错因 **[P2] [CONFIRMED]**

**问题**：`subgoals-tab.tsx` `generate()` 中 `buildRendererLlmClient` 返 `null`（无可解析 key）时 `setError(true)` 走通用可重试文案 `subgoals.error`（"再试一次"）——但重试永不成功。准确文案 `subgoals.unavailable`（"需要一个带 API key 的模型"）**两语言包都有，却零代码引用**。错因误导 + 孤儿正确文案。

**证据**：`subgoals-tab.tsx:~58-62` `if (!client) { setError(true); return }`；`en/goal.json:288 "unavailable"` 存在，`rg "subgoals.unavailable" components/goal/tabs/subgoals-tab.tsx` → ZERO。

**修法**：区分两态 —— `!client` → 新增 `setUnavailable(true)` 渲染 `subgoals.unavailable`（非可重试）；空清单/异常 → 保留 `setError(true)`（可重试）。

**验收**：单测 —— mock `buildRendererLlmClient` 返 null 时渲染 `unavailable` 文案而非 `error`。

---

## Wave 3 — 文档 / 死代码卫生（P3；量小但会误导下一个审计者）

### W3.1 · G6 · detail-sheet docstring 陈旧 + 误引 ADR **[P3] [CONFIRMED]**

`goal-detail-sheet.tsx:4` 把 `/goal` 误引为 **ADR-0013**（应为 **0019**）；`:5` 仍写 `Subgoals — Phase 2 placeholder`，而该 tab 早已是完整的 LLM 分解 + 清单交互面。→ 修 docstring：ADR-0019 + Subgoals 描述为「LLM 分解 + 可勾选清单」。

### W3.2 · G7 · 孤儿 i18n key `subgoals.body` **[P3] [CONFIRMED]**

`i18n/messages/{en,zh-CN}/goal.json` 均有 `subgoals.body`（"deferred to a later release…" 占位符文案），零代码引用，与已上线功能矛盾。→ 删两侧 key，跑 `pnpm lint:i18n`（如触碰 baseline 则 `pnpm lint:i18n:baseline`）。

### W3.3 · G8 · 死导出 `useActiveGoal` **[P3] [CONFIRMED]**

`components/goal/use-active-goal.ts` 导出 `useActiveGoal`，运行时零引用（仅 `build-options.ts:465` 与自身 docstring 的**注释文字**提到它）；live 的是 `useOpenGoal`（`goal-status-pill.tsx` 在用）。→ 删 `useActiveGoal` 导出，更新 `build-options.ts:465` 注释指向 `useOpenGoal`。**动手前重跑 grep 复核零运行时引用**（rtk 会把两个 hook 名都掩成同一 token，务必用 `rg` 原名）。

### W3.4 · G9 · ADR-0019 本体陈旧 **[P3] [CONFIRMED]** —— 最该做的文档修

`0019-goal-command.md:116` 的「Cons」仍称静默续跑 "is not yet implemented … only **logs** the outcome"；`:136` 的「Future Work」把 6 个已完成项列为待办。审计者/新读者按这份 ADR 会误判子系统。→ 更新 ADR：把 subgoal / judge-override / workflow-trigger / cron / template / silent-send 标 **DONE（附交付 commit/文件）**，Future Work 只留 **connector-inbound（partial，指向本计划 G1）** + 可选 boot-resume（G2）；删除 Cons 段 stale 的 "log only" 句。

---

## 4. 建议顺序与依赖

```
Wave 1 (功能/契约)      Wave 2 (judge UX)         Wave 3 (卫生)
  G1  [需先定 O1] ──┐     G3 [需先定 O3a/O3b]        G6
  G2  [需先定 O2]   │     G4 ──(可与 G3 合并跳转)     G7
                    │     G5                          G8
                    └───────────────────────────────►G9 (依赖全部落地后回填 ADR)
```

- **G1 依赖 O1**（驱动模型）；其 G1c 顺手修 headless runner 的 pacing 缺陷。
- **G2 依赖 O2**（契约拍板）—— 若判「设计如此」，退化为一条注释+测试，成本近零。
- **G3 依赖 O3a**（复用探查 ModelPicker）+ **O3b**（摆放）。
- **G9 最后做**，回填前面各项的实际交付证据。
- G4/G5/G6/G7/G8 相互独立，可并行，各一个 commit。

## 5. 待决策（[OPEN]，不要默默替它做决定）

| 编号 | 决策                                                                  | 作者推荐                                                                             |
| ---- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| O1   | 连接器入站目标的**驱动模型**：无头驱动 vs 桌面驱动                    | **无头驱动**（复用 `runGoalLoopHeadless` + `onTurn` 投递）；移动端不支持并在 UI 标注 |
| O2   | 「关闭 App 后前台目标暂停」是否既定**契约**？                         | 需你拍板。若是 → G2 退化为注释+测试；若否 → 实现幂等 boot re-arm                     |
| O3a  | judge 模型选择器是否有现成 `ProviderModelSelect`/`ModelPicker` 可复用 | 动手前 `rg` 探查，优先复用                                                           |
| O3b  | judge 选择器摆放：留 Defaults（+Tracker 跳转说明）还是移到 Tracker    | **留 Defaults + Tracker 加跳转**                                                     |

## 6. 验证命令

```bash
# TS / 测试（改动集）
pnpm typecheck
pnpm test:changed
pnpm test:coverage:changed -- --strict     # 门槛 90%，只 gate 你改的文件
pnpm lint
pnpm lint:i18n                             # G3/G5/G7 触碰 i18n 后必跑

# 每个用户可见行为项收尾
pnpm changeset                             # cognia-next；G1=minor，G3/G4/G5=patch，G6-G9 可跳过（内部/文档）
```

> Rust 不涉及（本计划全部落在 TS/TSX + i18n + 文档）。G1 的连接器运行时代码若触及 `cli/src/serve`，另跑该包的 node 测试。
