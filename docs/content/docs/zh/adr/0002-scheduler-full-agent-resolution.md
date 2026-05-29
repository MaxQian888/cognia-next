---
title: ADR-0002 — 调度器完整 agent + 工具解析
description: 让定时任务与交互式聊天对齐——完整的 character / agent-mode / skill / MCP / 内置工具 / 权限模式解析，外加一个带类型的结构化编辑器，以及对旧 payload 字段名的向后兼容。
---

# 调度器完整 agent + 工具解析

| 状态    | 已接受                                                                                                                                                          |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 日期    | 2026-05-01                                                                                                                                                       |
| 涉及    | `lib/scheduler/`、`types/scheduler/`、`components/scheduler/`、`lib/claude/build-options.ts`、`i18n/messages/{en,zh-CN}.json`、`docs/content/docs/adr/0002-*.md` |

## 背景

`lib/scheduler/` 中的调度器在触发、持久化、重试、leader 选举、通知和
OS 级提权方面已经功能完备。但调度器与 Claude/agent 运行时之间的连接很
浅：定时的 `chat` / `agent` / `skill` 任务直接调用
`sendPrompt(sessionId, prompt)`，**没有**经过
`resolveSendOptions()`（`lib/claude/build-options.ts`）。这意味着定时
执行绕过了交互式聊天所应用的每一个开关：

- character 的 system prompt / model / allowed-tools / disallowed-tools / MCP 子集
- 挂载的 skills（system-prompt 段落 + `recordSkillUsage`）
- 激活的 **agent mode**（内置或自定义——system prompt + 工具并集 + model 覆盖）
- A2UI bridge 工具 + A2UI system-prompt 扩展
- 五个 **`builtinTools`** sidecar 开关（file extras / git / process / environment / shell-advanced）
- `permissionMode`、`additionalDirectories`、MCP 白名单优先级、SDK resume 连续性

还有两个正确性 bug 阻塞了辅助函数路径：

1. **字段名不匹配。** `conversational-task-authoring.ts` 写入
   `payload.message`（chat）和 `payload.agentTask`（agent）；而执行器
   读取的是 `payload.prompt`。任何通过辅助函数创建的任务在首次运行时
   都会失败。
2. **辅助函数没有绑定 characterId。** `createScheduledAgentTaskDraft`
   从不把 `characterId` 串进 payload，但 `executeAgentTask` 需要它。

TaskForm 只为 payload 暴露了一个自由格式的 JSON 文本框。没有 character /
skill / mode / tool / MCP 选择器——而且外部 ACP agent（Claude Desktop、
Cursor、Codex、Gemini……）根本无法被定时调度，尽管
`lib/ai/agent/external/manager.ts:executeOnExternalAgent` 早已在仓库里。

## 决策

### 1. 复用交互式解析管线

调度器执行器现在走与交互式编辑器相同的 `resolveSendOptions`，再加上一个
覆盖分层步骤，镜像 `hooks/chat/use-claude-chat.ts:111-140` 中的合并契约。

每个 chat 风格的回合流程（`lib/scheduler/executors/index.ts` 中的
`runChatPrompt`）：

1. 查找/创建会话（设置了 `payload.teamId` 时为 `kind: "team"`，否则为
   `"direct"`）。
2. `await getSettings()` 拾取 `AppSettings.builtinTools` + 默认值。
3. 将 `payload.agentModeId` 先对内置注册表、再对自定义 mode store 解析
   出激活的 agent mode。`null` 表示不启用。
4. 把 `payload.disabledSkillIds` 拼到一个合成的
   `session.disabledSkillIds` 上，让 `resolveSendOptions` 遵循它们。
5. 调用 `resolveSendOptions({ session, appSettings, agentMode })`。
6. 分层叠加 payload 级覆盖：
   - `model`、`permissionMode`、`maxTurns`、`effort` → 赋值
   - `appendSystemPrompt` → 若已有值则拼接
   - `allowedTools`、`additionalDirectories` → 与解析值取**并集**
   - `disallowedTools` → 赋值
   - `mcpServerIds` → 解析为 server map（空数组表示「无 MCP」）
   - `builtinTools` → 浅合并覆盖到 `appSettings.builtinTools` 之上
7. 对 `skill` 任务：取临时 skill 的 `allowedTools` 并集，并把其 prompt
   段落拼到 `systemPrompt` 上。
8. `await sendPrompt(sessionId, prompt, finalOptions)`——同样的 IPC，
   现在带上合并后的选项。

既有的 `onClaudeMessage` 事件收集器 + 超时竞速保持不变。

### 2. 新增 `external-agent` 任务类型

新增 `executeExternalAgentTask`，注册给新的 `"external-agent"` 任务
类型，调用
`executeOnExternalAgent(prompt, { agentId, permissionMode, workingDirectory, timeout })`。
当 `payload.timeoutMs` 缺失时回退到 `task.config.timeout`。

### 3. 带类型的 payload 联合

`types/scheduler/index.ts` 现在导出一个可辨识的 payload 联合：

```ts
export type ScheduledTaskPayload =
  | Record<string, unknown>
  | BackupTaskPayload
  | ChatLikeTaskPayload
  | AgentTaskPayload
  | SkillTaskPayload
  | ExternalAgentTaskPayload
```

`ChatLikeTaskPayload` 镜像 `resolveSendOptions` 接受的每一个开关，因此
下游 UI 可以预填结构化表单，而无需复制粘贴字段声明。`AgentTaskPayload`
新增 `characterId`；`SkillTaskPayload` 新增 `skillId`；
`ExternalAgentTaskPayload` 有自己的形态，带 `agentId` /
`permissionMode` / `cwd` / `timeoutMs`。

### 4. 结构化 payload 编辑器

`components/scheduler/payload-editors/` 为 chat / agent / skill /
external-agent 任务类型引入了结构化表单模式：

- `chat-payload-editor.tsx` —— prompt + character / skill / mode / model /
  effort / max-turns / team / session 选择器
- `external-agent-payload-editor.tsx` —— agent 选择器（来源于
  `getExternalAgentManager().getAllAgents()`，带自由文本回退）
- `tool-picker.tsx` —— 内置工具勾选清单 + 自定义名称列表
- `mcp-picker.tsx` —— 多选，附带一个「使用 character/team 默认」单选项，
  使「未设置」与「空数组」有意义地区分开
- `builtin-tools-toggles.tsx` —— 每个开关的三态选择器
  （`use-default` / `force-on` / `force-off`）
- `permission-mode-select.tsx` —— SDK 与 ACP 两种风味
- `additional-directories-list.tsx` —— 增删行，带 Tauri 文件夹选择器

`task-form.tsx` 暴露一个编辑器模式切换（「使用结构化编辑器」↔
「以 JSON 编辑」），二者无损往返。64 KB 的 payload 大小上限和既有的
JSON 校验作为回退被保留。

### 5. 旧 payload 字段的向后兼容

执行器新增了一个一次性调和器（`reconcileLegacyPromptFields`），它惰性
地把 `payload.message` → `payload.prompt`（chat）和
`payload.agentTask` → `payload.prompt`（agent）重写，并把嵌套的
`config.{model, maxSteps}` 提升到顶层 `model` / `maxTurns`。每个任务 id
触发一次 `loggers.scheduler.warn`，让遗留项被暴露而不刷屏。
`normalizeConversationalTaskPayload` 在辅助函数路径上做同样的事。

### 6. 新的对话式辅助函数

`createScheduledChatTaskDraft`、`createScheduledAgentTaskDraft`、
`createScheduledSkillTaskDraft` 和
`createScheduledExternalAgentTaskDraft` 都生成新的带类型 payload 形态。
agent 辅助函数现在可选地接受 `characterId`（意图分类流程可以产出一份
部分草稿，让用户在表单里补全；执行器在运行时仍要求该字段）。

## 迁移

- **既有 chat 任务**（IndexedDB 中以 `payload.message` 存储）继续运行
  ——`reconcileLegacyPromptFields` 会在下次运行时重写它们，并按 id 警告
  一次。
- **既有 agent 任务**（缺少 `characterId`）现在会在运行时以明确错误
  `agent task requires characterId in payload` 失败。用户可以在新的结构化
  表单里编辑任务来选定一个 character。
- **外部 agent 任务**是全新的；没有需要迁移的东西。

## 验证

1. `pnpm install`，然后 `pnpm tauri dev`。
2. 配置一个带非平凡 system prompt + 若干 MCP server + 一个 skill 的
   character。保存。
3. 打开 `/scheduler` → New Task → 选择「Agent」→ 选那个 character + 一个
   agent mode + 调整 permission mode + 切换若干内置工具 →
   触发器：`interval: 60000ms`。
4. 等 ~60s，在 DevTools / 执行历史中验证出站的 `claude_send` invoke 显示
   合并后的 `SendOptions`：带 character + mode + skill 段落的 system
   prompt；包含 character + mode + skill + bridge 集合的 `allowedTools`；
   正确取子集的 `mcpServers`；应用的 `builtinTools` 开关；已设置的
   `permissionMode`。
5. 用任务类型「External agent」指向一个已配置的 ACP agent（如 Claude
   Desktop）重复一遍 → `executeOnExternalAgent` 被调用，执行行显示结果。
6. 通过 `createScheduledChatTaskDraft({ message: "..." })`（旧字段名）
   创建一个任务并确认：它成功运行；触发一次 `scheduler` warn-log；任务
   在迁移后继续工作。
7. `pnpm typecheck`、`pnpm lint`，以及
   `pnpm test --testPathPatterns="lib/scheduler|components/scheduler/payload-editors|types/scheduler"`
   全部通过。

## 范围之外

- TaskForm 中可选的按团队成员覆盖（team-router 在消息分发时应用按成员
  解析；v1 只选 `teamId`）。
- 「立即运行」按钮——调度器 store 已通过 `runTaskNow` 支持；在表单中
  暴露它是一个独立的 UX 事项。
- 远程 / 云端调度（CronCreate 风格）。
- 完整的按任务 A2UI 覆盖——`session.a2uiEnabled` 已被
  `resolveSendOptions` 遵循，因此暂时无需在 TaskForm 中暴露任何东西。
