// Action handler for the `/goal` slash command family (ADR-0013).
//
// Surface (7 subcommands + 2 aliases):
//   /goal <text>          — create new goal (same as /goal create <text>)
//   /goal create <text>   — explicit create
//   /goal status          — push a status card into the chat
//   /goal show            — same as status, plus opens the Goals settings tab
//   /goal pause           — active → paused
//   /goal resume          — paused → active
//   /goal stop            — any non-terminal → stopped (alias: cancel, clear)
//   /goal update <text>   — replace the objective in place
//
// Streaming guard: every subcommand bails when chatStatus === "streaming".
// We can't safely mutate goal state mid-turn — the turn driver is
// reading the same row. The user gets a clear "wait for current turn"
// message back instead.

import type { SlashContext } from "../builtin"
import { useSettingsStore } from "@/stores/settings"
import { getGoalRuntime } from "@/lib/goal/runtime"
import { listGoalEvents } from "@/lib/db/goals"
import type { Goal, GoalEvent } from "@/types/goal"

/**
 * Result returned to the chat composer. When `dispatchPrompt` is set, the
 * caller is expected to send that text as a (silent) user message — used
 * by `/goal update` to fire the objective-changed notification to the
 * model. `system` is always pushed via `ctx.pushSystemMessage`; the two
 * are independent so a `/goal status` can render system text without
 * dispatching anything.
 */
export interface GoalCommandResult {
  /** Markdown to push into the chat as a system message (always). */
  system?: string
  /** When set, the caller dispatches this as the next prompt (rare). */
  dispatchPrompt?: string
  /** When true, the caller should open the Goals settings tab. */
  openGoalsSettings?: boolean
}

/**
 * Subcommand dispatcher. Returns `null` when the slash dispatcher should
 * fall through (e.g. unknown subcommand → user might have a custom
 * `.claude/commands/goal-foo.md`).
 */
export async function dispatchGoalSubcommand(ctx: SlashContext): Promise<GoalCommandResult | null> {
  if (!ctx.activeSessionId) {
    return { system: "Start a chat session first — `/goal` operates inside an active session." }
  }
  if (ctx.chatStatus === "streaming") {
    return {
      system:
        "The current turn is still streaming — `/goal` waits for the response to finish before changing the active goal.",
    }
  }
  // The composer hands us everything past `/goal` as `ctx.args`. Split off
  // the (optional) subcommand keyword so the rest can be the objective
  // text for `create` / `update`.
  const trimmed = (ctx.args ?? "").trim()
  const space = trimmed.search(/\s/)
  const head = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase()
  const rest = space === -1 ? "" : trimmed.slice(space + 1).trim()

  // No subcommand keyword → treat the whole `args` as the objective.
  if (!trimmed) return await commandStatus(ctx)
  switch (head) {
    case "status":
      return await commandStatus(ctx)
    case "show":
      return await commandShow(ctx)
    case "pause":
      return await commandPause(ctx)
    case "resume":
      return await commandResume(ctx)
    case "stop":
    case "cancel":
    case "clear":
      return await commandStop(ctx)
    case "update":
      return await commandUpdate(ctx, rest)
    case "create":
      return await commandCreate(ctx, rest)
    default:
      // Treat the entire string as objective text — `/goal write me a haiku`.
      return await commandCreate(ctx, trimmed)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Subcommand implementations
// ─────────────────────────────────────────────────────────────────────────────

async function commandCreate(ctx: SlashContext, objective: string): Promise<GoalCommandResult> {
  const text = objective.trim()
  if (!text) {
    return {
      system:
        "Usage: `/goal <what you want to accomplish>`. Example: `/goal write a haiku about winter`.",
    }
  }
  const sessionId = ctx.activeSessionId!
  const appSettings = useSettingsStore.getState().settings ?? null
  const characterId = await resolveCharacterForSession(sessionId)
  const goal = await getGoalRuntime().createGoal({
    sessionId,
    characterId,
    rawObjective: text,
    appSettings,
  })
  return {
    system: renderCreatedCard(goal),
  }
}

async function commandStatus(ctx: SlashContext): Promise<GoalCommandResult> {
  const goal = await getGoalRuntime().getOpenGoalForSession(ctx.activeSessionId!)
  if (!goal) {
    return {
      system:
        "No active goal in this session. Start one with `/goal <what you want to accomplish>`.",
    }
  }
  const events = await listGoalEvents(goal.id, 10)
  return { system: renderStatusCard(goal, events) }
}

async function commandShow(ctx: SlashContext): Promise<GoalCommandResult> {
  const out = await commandStatus(ctx)
  return { ...out, openGoalsSettings: true }
}

async function commandPause(ctx: SlashContext): Promise<GoalCommandResult> {
  const goal = await getGoalRuntime().getOpenGoalForSession(ctx.activeSessionId!)
  if (!goal) return { system: "No active goal to pause." }
  if (goal.status !== "active") {
    return { system: `Goal is already ${goal.status} — nothing to pause.` }
  }
  const updated = await getGoalRuntime().pauseGoal(goal.id)
  return {
    system: `Goal paused — ${updated?.turnsUsed ?? 0}/${updated?.config.maxTurns ?? 0} turns used. Resume with \`/goal resume\`.`,
  }
}

async function commandResume(ctx: SlashContext): Promise<GoalCommandResult> {
  const goal = await getGoalRuntime().getOpenGoalForSession(ctx.activeSessionId!)
  if (!goal) return { system: "No goal to resume." }
  if (goal.status === "active") {
    return { system: "Goal is already active." }
  }
  if (goal.status !== "paused") {
    return {
      system: `Cannot resume a ${goal.status} goal. Create a new one with \`/goal <text>\`.`,
    }
  }
  await getGoalRuntime().resumeGoal(goal.id)
  return { system: `Goal resumed. The loop will continue on the next turn.` }
}

async function commandStop(ctx: SlashContext): Promise<GoalCommandResult> {
  const goal = await getGoalRuntime().getOpenGoalForSession(ctx.activeSessionId!)
  if (!goal) return { system: "No active goal to stop." }
  await getGoalRuntime().stopGoal(goal.id)
  return { system: `Goal stopped after ${goal.turnsUsed} turn(s).` }
}

async function commandUpdate(ctx: SlashContext, newObjective: string): Promise<GoalCommandResult> {
  const text = newObjective.trim()
  if (!text) {
    return { system: "Usage: `/goal update <new objective>`." }
  }
  const goal = await getGoalRuntime().getOpenGoalForSession(ctx.activeSessionId!)
  if (!goal) {
    return { system: "No active goal — create one first with `/goal <text>`." }
  }
  const updated = await getGoalRuntime().updateObjective(goal.id, text)
  if (!updated) {
    return { system: "Objective unchanged (matches the current one) or goal is no longer mutable." }
  }
  return {
    system: `Objective updated. The model will be told about the change on the next turn.\n\n> ${updated.goal.safeObjective}`,
    dispatchPrompt: updated.updatePrompt,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Card renderers
// ─────────────────────────────────────────────────────────────────────────────

function renderCreatedCard(goal: Goal): string {
  return [
    `🎯 **Goal active** — ${goal.config.maxTurns} turn budget, ${(goal.config.maxTokens / 1000).toFixed(0)}k token budget.`,
    "",
    `> ${goal.safeObjective}`,
    "",
    "The agent will continue toward this goal automatically. Pause with `/goal pause` · stop with `/goal stop` · update with `/goal update <new text>`.",
  ].join("\n")
}

function renderStatusCard(goal: Goal, events: GoalEvent[]): string {
  const minutesElapsed = Math.round((Date.now() - goal.createdAt) / 60_000)
  const lines = [
    `🎯 **${statusEmoji(goal.status)} ${goal.status.toUpperCase()}** — ${goal.turnsUsed}/${goal.config.maxTurns} turns · ${goal.tokensUsed.toLocaleString()} tokens · ${minutesElapsed}m elapsed`,
    "",
    `> ${goal.safeObjective}`,
  ]
  if (events.length > 0) {
    lines.push("", "**Recent activity:**")
    for (const ev of events.slice(0, 5)) {
      lines.push(`- \`${ev.kind}\` at ${new Date(ev.ts).toLocaleTimeString()}`)
    }
  }
  return lines.join("\n")
}

function statusEmoji(status: Goal["status"]): string {
  switch (status) {
    case "active":
      return "🟢"
    case "paused":
      return "⏸️"
    case "completed":
      return "✅"
    case "stopped":
      return "⏹️"
    case "budget_limited":
    case "turn_limited":
    case "timed_out":
      return "🛑"
    case "preempted":
      return "↩️"
    default:
      return "•"
  }
}

/**
 * Best-effort character lookup for the audit trail. The slash context
 * doesn't carry the character id directly, so we read it off the active
 * session row.
 */
async function resolveCharacterForSession(sessionId: string): Promise<string | undefined> {
  try {
    const { getSession } = await import("@/lib/db/sessions")
    const session = await getSession(sessionId)
    return session?.characterId
  } catch {
    return undefined
  }
}
