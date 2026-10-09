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
//
// Every reply is read by the user (in the chat transcript, or in an IM
// thread through `lib/connectors/commands/goal.ts`), so it goes through the
// runtime translator in the locale the UI shows, under `goal.commands`.
// Status words and activity labels reuse `goal.status` / `goal.activity.kinds`,
// the same labels the Goals UI renders.
//
// Where the goal lives: the loop runs on the conversation's host. On the
// desktop (and a browser profile, and the IM connector, which runs on the
// desktop) that is this process, so the subcommands drive `GoalRuntime`
// directly. On a paired phone (Capacitor shell) the loop runs on the paired
// desktop, so the same subcommands go over the Companion goal RPCs
// (`goal_status` / `goal_create` / `goal_pause` / `goal_resume` / `goal_stop` /
// `goal_update`), the way `useGoalControls` routes the Goals UI's buttons.
// Writes there need the remote-control grant, asked for up front
// (`companion_can_control`) so a refusal reads as one, not as a network error;
// an unreachable desktop answers `goal.remote.failed`. Reads stay local: the
// phone mirrors the goal event log (`goalEvents`, `lib/sync/handlers/goals.ts`),
// so a remote status card lists the same recent activity the desktop's does.

import type { SlashContext } from "../builtin"
import { useSettingsStore } from "@/stores/settings"
import { getGoalRuntime } from "@/lib/goal/runtime"
import { listGoalEvents } from "@/lib/db/goals"
import { getRuntimeTranslator, type RuntimeTranslator } from "@/lib/i18n/runtime-translator"
import { isNativeMobile } from "@/lib/platform/detect"
import type { Goal, GoalEvent } from "@/types/goal"

/** Scoped to `goal` (not `goal.commands`) so status and kind labels resolve too. */
const translator = () => getRuntimeTranslator("goal")

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
  const t = await translator()
  const host = isNativeMobile() ? companionGoalHost : localGoalHost
  if (!host.remote) return await runGoalSubcommand(ctx, t, host)
  try {
    return await runGoalSubcommand(ctx, t, host)
  } catch {
    // The desktop did not answer, or refused a call this device may not make.
    return { system: t("remote.failed") }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Where the goal lives
// ─────────────────────────────────────────────────────────────────────────────

/** The goal operations a subcommand needs, on the host that runs the loop. */
interface GoalCommandHost {
  /** The loop runs on the paired desktop; every call is a Companion RPC. */
  remote: boolean
  /** Whether this surface may change the goal. Always `true` on the host. */
  canControl(): Promise<boolean>
  /** The session's open goal (`active`, else `paused`). */
  getOpenGoal(sessionId: string): Promise<Goal | undefined>
  /** Newest-first activity, read from this device's copy of the event log. */
  recentEvents(goalId: string): Promise<GoalEvent[]>
  createGoal(input: {
    sessionId: string
    characterId?: string
    rawObjective: string
  }): Promise<Goal>
  pauseGoal(goalId: string): Promise<Goal | null>
  resumeGoal(goalId: string): Promise<Goal | null>
  stopGoal(goalId: string): Promise<Goal | null>
  /** `null` when the runtime refused (goal ended, or the objective is unchanged). */
  updateObjective(
    goalId: string,
    rawObjective: string
  ): Promise<{ goal: Goal; updatePrompt: string } | null>
}

/** This process runs the loop: the desktop, a browser profile, the IM connector. */
const localGoalHost: GoalCommandHost = {
  remote: false,
  canControl: async () => true,
  getOpenGoal: (sessionId) => getGoalRuntime().getOpenGoalForSession(sessionId),
  recentEvents: (goalId) => listGoalEvents(goalId, 10),
  createGoal: (input) =>
    getGoalRuntime().createGoal({
      ...input,
      appSettings: useSettingsStore.getState().settings ?? null,
    }),
  pauseGoal: (goalId) => getGoalRuntime().pauseGoal(goalId),
  resumeGoal: (goalId) => getGoalRuntime().resumeGoal(goalId),
  stopGoal: (goalId) => getGoalRuntime().stopGoal(goalId),
  updateObjective: (goalId, rawObjective) => getGoalRuntime().updateObjective(goalId, rawObjective),
}

/** Lazy, so the desktop and IM paths never load the Companion transport. */
async function companionCall<T>(command: string, payload?: Record<string, unknown>): Promise<T> {
  const { transport } = await import("@/lib/tauri/transport-instance")
  return transport.call<T>(command, payload)
}

/**
 * A paired phone: the loop runs on the desktop. Each call is the RPC the Goals
 * UI's own verbs use on this device, run there by the same `GoalRuntime`
 * method. The desktop loads its own settings for the defaults and the
 * redaction allowlist; this device's do not travel.
 */
const companionGoalHost: GoalCommandHost = {
  remote: true,
  canControl: async () => {
    const result = await companionCall<{ allowed?: boolean } | null>("companion_can_control")
    return result?.allowed === true
  },
  getOpenGoal: async (sessionId) => {
    const result = await companionCall<{ activeGoal?: Goal | null; goals?: Goal[] } | null>(
      "goal_status",
      { sessionId }
    )
    // `getOpenGoalForSession` on the desktop: the active goal, else a paused one.
    return (
      result?.activeGoal ?? result?.goals?.find((goal) => goal.status === "paused") ?? undefined
    )
  },
  // The event log is a synced table (`goalEvents`), so the phone reads its
  // mirror rather than asking the desktop.
  recentEvents: (goalId) => listGoalEvents(goalId, 10),
  createGoal: async ({ sessionId, characterId, rawObjective }) => {
    const result = await companionCall<{ goal?: Goal | null } | null>("goal_create", {
      sessionId,
      rawObjective,
      ...(characterId ? { characterId } : {}),
    })
    if (!result?.goal) throw new Error("goal_create answered no goal")
    return result.goal
  },
  pauseGoal: async (goalId) =>
    (await companionCall<{ goal?: Goal | null } | null>("goal_pause", { goalId }))?.goal ?? null,
  resumeGoal: async (goalId) =>
    (await companionCall<{ goal?: Goal | null } | null>("goal_resume", { goalId }))?.goal ?? null,
  stopGoal: async (goalId) =>
    (await companionCall<{ goal?: Goal | null } | null>("goal_stop", { goalId }))?.goal ?? null,
  updateObjective: async (goalId, rawObjective) => {
    const result = await companionCall<{ goal?: Goal | null; updatePrompt?: string } | null>(
      "goal_update",
      { goalId, rawObjective }
    )
    // The desktop answers the stored row even when it refused the update;
    // only an applied update carries the model-facing prompt.
    if (!result?.goal || typeof result.updatePrompt !== "string") return null
    return { goal: result.goal, updatePrompt: result.updatePrompt }
  },
}

/**
 * The refusal for a write this surface may not make, or `null` to go ahead.
 * Only a paired phone without the remote-control grant is refused.
 */
async function controlRefusal(
  host: GoalCommandHost,
  t: RuntimeTranslator
): Promise<GoalCommandResult | null> {
  return (await host.canControl()) ? null : { system: t("commands.remoteNotAllowed") }
}

async function runGoalSubcommand(
  ctx: SlashContext,
  t: RuntimeTranslator,
  host: GoalCommandHost
): Promise<GoalCommandResult | null> {
  if (!ctx.activeSessionId) {
    return { system: t("commands.needSession") }
  }
  if (ctx.chatStatus === "streaming") {
    return { system: t("commands.streaming") }
  }
  // The composer hands us everything past `/goal` as `ctx.args`. Split off
  // the (optional) subcommand keyword so the rest can be the objective
  // text for `create` / `update`.
  const trimmed = (ctx.args ?? "").trim()
  const space = trimmed.search(/\s/)
  const head = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase()
  const rest = space === -1 ? "" : trimmed.slice(space + 1).trim()

  // No subcommand keyword → treat the whole `args` as the objective.
  if (!trimmed) return await commandStatus(ctx, t, host)
  switch (head) {
    case "status":
      return await commandStatus(ctx, t, host)
    case "show":
      return await commandShow(ctx, t, host)
    case "pause":
      return await commandPause(ctx, t, host)
    case "resume":
      return await commandResume(ctx, t, host)
    case "stop":
    case "cancel":
    case "clear":
      return await commandStop(ctx, t, host)
    case "update":
      return await commandUpdate(ctx, t, host, rest)
    case "create":
      return await commandCreate(ctx, t, host, rest)
    default:
      // Treat the entire string as objective text — `/goal write me a haiku`.
      return await commandCreate(ctx, t, host, trimmed)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Subcommand implementations
// ─────────────────────────────────────────────────────────────────────────────

async function commandCreate(
  ctx: SlashContext,
  t: RuntimeTranslator,
  host: GoalCommandHost,
  objective: string
): Promise<GoalCommandResult> {
  const text = objective.trim()
  if (!text) {
    return { system: t("commands.createUsage") }
  }
  const refusal = await controlRefusal(host, t)
  if (refusal) return refusal
  const sessionId = ctx.activeSessionId!
  const characterId = await resolveCharacterForSession(sessionId)
  const goal = await host.createGoal({
    sessionId,
    characterId,
    rawObjective: text,
  })
  return {
    system: renderCreatedCard(t, goal),
  }
}

async function commandStatus(
  ctx: SlashContext,
  t: RuntimeTranslator,
  host: GoalCommandHost
): Promise<GoalCommandResult> {
  const goal = await host.getOpenGoal(ctx.activeSessionId!)
  if (!goal) {
    return { system: t("commands.noActiveGoal") }
  }
  const events = await host.recentEvents(goal.id)
  return { system: renderStatusCard(t, goal, events) }
}

async function commandShow(
  ctx: SlashContext,
  t: RuntimeTranslator,
  host: GoalCommandHost
): Promise<GoalCommandResult> {
  const out = await commandStatus(ctx, t, host)
  return { ...out, openGoalsSettings: true }
}

async function commandPause(
  ctx: SlashContext,
  t: RuntimeTranslator,
  host: GoalCommandHost
): Promise<GoalCommandResult> {
  const goal = await host.getOpenGoal(ctx.activeSessionId!)
  if (!goal) return { system: t("commands.noGoalToPause") }
  if (goal.status !== "active") {
    return { system: t("commands.cannotPause", { status: statusLabel(t, goal.status) }) }
  }
  const refusal = await controlRefusal(host, t)
  if (refusal) return refusal
  const updated = await host.pauseGoal(goal.id)
  return {
    system: t("commands.paused", {
      turns: updated?.turnsUsed ?? 0,
      maxTurns: updated?.config.maxTurns ?? 0,
    }),
  }
}

async function commandResume(
  ctx: SlashContext,
  t: RuntimeTranslator,
  host: GoalCommandHost
): Promise<GoalCommandResult> {
  const goal = await host.getOpenGoal(ctx.activeSessionId!)
  if (!goal) return { system: t("commands.noGoalToResume") }
  if (goal.status === "active") {
    return { system: t("commands.alreadyActive") }
  }
  if (goal.status !== "paused") {
    return { system: t("commands.cannotResume", { status: statusLabel(t, goal.status) }) }
  }
  const refusal = await controlRefusal(host, t)
  if (refusal) return refusal
  await host.resumeGoal(goal.id)
  return { system: t("commands.resumed") }
}

async function commandStop(
  ctx: SlashContext,
  t: RuntimeTranslator,
  host: GoalCommandHost
): Promise<GoalCommandResult> {
  const goal = await host.getOpenGoal(ctx.activeSessionId!)
  if (!goal) return { system: t("commands.noGoalToStop") }
  const refusal = await controlRefusal(host, t)
  if (refusal) return refusal
  await host.stopGoal(goal.id)
  return { system: t("commands.stopped", { turns: goal.turnsUsed }) }
}

async function commandUpdate(
  ctx: SlashContext,
  t: RuntimeTranslator,
  host: GoalCommandHost,
  newObjective: string
): Promise<GoalCommandResult> {
  const text = newObjective.trim()
  if (!text) {
    return { system: t("commands.updateUsage") }
  }
  const goal = await host.getOpenGoal(ctx.activeSessionId!)
  if (!goal) {
    return { system: t("commands.updateNoGoal") }
  }
  const refusal = await controlRefusal(host, t)
  if (refusal) return refusal
  const updated = await host.updateObjective(goal.id, text)
  if (!updated) {
    return { system: t("commands.objectiveUnchanged") }
  }
  return {
    system: `${t("commands.objectiveUpdated")}\n\n> ${updated.goal.safeObjective}`,
    dispatchPrompt: updated.updatePrompt,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Card renderers
// ─────────────────────────────────────────────────────────────────────────────

function renderCreatedCard(t: RuntimeTranslator, goal: Goal): string {
  return [
    t("commands.created", {
      maxTurns: goal.config.maxTurns,
      maxTokensK: Math.round(goal.config.maxTokens / 1000),
    }),
    "",
    `> ${goal.safeObjective}`,
    "",
    t("commands.createdHint"),
  ].join("\n")
}

function renderStatusCard(t: RuntimeTranslator, goal: Goal, events: GoalEvent[]): string {
  const minutesElapsed = Math.round((Date.now() - goal.createdAt) / 60_000)
  const lines = [
    t("commands.statusHeader", {
      emoji: statusEmoji(goal.status),
      // Upper-cased as the card's headline; a no-op for scripts without case.
      status: statusLabel(t, goal.status).toUpperCase(),
      turns: goal.turnsUsed,
      maxTurns: goal.config.maxTurns,
      tokens: goal.tokensUsed,
      minutes: minutesElapsed,
    }),
    "",
    `> ${goal.safeObjective}`,
  ]
  if (events.length > 0) {
    lines.push("", t("commands.recentActivity"))
    for (const ev of events.slice(0, 5)) {
      lines.push(
        t("commands.activityItem", {
          label: t(`activity.kinds.${ev.kind}`),
          time: new Date(ev.ts),
        })
      )
    }
  }
  return lines.join("\n")
}

/** The status word the Goals UI shows (`goal.status.*`). */
function statusLabel(t: RuntimeTranslator, status: Goal["status"]): string {
  return t(`status.${status}`)
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
