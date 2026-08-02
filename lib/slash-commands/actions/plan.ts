// Action handler for the `/plan` slash command family (ADR-0045).
//
// This is the surface that makes every `PlanSource` reachable from chat. Before
// it, `exit_plan_mode` was the only source with a live producer: the planner
// LLM (`decomposeIntoPlan`) and both projections (`planInputFromTeam` /
// `planInputFromGoal`) were fully built, tested — and called by nothing.
//
// Surface (6 subcommands + aliases):
//   /plan                             — status card for the session's open plan
//   /plan <objective>                 — planner LLM decomposition  (planner_llm)
//   /plan new <title> | <s1> | <s2>   — hand-authored plan         (manual)
//   /plan from-goal                   — project the open goal      (goal_projection)
//   /plan from-team                   — project the team task DAG  (team_projection)
//   /plan to-team                     — mirror the plan back into team tasks
//   /plan cancel                      — cancel the open plan (alias: stop, clear)
//
// Every branch funnels into `PlanRuntime.createPlan`, so the one-open-plan-per-
// session invariant, the `plan_created` audit event and the approval dock all
// behave identically no matter which source produced the plan.
//
// Streaming guard mirrors `/goal`: mutating the plan mid-turn would race the
// in-session driver reading the same row.

import type { SlashContext } from "../builtin"
import { useSettingsStore } from "@/stores/settings"
import { getPlanRuntime } from "@/lib/agent/plan/runtime"
import { loadPlanConfigDefaults } from "@/lib/agent/plan/plan-settings"
import {
  planInputFromGoal,
  planInputFromTeam,
  teamTaskInputsFromPlan,
} from "@/lib/agent/plan/projections"
import { decomposeIntoPlan } from "@/lib/agent/plan/planner"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { redactText } from "@cognia/redact"
import { ensureSoloTeam, soloTeamId } from "@/lib/agent/plan-mode-bridge"
import { getGoalRuntime } from "@/lib/goal/runtime"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentPlan, CreatePlanInput, CreatePlanStepInput } from "@/types/agent/plan"

/** Max characters kept from a hand-authored step / plan title. */
const MAX_TITLE_LEN = 200
const MAX_PLAN_TITLE_LEN = 120

/** Result handed back to the composer; `system` is pushed as a system message. */
export interface PlanCommandResult {
  system: string
}

/**
 * Subcommand dispatcher. Always returns a result (never falls through to a
 * custom `.claude/commands/plan-*.md`) because the default branch consumes the
 * whole argument string as a planning objective.
 */
export async function dispatchPlanSubcommand(ctx: SlashContext): Promise<PlanCommandResult> {
  if (!ctx.activeSessionId) {
    return { system: "Start a chat session first — `/plan` operates inside an active session." }
  }
  if (ctx.chatStatus === "streaming") {
    return {
      system:
        "The current turn is still streaming — `/plan` waits for the response to finish before changing the session's plan.",
    }
  }

  const trimmed = (ctx.args ?? "").trim()
  const space = trimmed.search(/\s/)
  const head = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase()
  const rest = space === -1 ? "" : trimmed.slice(space + 1).trim()

  if (!trimmed) return await commandStatus(ctx)
  switch (head) {
    case "status":
      return await commandStatus(ctx)
    case "new":
      return await commandNew(ctx, rest)
    case "from-goal":
    case "goal":
      return await commandFromGoal(ctx)
    case "from-team":
    case "team":
      return await commandFromTeam(ctx)
    case "to-team":
      return await commandToTeam(ctx)
    case "cancel":
    case "stop":
    case "clear":
      return await commandCancel(ctx)
    default:
      // Everything else is the objective — `/plan migrate the auth module`.
      return await commandDecompose(ctx, trimmed)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Subcommand implementations
// ─────────────────────────────────────────────────────────────────────────────

async function commandStatus(ctx: SlashContext): Promise<PlanCommandResult> {
  const plan = await getPlanRuntime().getOpenPlanForSession(ctx.activeSessionId!)
  if (!plan) {
    return {
      system: [
        "No open plan in this session. Start one with:",
        "",
        "- `/plan <objective>` — let the planner model decompose it",
        "- `/plan new <title> | <step> | <step>` — write the steps yourself",
        "- `/plan from-goal` / `/plan from-team` — reuse an existing decomposition",
      ].join("\n"),
    }
  }
  return { system: renderStatusCard(plan) }
}

/** `/plan <objective>` — planner LLM decomposition (`source: "planner_llm"`). */
async function commandDecompose(ctx: SlashContext, objective: string): Promise<PlanCommandResult> {
  const sessionId = ctx.activeSessionId!
  const session = await loadSession(sessionId)
  const appSettings = useSettingsStore.getState().settings ?? null
  const client = buildUtilityLlmClient({
    session: session ?? null,
    appSettings,
    featureId: "plan-decompose",
  })
  if (!client) {
    return {
      system:
        "⚠️ **No planner model available.** Add a provider API key in Settings → Providers so `/plan <objective>` can decompose it. You can still write the plan yourself with `/plan new <title> | <step> | <step>`.",
    }
  }

  // PII red-line: the objective is raw user text heading straight for a model,
  // so it is redacted before the call — the same contract `/goal` applies to
  // `safeObjective`, and what `decomposeIntoPlan` documents it expects.
  const { redacted } = redactText(objective)
  const input = await decomposeIntoPlan({
    objective: redacted,
    sessionId,
    ...(session?.characterId ? { characterId: session.characterId } : {}),
    client,
  })
  if (!input) {
    return {
      system:
        "The planner model returned no usable steps. Try a more concrete objective, or write the plan yourself with `/plan new <title> | <step> | <step>`.",
    }
  }
  return { system: renderCreatedCard(await createWithDefaults(input), "planner") }
}

/** `/plan new <title> | <step> | <step>` — hand-authored (`source: "manual"`). */
async function commandNew(ctx: SlashContext, raw: string): Promise<PlanCommandResult> {
  const segments = raw
    .split(/\s*\|\s*|\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (segments.length < 2) {
    return {
      system:
        "Usage: `/plan new <title> | <step 1> | <step 2> …` — the first segment is the plan title, each following segment is one step.",
    }
  }
  const sessionId = ctx.activeSessionId!
  const session = await loadSession(sessionId)
  const [title, ...stepTitles] = segments
  const steps: CreatePlanStepInput[] = stepTitles.map((t, i) => ({
    title: t.slice(0, MAX_TITLE_LEN),
    kind: "agent_turn",
    ...(i > 0 ? { dependsOn: [i - 1] } : {}),
  }))
  const plan = await createWithDefaults({
    sessionId,
    ...(session?.characterId ? { characterId: session.characterId } : {}),
    title: title.slice(0, MAX_PLAN_TITLE_LEN),
    source: "manual",
    executionMode: "auto",
    steps,
  })
  return { system: renderCreatedCard(plan, "manual") }
}

/** `/plan from-goal` — project the session's open goal (`goal_projection`). */
async function commandFromGoal(ctx: SlashContext): Promise<PlanCommandResult> {
  const sessionId = ctx.activeSessionId!
  const goal = await getGoalRuntime().getOpenGoalForSession(sessionId)
  if (!goal) {
    return { system: "No open goal in this session — start one with `/goal <objective>` first." }
  }
  // `planInputFromGoal` reads `safeObjective` / `subgoal.text`, which the goal
  // runtime already redacted, so no raw PII crosses into the plan.
  const plan = await createWithDefaults(planInputFromGoal(goal, { sessionId }))
  return { system: renderCreatedCard(plan, "goal") }
}

/** `/plan from-team` — project the session's team task DAG (`team_projection`). */
async function commandFromTeam(ctx: SlashContext): Promise<PlanCommandResult> {
  const sessionId = ctx.activeSessionId!
  const session = await loadSession(sessionId)
  // A team chat uses its own team; a solo chat uses the synthetic `solo:<id>`
  // team the plan-mode bridge fills from TodoWrite / TaskCreate tool calls.
  const teamId = session?.teamId ?? soloTeamId(sessionId)
  const state = useAgentTeamStore.getState()
  const team = state.teams[teamId]
  if (!team) {
    return {
      system:
        "No team tasks in this session yet. Run a plan-mode turn (so the agent emits its todo list) or open a team chat, then retry `/plan from-team`.",
    }
  }
  const tasks = Object.values(state.tasks)
    .filter((t) => t.teamId === teamId)
    .sort((a, b) => a.order - b.order)
  if (tasks.length === 0) {
    return { system: `Team "${team.name}" has no tasks to project into a plan.` }
  }
  const plan = await createWithDefaults(planInputFromTeam(team, tasks, { sessionId }))
  return { system: renderCreatedCard(plan, "team") }
}

/**
 * `/plan to-team` — the reverse projection: mirror the open plan's steps into
 * the session's team so the workspace tasks panel tracks them.
 *
 * Uses `upsertTask` rather than `createTask` on purpose: `teamTaskInputsFromPlan`
 * reuses each step's id so the dependency DAG survives the round trip, and only
 * upsert lets us keep those ids. Re-running it therefore updates the same rows
 * instead of duplicating them.
 */
async function commandToTeam(ctx: SlashContext): Promise<PlanCommandResult> {
  const sessionId = ctx.activeSessionId!
  const plan = await getPlanRuntime().getOpenPlanForSession(sessionId)
  if (!plan) return { system: "No open plan to project — create one with `/plan <objective>`." }
  if (plan.steps.length === 0) return { system: `Plan "${plan.title}" has no steps to project.` }

  const session = await loadSession(sessionId)
  const teamId = session?.teamId ?? soloTeamId(sessionId)
  ensureSoloTeam(teamId)
  const store = useAgentTeamStore.getState()
  if (!store.teams[teamId]) {
    return { system: "Could not resolve a team for this session." }
  }
  const rows = teamTaskInputsFromPlan(plan)
  const now = new Date()
  rows.forEach((row, i) => {
    store.upsertTask({
      id: row.id,
      teamId,
      title: row.title,
      description: row.description,
      status: "pending",
      priority: "normal",
      dependencies: row.dependencies,
      tags: ["plan"],
      order: i,
      createdAt: now,
    })
  })
  return {
    system: `📋 Projected ${rows.length} step(s) of "${plan.title}" into the team task list — dependencies preserved.`,
  }
}

/** `/plan cancel` — cancel the session's open plan. */
async function commandCancel(ctx: SlashContext): Promise<PlanCommandResult> {
  const runtime = getPlanRuntime()
  const plan = await runtime.getOpenPlanForSession(ctx.activeSessionId!)
  if (!plan) return { system: "No open plan to cancel." }
  await runtime.cancelPlan(plan.id)
  return {
    system: `Plan cancelled — "${plan.title}" (${plan.completedSteps}/${plan.totalSteps} steps done).`,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create the plan with the user's plan defaults merged in, unless the caller's
 * projection already pinned a config. Keeps `/plan` consistent with the
 * ExitPlanMode capture path (both honour Settings → Agent runtime → Plan mode).
 */
async function createWithDefaults(input: CreatePlanInput): Promise<AgentPlan> {
  const defaults = await loadPlanConfigDefaults()
  return getPlanRuntime().createPlan({
    ...input,
    ...(defaults ? { config: { ...defaults, ...input.config } } : {}),
  })
}

/** Best-effort session read (character id + team id for the producers above). */
async function loadSession(sessionId: string) {
  try {
    const { getSession } = await import("@/lib/db/sessions")
    return await getSession(sessionId)
  } catch {
    return undefined
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Card renderers (hard-coded English, consistent with the /goal cards)
// ─────────────────────────────────────────────────────────────────────────────

type CreatedVia = "planner" | "manual" | "goal" | "team"

const VIA_LABEL: Record<CreatedVia, string> = {
  planner: "decomposed by the planner model",
  manual: "hand-authored",
  goal: "projected from the active goal",
  team: "projected from the team task list",
}

function renderCreatedCard(plan: AgentPlan, via: CreatedVia): string {
  const steps = [...plan.steps]
    .sort((a, b) => a.order - b.order)
    .map((s, i) => `${i + 1}. ${s.title}`)
  const gate =
    plan.status === "awaiting_approval"
      ? "Review it above the composer — approve to execute, or refine it first."
      : "Approval is off for plans, so it is already approved."
  return [
    `📋 **Plan created** — ${plan.totalSteps} step(s), ${VIA_LABEL[via]}.`,
    "",
    `**${plan.title}**`,
    "",
    ...steps,
    "",
    gate,
  ].join("\n")
}

function renderStatusCard(plan: AgentPlan): string {
  const ordered = [...plan.steps].sort((a, b) => a.order - b.order)
  const lines = [
    `📋 **${statusEmoji(plan.status)} ${plan.status.toUpperCase()}** — ${plan.completedSteps}/${plan.totalSteps} steps · ${plan.executionMode} · source \`${plan.source}\``,
    "",
    `**${plan.title}**`,
    "",
  ]
  for (const step of ordered) {
    lines.push(`${stepGlyph(step.status)} ${step.title}`)
  }
  lines.push("", "Cancel with `/plan cancel`.")
  return lines.join("\n")
}

function statusEmoji(status: AgentPlan["status"]): string {
  switch (status) {
    case "executing":
      return "🟢"
    case "paused":
      return "⏸️"
    case "completed":
      return "✅"
    case "failed":
      return "🛑"
    case "cancelled":
      return "⏹️"
    case "awaiting_approval":
      return "🕐"
    default:
      return "•"
  }
}

function stepGlyph(status: AgentPlan["steps"][number]["status"]): string {
  switch (status) {
    case "completed":
      return "- [x]"
    case "in_progress":
      return "- [~]"
    case "failed":
    case "blocked":
      return "- [!]"
    case "skipped":
      return "- [-]"
    default:
      return "- [ ]"
  }
}
