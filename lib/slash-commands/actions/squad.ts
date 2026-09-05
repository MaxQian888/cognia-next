// Action handler for the `/squad` slash command family (ADR-0140).
//
// A Squad is an executor on the same axis as a model, and every other executor
// in this product answers to the keyboard. This one did not: seventeen builtin
// slash commands, none of them about Squads, so the only way to start, inspect
// or stop one was to leave the conversation for `/squads` or Settings. `/plan`
// already resolved `session.squadId` to project a Squad's task DAG, which made
// the absence louder, because chat could read a Squad and not address it.
//
// Surface (7 subcommands plus aliases), noun-first, the shape the field has
// converged on (`claude agents`, `oz run list`, Factory `/missions`):
//
//   /squad                      status card for the session's Squad
//   /squad list                 the workspace's Squads and what each is doing
//   /squad run [goal]           start it, optionally reseating the objective
//   /squad status               read-only, always
//   /squad pause | resume       hold and release a live run
//   /squad stop                 graceful shutdown (alias: shutdown)
//   /squad tasks                the board, in board order
//
// Nothing here is a new capability. Every branch funnels into a call some other
// surface already makes: `startSquadRun` (the one ADR-0140 dispatch funnel, the
// same one chat and the issues adapter use), `agentTeamManager` for control,
// and the store for reads. The command is reach, not machinery.
//
// Two guards copied from `/plan`, for the same reasons. No session means there
// is nothing to bind to, and mutating a Squad mid-turn would race the in-session
// driver reading the same rows.
//
// Card renderers are hard-coded English, consistent with the `/plan` and
// `/goal` cards.

import type { SlashContext } from "../builtin"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { useProjectStore } from "@/stores/project/project-store"
import { soloTeamId } from "@/lib/agent/plan-mode-bridge"
import type { AgentTeam, AgentTeamTask, TeamStatus } from "@/types/agent/agent-team"

/** Result handed back to the composer. `system` is pushed as a system message. */
export interface SquadCommandResult {
  system: string
}

/** Statuses that mean the Squad is holding a run open. */
const LIVE_STATUSES: ReadonlySet<TeamStatus> = new Set<TeamStatus>(["planning", "executing"])

/** Statuses a `run` would collide with. Same predicate the issues adapter uses. */
const BUSY_STATUSES: ReadonlySet<TeamStatus> = new Set<TeamStatus>([
  "planning",
  "executing",
  "paused",
])

/**
 * Subcommand dispatcher. Always returns a result. Unlike `/plan`, the default
 * branch is NOT "treat the rest as an objective": a bare word after `/squad` is
 * far more likely a Squad name than a goal, and silently starting the wrong
 * Squad spends real tokens. Unknown heads get usage back.
 */
export async function dispatchSquadSubcommand(ctx: SlashContext): Promise<SquadCommandResult> {
  if (!ctx.activeSessionId) {
    return { system: "Start a chat session first. `/squad` operates inside an active session." }
  }
  if (ctx.chatStatus === "streaming") {
    return {
      system:
        "The current turn is still streaming. `/squad` waits for the response to finish before acting on a Squad.",
    }
  }

  const trimmed = (ctx.args ?? "").trim()
  const space = trimmed.search(/\s/)
  const head = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase()
  const rest = space === -1 ? "" : trimmed.slice(space + 1).trim()

  if (!trimmed) return await commandStatus(ctx, "")
  switch (head) {
    case "list":
    case "ls":
      return commandList()
    case "status":
      return await commandStatus(ctx, rest)
    case "run":
    case "start":
      return await commandRun(ctx, rest)
    case "pause":
      return await commandControl(ctx, rest, "pause")
    case "resume":
      return await commandControl(ctx, rest, "resume")
    case "stop":
    case "shutdown":
      return await commandControl(ctx, rest, "shutdown")
    case "tasks":
    case "board":
      return await commandTasks(ctx, rest)
    default:
      return { system: usage() }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Squad resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which Squad a subcommand acts on.
 *
 * An explicit `<id|name>` argument wins. Otherwise the session's own binding,
 * with the same three-source precedence `/plan` uses. `squadId` is the ADR-0140
 * binding, `teamId` is a character-team room (a different concept with the same
 * word), and the synthetic `solo:<id>` team is the plan-mode bridge's, which is
 * never a real Squad and so is excluded here.
 */
async function resolveSquad(
  ctx: SlashContext,
  query: string
): Promise<{ squad: AgentTeam } | { error: string }> {
  const state = useAgentTeamStore.getState()
  if (query) {
    const byId = state.teams[query]
    if (byId) return { squad: byId }
    const lower = query.toLowerCase()
    const matches = workspaceSquads().filter((s) => s.name.toLowerCase().includes(lower))
    if (matches.length === 0) {
      return { error: `No Squad matches "${query}". Run \`/squad list\` to see this workspace's.` }
    }
    if (matches.length > 1) {
      const names = matches.slice(0, 5).map((s) => `- ${s.name}`)
      return {
        error: [`"${query}" matches ${matches.length} Squads:`, "", ...names].join("\n"),
      }
    }
    return { squad: matches[0] }
  }

  const session = await loadSession(ctx.activeSessionId!)
  const bound = session?.squadId ?? session?.teamId
  // The solo team is TodoWrite scaffolding, not a Squad. Naming it here would
  // make `/squad status` answer for a thing the user never created.
  if (bound && bound !== soloTeamId(ctx.activeSessionId!)) {
    const squad = state.teams[bound]
    if (squad) return { squad }
  }
  return {
    error: [
      "This conversation is not handed to a Squad.",
      "",
      "Name one with `/squad run <name>`, or pick it in the composer's executor control. `/squad list` shows what this workspace has.",
    ].join("\n"),
  }
}

/**
 * The workspace's Squads. Same predicate as the fleet console and the Settings
 * library. A Squad with no `projectId` is shared, not foreign, so an absent
 * value passes.
 */
function workspaceSquads(): AgentTeam[] {
  const workspaceId = useProjectStore.getState().activeProjectId
  return Object.values(useAgentTeamStore.getState().teams).filter(
    (team) => !workspaceId || !team.projectId || team.projectId === workspaceId
  )
}

/** Best-effort session read, mirroring the one in `/plan`. */
async function loadSession(sessionId: string) {
  try {
    const { getSession } = await import("@/lib/db/sessions")
    return await getSession(sessionId)
  } catch {
    return undefined
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Subcommand implementations
// ─────────────────────────────────────────────────────────────────────────────

function commandList(): SquadCommandResult {
  const squads = workspaceSquads()
  if (squads.length === 0) {
    return {
      system:
        "No Squads in this workspace yet. Create one in **Settings → Squads**, or start from a template.",
    }
  }
  const state = useAgentTeamStore.getState()
  // Live first, then by name, the same triage the fleet rail applies, so the
  // list and the console agree about what matters.
  const rows = [...squads]
    .sort((a, b) => {
      const aLive = LIVE_STATUSES.has(a.status) ? 0 : 1
      const bLive = LIVE_STATUSES.has(b.status) ? 0 : 1
      return aLive - bLive || a.name.localeCompare(b.name)
    })
    .map((squad) => {
      const members = Object.values(state.teammates).filter((m) => m.teamId === squad.id).length
      return `- ${statusDot(squad.status)} **${squad.name}** — ${squad.status}, ${members} member(s)`
    })
  return {
    system: [`👥 **Squads in this workspace** (${squads.length})`, "", ...rows].join("\n"),
  }
}

async function commandStatus(ctx: SlashContext, rest: string): Promise<SquadCommandResult> {
  const resolved = await resolveSquad(ctx, rest)
  if ("error" in resolved) return { system: resolved.error }
  const { squad } = resolved
  const state = useAgentTeamStore.getState()
  const members = Object.values(state.teammates).filter((m) => m.teamId === squad.id)
  const tasks = Object.values(state.tasks).filter((t) => t.teamId === squad.id)
  const done = tasks.filter((t) => t.status === "completed").length

  const lines = [
    `${statusDot(squad.status)} **${squad.name}** — ${squad.status}`,
    "",
    `- Roster: ${members.length} member(s)`,
    `- Board: ${done}/${tasks.length} task(s) complete`,
  ]
  if (squad.task) lines.push(`- Objective: ${squad.task}`)
  if (squad.error) lines.push(`- Last error: ${squad.error}`)
  lines.push("", `Open it at \`/squads?id=${squad.id}\`.`)
  return { system: lines.join("\n") }
}

/**
 * `/squad run [goal]`, the only branch that spends anything.
 *
 * Goes through `startSquadRun`, the ADR-0140 funnel, and passes the session.
 * A slash command IS a conversation, unlike the plugin and issues callers which
 * deliberately omit it and get an uncarded run. Passing it is what makes the run
 * card render in this thread and the control callbacks resolve.
 */
async function commandRun(ctx: SlashContext, rest: string): Promise<SquadCommandResult> {
  // `/squad run <name> the goal` is ambiguous, so the whole remainder is the
  // goal whenever the session already names a Squad. Only when it does not is
  // the remainder read as the Squad to start.
  const bound = await resolveSquad(ctx, "")
  const target = "error" in bound && rest ? await resolveSquad(ctx, rest) : bound
  if ("error" in target) return { system: target.error }
  const { squad } = target
  // When the argument WAS the Squad name, it is not also a goal.
  const goal = target === bound ? rest : ""

  if (BUSY_STATUSES.has(squad.status)) {
    return {
      system: `**${squad.name}** is already ${squad.status}. Use \`/squad stop\` before starting it again, or \`/squad resume\` if it is paused.`,
    }
  }

  const session = await loadSession(ctx.activeSessionId!)
  const { startSquadRun } = await import("@/lib/ai/agent/team/start-squad-run")
  const result = await startSquadRun({
    squadId: squad.id,
    goal,
    origin: "chat",
    triggeredFrom: { source: "chat" },
    ...(session ? { session } : {}),
  })
  if (!result.started) {
    return { system: `Could not start **${squad.name}**: ${result.reason ?? "dispatch_error"}.` }
  }
  return {
    system: [
      `🚀 **${result.squadName ?? squad.name}** is running.`,
      "",
      goal ? `Objective: ${goal}` : "Running its existing objective.",
      "",
      "Follow-ups in this conversation reach it as steering. `/squad status` for a snapshot, `/squad stop` to end it.",
    ].join("\n"),
  }
}

async function commandControl(
  ctx: SlashContext,
  rest: string,
  verb: "pause" | "resume" | "shutdown"
): Promise<SquadCommandResult> {
  const resolved = await resolveSquad(ctx, rest)
  if ("error" in resolved) return { system: resolved.error }
  const { squad } = resolved
  try {
    const { agentTeamManager } = await import("@/lib/ai/agent/agent-team")
    await agentTeamManager[verb](squad.id)
  } catch (error) {
    const reason = error instanceof Error ? error.message : "dispatch_error"
    return { system: `Could not ${VERB_LABEL[verb]} **${squad.name}**: ${reason}.` }
  }
  return { system: `**${squad.name}** ${VERB_DONE[verb]}.` }
}

async function commandTasks(ctx: SlashContext, rest: string): Promise<SquadCommandResult> {
  const resolved = await resolveSquad(ctx, rest)
  if ("error" in resolved) return { system: resolved.error }
  const { squad } = resolved
  const state = useAgentTeamStore.getState()
  const tasks = Object.values(state.tasks)
    .filter((t) => t.teamId === squad.id)
    .sort((a, b) => a.order - b.order)
  if (tasks.length === 0) {
    return { system: `**${squad.name}** has no tasks on its board yet.` }
  }
  const rows = tasks.map((task) => `- ${taskMark(task)} ${task.title} — ${task.status}`)
  return {
    system: [`🗂️ **${squad.name}** board (${tasks.length} task(s))`, "", ...rows].join("\n"),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Card renderers (hard-coded English, consistent with the /plan and /goal cards)
// ─────────────────────────────────────────────────────────────────────────────

const VERB_LABEL: Record<"pause" | "resume" | "shutdown", string> = {
  pause: "pause",
  resume: "resume",
  shutdown: "stop",
}

const VERB_DONE: Record<"pause" | "resume" | "shutdown", string> = {
  pause: "is paused",
  resume: "is running again",
  shutdown: "has been stopped",
}

function statusDot(status: TeamStatus): string {
  if (LIVE_STATUSES.has(status)) return "🟢"
  if (status === "paused") return "🟡"
  if (status === "failed") return "🔴"
  if (status === "completed") return "✅"
  return "⚪"
}

function taskMark(task: AgentTeamTask): string {
  if (task.status === "completed") return "✅"
  if (task.status === "failed") return "🔴"
  if (task.status === "in_progress" || task.status === "claimed") return "🟢"
  if (task.status === "blocked") return "⛔"
  return "▫️"
}

function usage(): string {
  return [
    "**`/squad`** addresses the Squad running this conversation.",
    "",
    "- `/squad` or `/squad status` for what it is doing right now",
    "- `/squad list` for every Squad in this workspace",
    "- `/squad run [objective]` to start it, optionally reseating the objective",
    "- `/squad pause` / `/squad resume` / `/squad stop`",
    "- `/squad tasks` for its board, in board order",
    "",
    "Every subcommand takes an optional Squad id or name: `/squad status Review Crew`.",
  ].join("\n")
}
