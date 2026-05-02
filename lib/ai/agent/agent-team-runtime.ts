/**
 * Agent Team minimum-viable runtime.
 *
 * Reads a team from the store, sets it to executing, optionally gates on a
 * plan-approval round (driven by `lib/ai/agent/plan-approval-bus.ts`), then
 * dispatches teammates to pending tasks with bounded concurrency. Token
 * usage is aggregated as work completes; the run finishes by writing a
 * `TeamExecutionReport` and flipping the team status to completed / failed
 * / cancelled.
 *
 * This is the smallest sensible runtime — out of scope (deferred):
 * consensus voting, structured-message routing beyond plan-approval,
 * deadlock recovery, automatic retry with backoff, delegation lifecycle,
 * routing-pattern auto-recommendation. Those features keep their types
 * in `types/agent/agent-team.ts` but no engine drives them yet.
 */

import { nanoid } from "nanoid"
import type {
  AgentTeam,
  AgentTeammate,
  AgentTeamTask,
  TeamExecutionReport,
  TeamExecutionCheckpoint,
  TeamExecutionReportSummary,
  TeamStatus,
  TeammateStatus,
  TeamTaskStatus,
} from "@/types/agent/agent-team"
import type { SubAgentTokenUsage } from "@/types/agent/sub-agent"
import { waitForDecision } from "./plan-approval-bus"

/** What a teammate produces when it runs against a single task. */
export interface TeammateTaskResult {
  result: string
  tokenUsage?: SubAgentTokenUsage
  error?: string
}

/** What the lead produces during a planning round. */
export interface LeadPlanResult {
  planText: string
  tokenUsage?: SubAgentTokenUsage
}

/** Minimal slice of the agent-team store the runtime touches. */
export interface AgentTeamStoreLike {
  getTeam: (teamId: string) => AgentTeam | undefined
  getTeammate: (teammateId: string) => AgentTeammate | undefined
  getTeammates: (teamId: string) => AgentTeammate[]
  getTeamTasks: (teamId: string) => AgentTeamTask[]
  setTeamStatus: (teamId: string, status: TeamStatus) => void
  updateTeam: (teamId: string, updates: Partial<AgentTeam>) => void
  setTeammateStatus: (teammateId: string, status: TeammateStatus) => void
  updateTeammate: (teammateId: string, updates: Partial<AgentTeammate>) => void
  setTaskStatus: (taskId: string, status: TeamTaskStatus, result?: string, error?: string) => void
  assignTask: (taskId: string, teammateId: string) => void
  upsertExecutionReport: (teamId: string, report: TeamExecutionReport) => void
}

/** Dependencies the runtime needs. Inject for testability. */
export interface AgentTeamRuntimeDeps {
  store: AgentTeamStoreLike
  /** Run a single teammate against a task end-to-end. */
  runTeammateTask: (params: {
    team: AgentTeam
    teammate: AgentTeammate
    task: AgentTeamTask
    signal: AbortSignal
  }) => Promise<TeammateTaskResult>
  /** Ask the lead to produce a plan. Optional — only invoked when plan-approval is on. */
  runLeadPlanning?: (params: {
    team: AgentTeam
    lead: AgentTeammate
    feedback?: string
    signal: AbortSignal
  }) => Promise<LeadPlanResult>
  /** Clock — pulled out so tests can assert deterministic timestamps. */
  now?: () => Date
}

/** Per-teammate handle; lets external callers pause / shutdown a run. */
const inflightControllers = new Map<string, AbortController>()

export function getInflightController(teamId: string): AbortController | undefined {
  return inflightControllers.get(teamId)
}

/**
 * Strict JSON-fenced-block parser. Returns `null` if the text doesn't
 * carry a single ```json block we can decode. The caller surfaces this
 * as a planning failure (no exception thrown — the `null` shape is part
 * of the contract).
 */
export function parseProposedPlan(
  text: string
): { ok: true; plan: unknown } | { ok: false; reason: string } {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, reason: "empty plan text" }
  }
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i)
  const candidate = fenceMatch ? fenceMatch[1] : text.trim()
  try {
    const parsed: unknown = JSON.parse(candidate ?? "")
    return { ok: true, plan: parsed }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

function addUsage(
  a: SubAgentTokenUsage | undefined,
  b: SubAgentTokenUsage | undefined
): SubAgentTokenUsage {
  const left = a ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  const right = b ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  }
}

function makeCheckpoint(
  type: TeamExecutionCheckpoint["type"],
  summary: string,
  now: () => Date,
  data?: Record<string, unknown>
): TeamExecutionCheckpoint {
  return {
    id: nanoid(),
    type,
    summary,
    timestamp: now(),
    data,
  }
}

/**
 * Run a team end-to-end.
 *
 * Resolves with the final `TeamExecutionReport`. Re-throws on abort. Never
 * leaves the team in `executing` status — every exit path writes either
 * `completed`, `failed`, or `cancelled`.
 */
export async function runTeamLifecycle(
  teamId: string,
  deps: AgentTeamRuntimeDeps,
  externalSignal?: AbortSignal
): Promise<TeamExecutionReport> {
  const now = deps.now ?? (() => new Date())
  const ac = new AbortController()
  if (externalSignal) {
    if (externalSignal.aborted) ac.abort(externalSignal.reason)
    else
      externalSignal.addEventListener("abort", () => ac.abort(externalSignal.reason), {
        once: true,
      })
  }

  const previousController = inflightControllers.get(teamId)
  if (previousController && !previousController.signal.aborted) {
    throw new Error(`Team ${teamId} is already running`)
  }
  inflightControllers.set(teamId, ac)

  const { store } = deps
  const team = store.getTeam(teamId)
  if (!team) {
    inflightControllers.delete(teamId)
    throw new Error(`Team ${teamId} not found`)
  }

  const checkpoints: TeamExecutionCheckpoint[] = []
  const reportId = nanoid()

  const writeReport = (
    status: TeamExecutionReport["status"],
    summary?: TeamExecutionReportSummary
  ): TeamExecutionReport => {
    const report: TeamExecutionReport = {
      id: reportId,
      teamId,
      status,
      checkpoints: [...checkpoints],
      summary,
      createdAt: now(),
      updatedAt: now(),
      completedAt: status === "running" ? undefined : now(),
    }
    store.upsertExecutionReport(teamId, report)
    return report
  }

  try {
    store.setTeamStatus(teamId, "executing")
    store.updateTeam(teamId, { startedAt: now() })

    // Plan-approval gate.
    if (team.config.requirePlanApproval) {
      const lead = store.getTeammate(team.leadId)
      if (!lead) throw new Error("Lead teammate not found — cannot plan")
      if (!deps.runLeadPlanning) {
        throw new Error("requirePlanApproval=true but no runLeadPlanning dep was provided")
      }
      const maxRevisions = Math.max(1, team.config.maxPlanRevisions ?? 1)
      let approved = false
      let feedback: string | undefined

      for (let revision = 0; revision < maxRevisions; revision++) {
        if (ac.signal.aborted) break
        store.setTeammateStatus(lead.id, "planning")
        const planning = await deps.runLeadPlanning({ team, lead, feedback, signal: ac.signal })
        if (planning.tokenUsage) {
          store.updateTeammate(lead.id, {
            tokenUsage: addUsage(lead.tokenUsage, planning.tokenUsage),
          })
        }
        store.updateTeammate(lead.id, {
          proposedPlan: planning.planText,
        })
        store.setTeammateStatus(lead.id, "awaiting_approval")
        checkpoints.push(
          makeCheckpoint(
            "approval_requested",
            `Plan revision ${revision + 1} awaiting approval`,
            now
          )
        )

        const decision = await waitForDecision(teamId, ac.signal)
        checkpoints.push(
          makeCheckpoint(
            "approval_resolved",
            `Plan revision ${revision + 1} ${decision.outcome}`,
            now,
            { feedback: decision.feedback }
          )
        )
        if (decision.outcome === "approve") {
          approved = true
          break
        }
        feedback = decision.feedback
        store.updateTeammate(lead.id, {
          planFeedback: feedback,
        })
      }

      if (!approved) {
        store.setTeammateStatus(lead.id, "failed")
        store.setTeamStatus(teamId, "failed")
        store.updateTeam(teamId, {
          error: "Plan rejected after max revisions",
          completedAt: now(),
        })
        return writeReport("failed", emptySummary())
      }
    }

    // Dispatch tasks.
    const allTeammates = store.getTeammates(teamId)
    const workers = allTeammates.filter((t) => t.role === "teammate")
    if (workers.length === 0) {
      store.setTeamStatus(teamId, "failed")
      store.updateTeam(teamId, {
        error: "No teammates available to dispatch",
        completedAt: now(),
      })
      return writeReport("failed", emptySummary())
    }

    const tasks = store.getTeamTasks(teamId)
    const queue = tasks.filter((t) => t.status === "pending").sort((a, b) => a.order - b.order)

    const concurrency = Math.max(1, team.config.maxConcurrentTeammates ?? 1)
    const inflight = new Set<Promise<void>>()
    let teammateRotation = 0
    let totalTokens = addUsage(undefined, undefined) // zero baseline

    const runOne = async (task: AgentTeamTask) => {
      if (ac.signal.aborted) return
      const teammate = workers[teammateRotation % workers.length]!
      teammateRotation++
      store.assignTask(task.id, teammate.id)
      store.setTaskStatus(task.id, "in_progress")
      store.setTeammateStatus(teammate.id, "executing")
      try {
        const outcome = await deps.runTeammateTask({
          team,
          teammate,
          task,
          signal: ac.signal,
        })
        if (outcome.tokenUsage) {
          totalTokens = addUsage(totalTokens, outcome.tokenUsage)
          store.updateTeammate(teammate.id, {
            tokenUsage: addUsage(teammate.tokenUsage, outcome.tokenUsage),
          })
        }
        if (outcome.error) {
          store.setTaskStatus(task.id, "failed", undefined, outcome.error)
          store.setTeammateStatus(teammate.id, "failed")
          checkpoints.push(
            makeCheckpoint("task_failed", `Task "${task.title}" failed`, now, {
              taskId: task.id,
              teammateId: teammate.id,
              error: outcome.error,
            })
          )
        } else {
          store.setTaskStatus(task.id, "completed", outcome.result)
          store.setTeammateStatus(teammate.id, "completed")
          checkpoints.push(
            makeCheckpoint("task_completed", `Task "${task.title}" completed`, now, {
              taskId: task.id,
              teammateId: teammate.id,
            })
          )
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        store.setTaskStatus(task.id, "failed", undefined, reason)
        store.setTeammateStatus(teammate.id, "failed")
        checkpoints.push(
          makeCheckpoint("task_failed", `Task "${task.title}" failed`, now, {
            taskId: task.id,
            teammateId: teammate.id,
            error: reason,
          })
        )
      }
    }

    for (const task of queue) {
      if (ac.signal.aborted) break
      while (inflight.size >= concurrency) {
        await Promise.race(inflight)
      }
      const p = runOne(task)
      inflight.add(p)
      p.finally(() => inflight.delete(p))
    }
    await Promise.all([...inflight])

    if (ac.signal.aborted) {
      store.setTeamStatus(teamId, "cancelled")
      store.updateTeam(teamId, { completedAt: now() })
      return writeReport("cancelled", buildSummary(store.getTeamTasks(teamId), totalTokens))
    }

    const finalTasks = store.getTeamTasks(teamId)
    const summary = buildSummary(finalTasks, totalTokens)
    const failed = summary.failedTasks
    const completed = summary.completedTasks
    const finalStatus: TeamStatus = failed > 0 && completed === 0 ? "failed" : "completed"
    store.setTeamStatus(teamId, finalStatus)
    store.updateTeam(teamId, {
      completedAt: now(),
      progress: 100,
      totalTokenUsage: totalTokens,
    })
    return writeReport(finalStatus === "completed" ? "completed" : "failed", summary)
  } catch (err) {
    if (ac.signal.aborted) {
      store.setTeamStatus(teamId, "cancelled")
      store.updateTeam(teamId, { completedAt: now() })
      return writeReport("cancelled", emptySummary())
    }
    const reason = err instanceof Error ? err.message : String(err)
    store.setTeamStatus(teamId, "failed")
    store.updateTeam(teamId, { error: reason, completedAt: now() })
    return writeReport("failed", emptySummary())
  } finally {
    inflightControllers.delete(teamId)
  }
}

function emptySummary(): TeamExecutionReportSummary {
  return {
    completedTasks: 0,
    failedTasks: 0,
    cancelledTasks: 0,
    blockedTasks: 0,
    delegatedTasks: 0,
    approvalsRequested: 0,
    retries: 0,
    totalTokens: 0,
    nextActions: [],
  }
}

function buildSummary(
  tasks: AgentTeamTask[],
  totalTokens: SubAgentTokenUsage
): TeamExecutionReportSummary {
  return {
    completedTasks: tasks.filter((t) => t.status === "completed").length,
    failedTasks: tasks.filter((t) => t.status === "failed").length,
    cancelledTasks: tasks.filter((t) => t.status === "cancelled").length,
    blockedTasks: tasks.filter((t) => t.status === "blocked").length,
    delegatedTasks: 0,
    approvalsRequested: 0,
    retries: 0,
    totalTokens: totalTokens.totalTokens,
    nextActions: [],
  }
}

/** Cancel a running team. Returns true if a controller was found + aborted. */
export function abortTeam(teamId: string, reason?: unknown): boolean {
  const ctrl = inflightControllers.get(teamId)
  if (!ctrl) return false
  ctrl.abort(reason ?? new Error("Aborted by caller"))
  return true
}

/** Test utility — drop in-flight controllers without aborting. */
export function __resetInflightForTesting(): void {
  inflightControllers.clear()
}
