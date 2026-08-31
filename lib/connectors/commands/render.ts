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
import type { DispatchRule } from "@/lib/db/connector-types"

/** A control command and its one-line bilingual description, for `/help`. */
const COMMAND_HELP: Array<{ name: ControlCommandName; usage: string; desc: string }> = [
  { name: "commands", usage: "/commands", desc: "显示此命令列表 / show this list" },
  { name: "status", usage: "/status", desc: "查看当前会话设置 / show current settings" },
  { name: "sessions", usage: "/sessions", desc: "列出本会话的所有子会话 / list sessions" },
  { name: "new", usage: "/new", desc: "新建并切换到新会话 / start a new session" },
  { name: "switch", usage: "/switch <id|标题>", desc: "切换到指定会话 / switch session" },
  { name: "model", usage: "/model <名称>", desc: "切换模型 / switch model" },
  {
    name: "mode",
    usage: "/mode assistant|delegate|draft|silent|yolo|prompt",
    desc: "切换行为/审批模式 / behaviour or approval mode",
  },
  { name: "reasoning", usage: "/reasoning low|medium|high|xhigh|max", desc: "思考强度 / effort" },
  { name: "character", usage: "/character <id|名称>", desc: "切换角色 / switch character" },
  { name: "team", usage: "/team <名称|off>", desc: "绑定/解绑 Agent 团队 / bind a team" },
  {
    name: "delegate",
    usage: "/delegate [标题]",
    desc: "把进行中的任务转为委派 / promote a running task to a delegation",
  },
  {
    name: "handoff",
    usage: "/handoff [姓名] | back [备注]",
    desc: "把委派任务交给人 / hand a delegated task to a person",
  },
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
  /**
   * The named behaviour preset the resolved axes add up to, or `custom` plus
   * the axes when they add up to none.
   *
   * `mode` below stays as the legacy three-value mirror. It had to: a
   * `delegate` conversation mirrors to `auto`, so a reader of `mode` alone
   * could not tell that the bot answers in the background rather than in the
   * thread. Reporting both is what makes the mirror's lossiness visible
   * instead of misleading.
   */
  behaviour: string
  mode: string
  model: string
  provider: string
  character: string
  reasoning: string
  approvalMode: string
  team: string
  workflow: string
  routeSource: string
  matchedRule: string
  responseAdapter: string
  enabledRules: string[]
  sessionTitle: string
  sessionIdPrefix: string
  /**
   * Optional "assignee" line (slice 1A). Rendered between mode and model
   * when the conversation is assigned so the reader can connect a routing
   * source of "assignment" to who holds the conversation.
   */
  assignee?: string
}

/** Render the current assignee for `/status` (bilingual, no i18n at this layer). */
export function renderAssignee(
  assignee: { kind: "human" | "character" | "team"; id?: string; label?: string } | undefined
): string | undefined {
  if (!assignee) return undefined
  if (assignee.kind === "human") return "人工 / me"
  const name = assignee.label?.trim() || assignee.id?.trim() || "?"
  return assignee.kind === "team" ? `团队 / team: ${name}` : `角色 / character: ${name}`
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
  const lines = [
    "当前 /status 事件的实际路由 / Actual route for this /status event:",
    `• 来源 / source: ${v.routeSource}`,
    `• 匹配规则 / matched rule: ${v.matchedRule}`,
    `• 回复 Adapter / response adapter: ${v.responseAdapter}`,
    `• 行为 / behaviour: ${v.behaviour}`,
    `• 模式 / mode: ${v.mode}`,
    ...(v.assignee ? [`• 分配 / assignee: ${v.assignee}`] : []),
    `• 模型 / model: ${v.model}`,
    `• 提供商 / provider: ${v.provider}`,
    `• 审批 / approval: ${v.approvalMode}`,
    `• 思考强度 / reasoning: ${v.reasoning}`,
    `• 角色 / character: ${v.character}`,
    `• 团队 / team: ${v.team}`,
    `• 工作流 / workflow: ${v.workflow}`,
    `• 会话 / session: ${v.sessionTitle} (${v.sessionIdPrefix})`,
    "已启用规则（优先级顺序） / Enabled rules (priority order):",
    ...(v.enabledRules.length > 0 ? v.enabledRules : ["无 / none"]),
    "后续消息会按其文本、发送者和频道重新匹配，结果可能不同 / Future messages are matched again by their text, sender, and channel, so their route may differ.",
  ]
  return lines.join("\n")
}

export function sourceLabel(source: string): string {
  const labels: Record<string, string> = {
    override: "会话覆盖 / conversation override",
    assignment: "会话分配 / assignment",
    rule: "路由规则 / dispatch rule",
    "instance-default": "Adapter 默认 / adapter default",
    none: "系统默认 / system default",
    "conversation-override": "会话覆盖 / conversation override",
    "dispatch-rule": "路由规则 / dispatch rule",
    "adapter-default": "Adapter 默认 / adapter default",
    "system-default": "系统默认 / system default",
    "target-managed": "执行目标管理 / managed by execution target",
  }
  return labels[source] ?? source
}

export function renderDispatchRuleSummary(rule: DispatchRule, priority: number): string {
  const label = rule.name?.trim() ? `${rule.name.trim()} (${rule.id})` : rule.id
  const targets = [
    rule.action.teamId?.trim() ? `team:${rule.action.teamId.trim()}` : undefined,
    rule.action.workflowId?.trim() ? `workflow:${rule.action.workflowId.trim()}` : undefined,
    rule.action.characterId?.trim() ? `character:${rule.action.characterId.trim()}` : undefined,
    rule.action.respondViaAdapterId?.trim()
      ? `respond-via:${rule.action.respondViaAdapterId.trim()}`
      : undefined,
  ].filter((value): value is string => Boolean(value))
  return `${priority}. ${label} → ${targets.length > 0 ? targets.join(", ") : "无目标 / no target"}`
}

/**
 * Annotate a value that came from the BOT-instance default (W1) rather than a
 * per-conversation override, so `/status` readers can tell the two apart.
 */
export function withBotDefault(value: string): string {
  return `${value}（bot 默认 / bot default）`
}

export function withSource(value: string, source: string): string {
  return `${value}（${sourceLabel(source)}）`
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
/**
 * `delegate` freezes `engagement: "background"`, and background work has no
 * carrier without a team or workflow to run it. Refusing with the reason beats
 * writing a value nothing acts on, which is what the settings editor's
 * disabled row says in its own way.
 */
export function denyDelegateWithoutTarget(): string {
  return (
    "无法切换到「委派」：当前会话没有绑定团队或工作流，后台任务没有承载方。 / " +
    "Cannot switch to delegate: this conversation has no team or workflow bound, " +
    "so a background run has nothing to carry it.\n" +
    "先用 /team <名称> 或 /workflow <名称> 绑定，再切换。 / " +
    "Bind one with /team <name> or /workflow <name> first."
  )
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
export function confirmCharacterDisabled(): string {
  return "此会话已关闭角色 / Character disabled for this chat"
}
export function confirmCharacterInherited(): string {
  return "角色已恢复继承 / Character restored to inherited setting"
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
  return "此会话已关闭工作流 / Workflow disabled for this chat"
}
export function denyWorkflowNotDeployed(name: string): string {
  return `工作流没有 active production deployment，无法绑定 / Workflow has no active production deployment: ${name}`
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

/**
 * `/model a/b` where `a` is a real provider but not THIS channel's provider.
 *
 * Two readings exist — "switch to provider a, model b" and "keep the current
 * provider, model id is literally a/b" — and both are plausible on a channel
 * bound to an aggregator, where gateway-style ids carry a slash. Guessing
 * silently repoints the channel at a different vendor and the bill is where
 * you find out, so ask instead.
 */
export function denyAmbiguousModelArg(
  arg: string,
  provider: string,
  model: string,
  currentProvider: string
): string {
  return (
    `参数有歧义 / Ambiguous argument: ${arg}\n` +
    `当前服务商 / Current provider: ${currentProvider}\n` +
    `· 切换服务商 / Switch provider: /model ${provider}:${model}\n` +
    `· 保持服务商，仅设模型 / Keep provider, set model only: /model ${currentProvider}:${arg}`
  )
}
