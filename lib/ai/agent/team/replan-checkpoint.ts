/**
 * Stage-checkpoint adaptive re-planning (model-in-the-loop). Runs BETWEEN waves
 * of a team run: the lead reviews the just-completed wave's blackboard results
 * and the remaining plan, then returns a {@link ReplanDecision} that may inject,
 * cancel, reorder, or finish the remaining work — or continue unchanged.
 *
 * Reuse-first:
 *   - `dispatchStructured` for the schema-validated lead call (one retry).
 *   - `readDependencyResults` for the just-ran results (off the blackboard).
 *   - `awaitReplanApproval` (same approval-bus gate as deadlock/budget) when the
 *     team requires HITL approval before applying.
 *   - `storeWriter.{addTask,updateTask,setTaskStatus}` to reflect changes in the
 *     store (task panel) and feed the next wave.
 *
 * Fail-open everywhere: any lead/dispatch failure resolves to "continue", so an
 * LLM hiccup never blocks or corrupts a run.
 */
import type { AgentTeamTask } from "@/types/agent/agent-team"
import type { TeamRunContext } from "./team-run-context"
import { readDependencyResults } from "./shared-memory-orchestrator"
import { dispatchStructured } from "./structured-dispatch"
import {
  replanDecisionSchema,
  continueDecision,
  REPLAN_SCHEMA_HINT,
  type ReplanDecision,
} from "./replan-schema"
import { awaitReplanApproval, type ReplanGateOutcome } from "./replan-gate"

const DEFAULT_MAX_INJECTED = 5

export interface ReplanCheckpointDeps {
  teamCtx: TeamRunContext
  runId: string
  /** Task ids executed in the wave just completed (for the lead's review). */
  justRanTaskIds: string[]
  /** Pending tasks not yet executed — the lead may revise these. */
  remaining: AgentTeamTask[]
  signal?: AbortSignal
  /** Injectable lead call; defaults to `dispatchStructured`. Returns a decision. */
  dispatch?: (input: {
    teamCtx: TeamRunContext
    prompt: string
    signal?: AbortSignal
  }) => Promise<ReplanDecision>
  /** Injectable approval gate; defaults to `awaitReplanApproval`. */
  gate?: (decision: ReplanDecision) => Promise<ReplanGateOutcome>
}

export interface ReplanCheckpointOutcome {
  /** The remaining plan after the decision was applied. */
  remaining: AgentTeamTask[]
  /** True when the lead chose to finish early (remaining cleared). */
  finish: boolean
  /** The decision that was applied (post-approval edit, if any). */
  decision: ReplanDecision
}

function buildPrompt(
  teamCtx: TeamRunContext,
  justRanTaskIds: string[],
  remaining: AgentTeamTask[]
) {
  const results = readDependencyResults(teamCtx.teamId, justRanTaskIds)
  const resultLines =
    results.length > 0
      ? results.map((r) => `- ${r.taskTitle ?? r.taskId}: ${r.value.slice(0, 600)}`).join("\n")
      : "(no captured output)"
  const remainingLines =
    remaining.length > 0
      ? remaining.map((t) => `- [${t.id}] ${t.title}: ${t.description}`).join("\n")
      : "(none)"
  return [
    `You are the lead of the agent team "${teamCtx.team.name}".`,
    `Objective: ${teamCtx.team.task ?? teamCtx.team.description ?? "(unspecified)"}`,
    "",
    "Results from the wave that just completed:",
    resultLines,
    "",
    "Remaining planned tasks:",
    remainingLines,
    "",
    "Decide how to proceed. Choose exactly one action:",
    '- "continue": keep the remaining plan as-is.',
    '- "inject": add new follow-up tasks (set newTasks).',
    '- "cancel": skip some remaining tasks that are now unnecessary (set cancelTaskIds).',
    '- "reorder": change the order of the remaining tasks (set reorderTaskIds to a permutation of their ids).',
    '- "finish": the objective is met; stop early.',
    "Be conservative — prefer continue unless the results clearly justify a change.",
  ].join("\n")
}

/** Resolve a new-task `dependsOn` entry to a real task id, or null to drop it. */
function resolveDep(
  dep: string,
  knownIds: Set<string>,
  titleToNewId: Map<string, string>
): string | null {
  if (knownIds.has(dep)) return dep
  const byTitle = titleToNewId.get(dep)
  return byTitle ?? null
}

export async function runReplanCheckpoint(
  deps: ReplanCheckpointDeps
): Promise<ReplanCheckpointOutcome> {
  const { teamCtx, runId, justRanTaskIds, signal } = deps
  const remaining = [...deps.remaining]
  const cfg = teamCtx.team.config.adaptiveReplan ?? {}
  const maxInjected = cfg.maxInjectedTasksPerCheckpoint ?? DEFAULT_MAX_INJECTED

  // ── 1. Ask the lead (fail-open to continue) ──
  const dispatch =
    deps.dispatch ??
    (async ({ teamCtx: ctx, prompt, signal: sig }) => {
      const r = await dispatchStructured(
        ctx,
        { taskId: `replan:${runId}`, prompt, ...(sig ? { signal: sig } : {}) },
        replanDecisionSchema,
        { schemaHint: REPLAN_SCHEMA_HINT }
      )
      return r.value
    })

  let decision: ReplanDecision
  try {
    decision = await dispatch({
      teamCtx,
      prompt: buildPrompt(teamCtx, justRanTaskIds, remaining),
      ...(signal ? { signal } : {}),
    })
  } catch {
    return {
      remaining,
      finish: false,
      decision: continueDecision("Lead unavailable — continuing."),
    }
  }

  if (decision.action === "continue") {
    return { remaining, finish: false, decision }
  }

  // ── 2. Optional HITL approval ──
  if (cfg.requireApproval) {
    const gate =
      deps.gate ??
      ((d: ReplanDecision) =>
        awaitReplanApproval({
          notifier: teamCtx.notifier,
          runId,
          teamId: teamCtx.teamId,
          decision: d,
          ...(signal ? { signal } : {}),
        }))
    const outcome = await gate(decision)
    if (!outcome.approved) {
      return { remaining, finish: false, decision: continueDecision("Operator declined re-plan.") }
    }
    decision = outcome.decision
  }

  // ── 3. Apply the (possibly edited) decision ──
  teamCtx.notifier.notify({
    level: "info",
    title: `Re-plan: ${decision.action}`,
    body: decision.reasoning,
    runId,
    teamId: teamCtx.teamId,
  })

  const knownIds = new Set<string>([...remaining.map((t) => t.id), ...justRanTaskIds])
  const rosterIds = new Set(teamCtx.team.teammateIds)

  switch (decision.action) {
    case "inject": {
      const titleToNewId = new Map<string, string>()
      for (const nt of decision.newTasks.slice(0, maxInjected)) {
        if (!teamCtx.storeWriter.addTask) break // can't materialize without an id sink
        const dependencies = nt.dependsOn
          .map((d) => resolveDep(d, knownIds, titleToNewId))
          .filter((d): d is string => d !== null)
        const created = teamCtx.storeWriter.addTask({
          teamId: teamCtx.teamId,
          title: nt.title,
          description: nt.description,
          ...(nt.expectedOutput ? { expectedOutput: nt.expectedOutput } : {}),
          ...(nt.assignedTo && rosterIds.has(nt.assignedTo) ? { assignedTo: nt.assignedTo } : {}),
          dependencies,
        })
        titleToNewId.set(nt.title, created.id)
        knownIds.add(created.id)
        remaining.push(created)
      }
      return { remaining, finish: false, decision }
    }
    case "cancel": {
      const toCancel = new Set(decision.cancelTaskIds)
      const kept: AgentTeamTask[] = []
      for (const t of remaining) {
        if (toCancel.has(t.id)) {
          teamCtx.storeWriter.setTaskStatus(t.id, "cancelled")
        } else {
          kept.push(t)
        }
      }
      return { remaining: kept, finish: false, decision }
    }
    case "reorder": {
      const order = decision.reorderTaskIds
      const byId = new Map(remaining.map((t) => [t.id, t]))
      const isPermutation = order.length === remaining.length && order.every((id) => byId.has(id))
      if (!isPermutation) return { remaining, finish: false, decision }
      const reordered = order.map((id, i) => {
        teamCtx.storeWriter.updateTask?.(id, { order: i })
        return byId.get(id)!
      })
      return { remaining: reordered, finish: false, decision }
    }
    case "finish": {
      for (const t of remaining) teamCtx.storeWriter.setTaskStatus(t.id, "cancelled")
      return { remaining: [], finish: true, decision }
    }
    default:
      return { remaining, finish: false, decision }
  }
}
