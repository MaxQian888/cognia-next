---
title: "ADR-0026：内置技能层 + lark-cli 桥接"
description: "代码审查通过的第一方 MCP 工具，包装 lark-cli，并打通 A2UI ⇄ 技能的 HITL 双向流程"
---

# ADR-0026：内置技能层 + lark-cli 桥接

- **状态**：已通过
- **日期**：2026-05-19
- **Schema 升级**：v42 → v43（`connectorCallbackBindings.payload?` + `"skill_invoke"` kind、`conversationOverrides.allowedBuiltInSkillIds` + `requireHitlForWrites`、`adapterInstances.lastKnownSkillCapabilities?`）
- **取代**：无 — 在 ADR-0009 / ADR-0025 之上叠加

## 背景

A2UI ⇄ IM 桥接（ADR-0025）解决了消息层，但 Lark 适配器仅覆盖 IM。
助手能读写飞书消息，却接触不到飞书企业套件——日历、文档、多维表格、
电子表格、任务、知识库——这些恰是 lark-cli 已经覆盖的高价值生产力域。

可安装的 Skills（`character.skillIds`）仅作提示注入，并不适合 shell 出
lark-cli。把 lark-cli 接入插件加载器又会污染信任模型。

我们需要一个独立的、**代码审查通过的内置技能层**：

1. 把每个 lark-cli 子命令包装为强类型 MCP 工具，助手可直接调用。
2. 复用现有 Lark 适配器 OAuth（`lib/connectors/adapters/lark/auth.ts`），
   用户无需单独跑 `lark-cli config init` / `auth login`。
3. 在 IM 渠道中执行清晰的信任分级：read 自动执行，write 弹出 A2UI 确认卡，
   destructive 需要按会话显式 opt-in。

## 决策

### 双轨并行

**Track A — 内置技能层 + lark-cli 桌面侧执行。** 每个 lark-cli 子命令
通过强类型 MCP 工具暴露。执行发生在桌面 sidecar：通过 `execFile` 调用
npm 安装的 `lark-cli` 二进制，并把 Lark 适配器存储的 OAuth 凭证以环境
变量形式注入。移动端通过现有 V2 server-client 通路触发，但执行始终在
桌面侧。

**Track B — A2UI Dialog/Modal 能力填齐。** 纯适配器代码：把 Lark Card
v2 的 `form_dialog` 与原生 Checkbox、Slack `views.open`、Discord
`interaction.showModal` 接入到现有 A2UI capability matrix。独立于
Track A。

### 内置技能注册表

```
interface BuiltInSkill {
  id          // "lark.calendar.list_events"
  family      // "lark.calendar"
  label, description: BilingualString
  platforms   // PlatformKind[] | "any"
  mutation    // "read" | "write" | "destructive"
  imAccess    // "always" | "readonly" | "opt-in" | "blocked"
  mcpToolName // "lark_calendar_list_events"
  inputSchema: ZodTypeAny
  execute(args, ctx): Promise<unknown>
  hitlSurface?(args): A2UISegmentContent  // write/destructive 必须提供
}
```

每个技能在模块加载时通过 `registerBuiltInSkill()` 自注册。共享注册表
提供 `listByPlatform()`、`listByMutation()`、`families()`。
`lib/skills/built-in/index.ts` 触发所有家族的副作用 import。

### 信任模型

按 `mutation` 分级：

| 等级            | 默认 `imAccess` | HITL                         |
| --------------- | --------------- | ---------------------------- |
| `"read"`        | `"always"`      | 不需要——只走 PII 闸门 + 审计 |
| `"write"`       | `"always"`      | 默认弹出 A2UI 确认卡         |
| `"destructive"` | `"opt-in"`      | 始终弹出 A2UI 确认卡         |

按会话的覆盖：

- `ConversationOverrideRow.allowedBuiltInSkillIds: string[] | "all" | undefined`：
  `undefined`/`"all"` 沿用每个技能的默认 `imAccess`；`[]` 屏蔽全部；
  显式列表（支持 `family.*` 通配符）约束该会话可调用范围。
- `ConversationOverrideRow.requireHitlForWrites: boolean`：默认 `true`；
  受信内部群可设为 `false` 跳过 write 类的确认卡。destructive 级别忽略
  此开关，始终 HITL。

### Dispatcher 流水线

`runBuiltInSkill(skillId, args, ctx)` 顺序执行：

1. 注册表查找 — 找不到时返回 `unknown_skill` 拒绝。
2. Zod schema 校验 — 失败返回 `invalid_args`。
3. PII 闸门 `hasNoLeakingPii`（与 Twin/Goal 共享）— 命中返回 `pii_blocked`。
4. 会话白名单 — 不通过返回 `not_allowed_for_channel`。
5. `imAccess` 检查 — `destructive_opt_in_required` /
   `readonly_requires_channel_curation` / `skill_blocked_in_im` 拒绝。
6. 按 mutation 分级 HITL 路由：
   - read / write+`requireHitlForWrites=false` / `hitlBypass=true`：立即执行
   - write / destructive：渲染 `skill.hitlSurface(args)`，写入
     `connectorCallbackBindings` 行（`kind: "skill_invoke"`，
     `payload: {skillId, args}`），返回 `pending_hitl`

每个闸门都会写入 `connectorAudit` 行，使用新增的审计类型
（`builtin_skill_invoked` / `_denied` / `_hitl_pending` / `_hitl_approved`
/ `_hitl_rejected` / `_failed`）。PII 在写审计前先做脱敏。

### A2UI ⇄ 技能双向流程

用户在 A2UI 卡片点击 Confirm。适配器 parser 把平台 payload 规范化为
`ConnectorCallbackEvent` 交给 `ConnectorBus.dispatchConnectorCallback`。
Bus：

1. 按 `triggerId`（namespace `"callback"`）去重。
2. 调用 `resolveCallbackBinding(adapterId, actionId)` 查找绑定。
3. 检测到 `binding.kind === "skill_invoke"`，跳过标准 digest-turn 路径。
4. 读出 `binding.payload.{skillId, args}`，调用
   `runBuiltInSkill(skillId, args, { hitlBypass: true })` 再次执行。

Cancel 点击则记录 `builtin_skill_hitl_rejected` 并返回。

### Sidecar 暴露

内置技能 manifest 折叠进现有的 `opts.pluginTools` 流。Sidecar 的
`plugin-tools.mjs` 据此构建一个合成 `cognia-plugin-tools` MCP server，
并通过 `plugin_tool_exec` IPC 把调用代理回 renderer。
`lib/claude/plugin-tool-ipc.ts:handlePluginToolExec` 在 plugin 注册表未
命中时回落到内置技能注册表（按 `mcpToolName` 查找），统一走同一个
IPC 通道，无需新增并行链路。

### lark-cli 执行

`lib/skills/built-in/lark/exec-lark-cli.ts` 包装 `execFile`：

- 二进制定位：`LARK_CLI_BIN` 环境变量 → PATH 查找 → Windows
  `%APPDATA%\npm\lark-cli.cmd` 兜底。
- 上限：5 分钟超时（可调）、1 MB stdout 上限、`windowsHide: true`。
- 通过 `auth-bridge.ts` 注入鉴权环境变量：从 Lark 适配器存储的 OAuth
  令牌生成 `LARK_APP_ID`、`LARK_APP_SECRET`、`LARK_USER_ACCESS_TOKEN`
  （或 `LARK_TENANT_ACCESS_TOKEN`）。
- 缺失 `--as` 时自动前置 `--as user|bot`。
- HITL 再触发时 dispatcher 传 `confirmed: true`，自动追加 `--yes`，
  满足 lark-cli 自己的确认闸门。
- 退出码 10 被翻译为结构化的 `hitl_required`。

### 每会话 capability prompt

`buildCapabilityPromptSection(platform, matrix, skillCapabilities?)`
新增第四条 bullet：

> 本会话可用的内置技能：lark.calendar (read+write)、lark.doc
> (read+write+destructive) …… write/destructive 操作默认通过 A2UI
> 确认卡路由。

`AdapterInstanceRow.lastKnownSkillCapabilities` 在适配器启动时缓存
每家族的 mutation 集合，热发送路径无需每次遍历注册表。

## 影响

### 正面

- 飞书企业全套件（日历/文档/电子表格/多维表格/任务/知识库）成为助手可
  调用对象，无需重写 OAuth 或上传管道。
- 信任模型按技能 + 按会话明确分级，每一步都有审计。
- A2UI 确认卡复用现有基础设施（`connectorCallbackBindings`、
  `dispatchConnectorCallback`、`recordCallbackBinding`），无新持久层。

### 负面

- 桌面侧必须安装 lark-cli。auth bridge 在未安装时给出明确错误。
- 移动端经 V2 server 中转（按 ADR-0014），无法独立运行技能。v1 可接受。
- `pluginTools` manifest 在 Lark v1 携带最多 40+ 条目，系统提示词
  context 预算变大。通过 IM 的 `allowedBuiltInSkillIds` 过滤以及桌面端
  的 `character.enableBuiltInSkills` opt-in 缓解。

### 不在 v1 范围内

- 其余 Lark 家族：`mail`、`drive`、`slides`、`vc`、`minutes`、
  `whiteboard`、`approval`、`attendance`、`contact`、`event`、`okr`。
- 原生 Lark Node SDK 接入（仅在 lark-cli 不够用时再考虑）。
- 在 cognia UI 中驱动 `lark-cli config init` / `auth login`。
- Lark 之外的跨平台 skill 家族（Slack canvas、Discord forums、
  Telegram mini-apps）。

## 分层

| 层                | 模块 / 文件                                                        |
| ----------------- | ------------------------------------------------------------------ |
| 技能契约          | `lib/skills/built-in/types.ts`                                     |
| 注册表            | `lib/skills/built-in/registry.ts`                                  |
| Dispatcher        | `lib/skills/built-in/dispatcher.ts`                                |
| Manifest          | `lib/skills/built-in/manifest.ts`                                  |
| Lark exec         | `lib/skills/built-in/lark/exec-lark-cli.ts`                        |
| Auth bridge       | `lib/skills/built-in/lark/auth-bridge.ts`                          |
| Lark 家族         | `lib/skills/built-in/lark/{calendar,doc,sheets,base,task,wiki}.ts` |
| Bus 集成          | `lib/connectors/bus.ts`（skill_invoke 分支）                       |
| Sidecar 桥接      | `lib/claude/plugin-tool-ipc.ts`（内置技能 fallback）               |
| Build-options     | `lib/claude/build-options.ts:resolveSendOptions`                   |
| Capability prompt | `lib/connectors/a2ui-bridge/capability-evaluator.ts`               |
| Settings UI       | `components/settings/built-in-skills/`                             |
| Slash command     | `lib/slash-commands/actions/lark.ts`                               |
| Schema            | `lib/db/schema.ts`（v43）、`lib/db/connector-types.ts`             |
| Audit             | `types/connectors/audit.ts`（6 个新 kind）                         |
