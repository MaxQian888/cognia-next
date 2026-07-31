/**
 * Localized text builders for in-chat control-command replies.
 *
 * Connector outbound text has no next-intl server context (the bus runs
 * headless in the webview), so — exactly like `help/build-help-surface.ts` —
 * this module hardcodes concise bilingual (zh / en) strings rather than
 * pulling from `i18n/messages`. Keeps confirmations identical across every
 * adapter regardless of A2UI capability (all replies are plain text).
 */

import type { ControlCommandName } from "./parse"

/** A control command and its one-line bilingual description, for `/help`. */
const COMMAND_HELP: Array<{ name: ControlCommandName; usage: string; desc: string }> = [
  { name: "commands", usage: "/commands", desc: "显示此命令列表 / show this list" },
  { name: "status", usage: "/status", desc: "查看当前会话设置 / show current settings" },
  { name: "sessions", usage: "/sessions", desc: "列出本会话的所有子会话 / list sessions" },
  { name: "new", usage: "/new", desc: "新建并切换到新会话 / start a new session" },
  { name: "switch", usage: "/switch <id|标题>", desc: "切换到指定会话 / switch session" },
  { name: "model", usage: "/model <名称>", desc: "切换模型 / switch model" },
  { name: "mode", usage: "/mode auto|manual|draft|yolo|prompt", desc: "切换回复/审批模式 / mode" },
  { name: "reasoning", usage: "/reasoning low|medium|high|xhigh|max", desc: "思考强度 / effort" },
  { name: "character", usage: "/character <id|名称>", desc: "切换角色 / switch character" },
  { name: "team", usage: "/team <名称|off>", desc: "绑定/解绑 Agent 团队 / bind a team" },
  {
    name: "workflow",
    usage: "/workflow <名称|id|off>",
    desc: "绑定/解绑可视化工作流 / bind a workflow",
  },
  {
    name: "goal",
    usage: "/goal <目标|status|pause|resume|stop>",
    desc: "启动/管理持续目标 / start or manage a goal",
  },
  {
    name: "agent",
    usage: "/agent status|off|verify",
    desc: "查看/关闭话题激活或启动免 @ 探测 / topic activation and delivery probe",
  },
  { name: "tasks", usage: "/tasks", desc: "列出本会话定时任务 / list scheduled tasks" },
  {
    name: "schedule",
    usage: "/schedule <间隔> <提示词> | cron <表达式> <提示词> | off <n|id>",
    desc: "创建或关闭定时任务 / create or stop a scheduled task",
  },
  { name: "dir", usage: "/dir", desc: "查看工作目录上下文 / working-dir context" },
]

export function renderHelp(): string {
  const lines = ["可用命令 / Available commands:"]
  for (const c of COMMAND_HELP) lines.push(`• ${c.usage} — ${c.desc}`)
  return lines.join("\n")
}

export function renderUnknown(name: string): string {
  return `未知命令 / Unknown command: /${name}\n发送 /help 查看可用命令 / send /help for the list`
}

export function renderDenied(): string {
  return "你没有权限在此会话执行该命令 / You're not allowed to run this command here"
}

/**
 * Reply when `/goal` create is blocked by the v49 guard — the conversation
 * hasn't opted into goal driving (`ConversationOverrideRow.allowGoalDriving`).
 */
export function renderGoalBlocked(): string {
  return [
    "该会话未开启目标驱动 / Goal driving isn't enabled for this conversation.",
    "在 App 的 收件箱 → 会话覆盖 中开启「允许目标驱动」后重试 / Enable it in the app under Inbox → Conversation override, then try again.",
  ].join("\n")
}

/** Usage hint for `/goal` (unknown subcommand / no session). */
export function renderGoalUsage(): string {
  return "用法 / Usage: /goal <目标 objective> · /goal status · /goal pause · /goal resume · /goal stop"
}

/** Per-command usage hint, shown when arg validation fails. */
export function renderUsage(name: ControlCommandName): string {
  const entry = COMMAND_HELP.find((c) => c.name === name)
  const usage = entry?.usage ?? `/${name}`
  return `用法 / Usage: ${usage}`
}

export interface StatusView {
  mode: string
  model: string
  provider: string
  character: string
  reasoning: string
  approvalMode: string
  team: string
  workflow: string
  sessionTitle: string
  sessionIdPrefix: string
}

export interface AgentTopicStatusView {
  policy: string
  active: boolean
  expiresAt?: number
  queueDepth: number
  activeRunId?: string
  dispatchMode: string
  readiness: string
  recoveryCount: number
}

export function renderAgentTopicStatus(v: AgentTopicStatusView): string {
  return [
    "话题 Agent 状态 / Topic Agent status:",
    `• 激活 / active: ${v.active ? "是 / yes" : "否 / no"}`,
    `• 策略 / policy: ${v.policy}`,
    `• 过期 / expires: ${v.expiresAt ? new Date(v.expiresAt).toISOString() : "—"}`,
    `• 运行中派发 / active-run dispatch: ${v.dispatchMode}`,
    `• 队列 / queue depth: ${v.queueDepth}`,
    `• 当前运行 / active run: ${v.activeRunId ?? "—"}`,
    `• 投递就绪 / delivery readiness: ${v.readiness}`,
    `• 待恢复 / recovery required: ${v.recoveryCount}`,
  ].join("\n")
}

export function confirmAgentOff(): string {
  return "已关闭当前话题的免 @ 激活；再次 @机器人可重新激活 / Topic activation closed; @bot to reactivate"
}

export function confirmAgentProbeStarted(): string {
  return "探测已启动（10 分钟）：请在群里发送一条不 @机器人的消息 / Probe started for 10 minutes; send one group message without @"
}

export function renderStatus(v: StatusView): string {
  return [
    "当前设置 / Current settings:",
    `• 模式 / mode: ${v.mode}`,
    `• 模型 / model: ${v.model}`,
    `• 提供商 / provider: ${v.provider}`,
    `• 审批 / approval: ${v.approvalMode}`,
    `• 思考强度 / reasoning: ${v.reasoning}`,
    `• 角色 / character: ${v.character}`,
    `• 团队 / team: ${v.team}`,
    `• 工作流 / workflow: ${v.workflow}`,
    `• 会话 / session: ${v.sessionTitle} (${v.sessionIdPrefix})`,
  ].join("\n")
}

/**
 * Annotate a value that came from the BOT-instance default (W1) rather than a
 * per-conversation override, so `/status` readers can tell the two apart.
 */
export function withBotDefault(value: string): string {
  return `${value}（bot 默认 / bot default）`
}

export interface SessionLine {
  title: string
  idPrefix: string
  active: boolean
}

export function renderSessions(lines: SessionLine[]): string {
  if (lines.length === 0) return "本会话暂无子会话 / No sessions yet"
  const out = ["会话列表 / Sessions:"]
  lines.forEach((s, i) => {
    out.push(`${i + 1}. ${s.title} (${s.idPrefix})${s.active ? "  ← 当前 / active" : ""}`)
  })
  return out.join("\n")
}

export function renderDir(summary: string): string {
  return `工作目录上下文 / Working context:\n${summary}`
}

// ── Confirmations ──────────────────────────────────────────────────────────

export function confirmMode(mode: string): string {
  return `已切换模式 / Mode set: ${mode}`
}
export function confirmApprovalMode(mode: string): string {
  return `已切换审批模式 / Approval mode set: ${mode}`
}
export function confirmModel(model: string, provider?: string): string {
  return provider
    ? `已切换模型 / Model set: ${provider}/${model}`
    : `已切换模型 / Model set: ${model}`
}
export function denyUnknownProvider(provider: string): string {
  return (
    `未知服务商 / Unknown provider: ${provider}\n` +
    "请检查拼写，或在收件箱覆盖表单中设置自定义服务商。 / Check the spelling, or set a custom provider via the inbox override form."
  )
}
export function confirmReasoning(level: string): string {
  return `已设置思考强度 / Reasoning set: ${level}`
}
export function confirmCharacter(name: string): string {
  return `已切换角色 / Character set: ${name}`
}
export function confirmTeam(name: string): string {
  return `已绑定团队 / Team bound: ${name}`
}
export function confirmTeamCleared(): string {
  return "已解绑团队 / Team unbound"
}
export function confirmTeamDisabled(): string {
  return "此会话已关闭团队（包括机器人默认团队）/ Team disabled for this chat (including the bot default)"
}
export function confirmWorkflow(name: string): string {
  return `已绑定工作流 / Workflow bound: ${name}`
}
export function confirmWorkflowCleared(): string {
  return "已解绑工作流 / Workflow unbound"
}
/**
 * Multiple workflows matched a `/workflow <name>` query — list the candidates
 * (capped upstream at 5) so the user can re-run with a more specific name or an
 * id. Bilingual header, then one `• name (idPrefix)` line per candidate.
 */
export function renderWorkflowAmbiguous(candidates: Array<{ id: string; name: string }>): string {
  const out = [
    "匹配到多个工作流，请用更精确的名称或 id / Multiple workflows matched — narrow by name or id:",
  ]
  for (const c of candidates) out.push(`• ${c.name} (${c.id.slice(0, 8)})`)
  return out.join("\n")
}
export function confirmNewSession(title: string, idPrefix: string): string {
  return `已新建并切换会话 / New session: ${title} (${idPrefix})`
}
export function confirmSwitched(title: string, idPrefix: string): string {
  return `已切换会话 / Switched to: ${title} (${idPrefix})`
}
