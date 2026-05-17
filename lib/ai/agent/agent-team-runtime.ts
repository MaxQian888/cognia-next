/**
 * Agent Team runtime — F-path synthesizer (ADR-0022).
 *
 * Translates a team + its tasks into a synthesized VisualWorkflow, registers
 * per-run shared state (TeammatePool / BudgetGuard / TeamNotifier / dynamic
 * controllers) in the TeamRunContext WeakMap, and delegates execution to
 * runWorkflow. Plan-approval, deadlock, budget, and teammate-fix gates stay
 * in this synthesizer — they're team-specific and don't leak to other
 * workflow consumers.
 *
 * Per ADR-0022 §3.8.
 */

import { nanoid } from "nanoid"
import type { AgentTeam, AgentTeammate, AgentTeamTask } from "@/types/agent/agent-team"
import type { SubAgentTokenUsage } from "@/types/agent/sub-agent"
import { approve as approveBus, reject as rejectBus } from "@/lib/runtime/approval-bus"
import { waitForDecision } from "@/lib/runtime/approval-bus"
import { runWorkflow } from "@/lib/workflow/runtime/orchestrator"
import { createConcurrencyController } from "@/lib/workflow/runtime/concurrency-controller"
import { createModelPreferenceController } from "@/lib/workflow/runtime/model-preference-controller"
import { createTeammatePool } from "./team/teammate-pool"
import { createBudgetGuard } from "./team/budget-guard"
import { createTeamNotifier, type TeamNotifierDeps } from "./team/team-notifier"
import {
  registerTeamRunContext,
  unregisterTeamRunContext,
  type TeamStoreWriter,
} from "./team/team-run-context"
import { synthesizeTeamWorkflow } from "./team/synthesize-workflow"

/** Planning result kept compatible with the legacy LeadPlanResult shape. */
export interface LeadPlanResult {
  planText: string
  tokenUsage?: SubAgentTokenUsage
}

export interface RunTeamLifecycleDeps {
  storeReader: {
    getTeam(teamId: string): AgentTeam | undefined
    getTeammates(teamId: string): AgentTeammate[]
    getTeamTasks(teamId: string): AgentTeamTask[]
  }
  storeWriter: TeamStoreWriter
  /** Only called when team.config.requirePlanApproval is true. */
  runLeadPlanning?: (params: {
    team: AgentTeam
    lead: AgentTeammate
    feedback?: string
    signal: AbortSignal
  }) => Promise<LeadPlanResult>
  /** Wired by buildAgentTeamRuntimeDeps in production. */
  notifierDeps?: TeamNotifierDeps
}

export interface RunTeamLifecycleResult {
  /** Matches the workflowRuns row id; UI navigation key. */
  runId: string
  status: "completed" | "failed" | "cancelled"
  reason?: string
}

const inflightControllers = new Map<string, AbortController>()

export function getInflightController(teamId: string): AbortController | undefined {
  return inflightControllers.get(teamId)
}

/** Strict JSON-fenced-block parser preserved from the legacy runtime. */
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

export async function runTeamLifecycle(
  teamId: string,
  deps: RunTeamLifecycleDeps,
  externalSignal?: AbortSignal
): Promise<RunTeamLifecycleResult> {
  const previous = inflightControllers.get(teamId)
  if (previous && !previous.signal.aborted) {
    throw new Error(`Team ${teamId} is already running`)
  }
  const ac = new AbortController()
  if (externalSignal) {
    if (externalSignal.aborted) ac.abort(externalSignal.reason)
    else
      externalSignal.addEventListener("abort", () => ac.abort(externalSignal.reason), {
        once: true,
      })
  }
  inflightControllers.set(teamId, ac)

  try {
    if (ac.signal.aborted) {
      return { runId: "", status: "cancelled", reason: "Aborted before start" }
    }
    const team = deps.storeReader.getTeam(teamId)
    if (!team) {
      return { runId: "", status: "failed", reason: `Team ${teamId} not found` }
    }
    const allMembers = deps.storeReader.getTeammates(teamId)
    const workers = allMembers.filter((m) => m.role === "teammate")
    if (workers.length === 0) {
      return { runId: "", status: "failed", reason: "No teammates available" }
    }
    const tasks = deps.storeReader.getTeamTasks(teamId)
    if (tasks.length === 0) {
      return { runId: "", status: "failed", reason: "No tasks to dispatch" }
    }

    // ── Plan-approval gate (synthesizer-local; never enters workflow) ──
    if (team.config.requirePlanApproval) {
      const lead = allMembers.find((m) => m.id === team.leadId)
      if (!lead) {
        return { runId: "", status: "failed", reason: "Lead teammate not found" }
      }
      if (!deps.runLeadPlanning) {
        return {
          runId: "",
          status: "failed",
          reason: "requirePlanApproval=true but runLeadPlanning dep not provided",
        }
      }
      const maxRev = Math.max(1, team.config.maxPlanRevisions ?? 1)
      let approved = false
      let feedback: string | undefined
      for (let i = 0; i < maxRev; i++) {
        if (ac.signal.aborted) break
        await deps.runLeadPlanning({ team, lead, feedback, signal: ac.signal })
        const decision = await waitForDecision(
          { scope: "agent-team", id: teamId },
          ac.signal
        ).catch(() => ({ outcome: "reject" as const, feedback: "aborted" }))
        if (decision.outcome === "approve") {
          approved = true
          break
        }
        feedback = decision.feedback
      }
      if (!approved) {
        return {
          runId: "",
          status: ac.signal.aborted ? "cancelled" : "failed",
          reason: ac.signal.aborted
            ? "Aborted during plan approval"
            : "Plan rejected after max revisions",
        }
      }
    }

    // ── Build per-run shared state ──
    const runId = `run_team_${nanoid(12)}`
    const concurrency = createConcurrencyController(team.config.maxConcurrentTeammates ?? 5)
    const modelPref = createModelPreferenceController()
    const notifier = createTeamNotifier({ runId, teamId }, deps.notifierDeps)
    const pool = createTeammatePool({ teammates: workers })
    const budget = createBudgetGuard({
      runId,
      limit: team.config.tokenBudget ?? 0,
      onCritical: team.config.governancePolicy?.budget?.onCritical ?? "notify",
      notifier,
      concurrencyCtrl: concurrency,
      modelCtrl: modelPref,
    })

    // ── Wire HITL gate subscriptions ──
    const subs: Array<() => void> = []
    let deadlockResolverActive = false

    subs.push(
      pool.onAllUnavailable(() => {
        if (ac.signal.aborted || deadlockResolverActive) return
        deadlockResolverActive = true
        notifier.notify({
          level: "critical",
          title: "All teammates unavailable",
          body: "Run paused awaiting operator decision.",
          runId,
          teamId,
          openApproval: { scope: "agent-team-deadlock", id: runId },
          dedupeKey: `deadlock:${runId}`,
        })
        concurrency.reduceTo(0)
        void waitForDecision({ scope: "agent-team-deadlock", id: runId }, ac.signal)
          .then((decision) => {
            if (decision.outcome === "approve") {
              pool.forceUnquarantine(
                (decision.plan as { teammateIds?: string[]; resetAll?: boolean }) ?? {
                  resetAll: true,
                }
              )
            } else {
              ac.abort(new Error("Operator aborted on deadlock"))
            }
          })
          .catch(() => {
            // signal aborted while waiting — no-op
          })
          .finally(() => {
            deadlockResolverActive = false
          })
      })
    )

    // Per ADR-0022 §2.2 / §4.6. Non-blocking teammate-fix gate: the run
    // continues on the remaining teammates; the user can rejoin the
    // disqualified one (or skip permanently) via the modal.
    subs.push(
      pool.onTeammateDisqualified((teammateId, reason) => {
        if (ac.signal.aborted) return
        const tm = workers.find((w) => w.id === teammateId)
        notifier.notify({
          level: "critical",
          title: `Teammate disqualified: ${tm?.name ?? teammateId}`,
          body: `Reason: ${reason}. Fix configuration and rejoin, or skip.`,
          runId,
          teamId,
          openApproval: {
            scope: "agent-team-teammate-fix",
            id: `${runId}:${teammateId}`,
          },
          dedupeKey: `teammate-fix:${runId}:${teammateId}`,
        })
        void waitForDecision(
          { scope: "agent-team-teammate-fix", id: `${runId}:${teammateId}` },
          ac.signal
        )
          .then((decision) => {
            if (decision.outcome === "approve") {
              const action = (decision.plan as { action?: "rejoin" | "skip_permanently" })?.action
              if (action === "rejoin") pool.rejoin(teammateId)
            }
            // reject: leave disqualified; run keeps going on the rest.
          })
          .catch(() => {
            // signal aborted while waiting — no-op
          })
      })
    )

    let budgetResolverActive = false
    subs.push(
      budget.on("pause_for_review", () => {
        if (ac.signal.aborted || budgetResolverActive) return
        budgetResolverActive = true
        concurrency.reduceTo(0)
        void waitForDecision({ scope: "agent-team-budget", id: runId }, ac.signal)
          .then((decision) => {
            if (decision.outcome === "approve") {
              const extra = (decision.plan as { extraTokens?: number })?.extraTokens ?? 0
              if (extra > 0) budget.extendLimit(extra)
            } else {
              ac.abort(new Error("Operator declined budget extension"))
            }
          })
          .catch(() => {
            // signal aborted — no-op
          })
          .finally(() => {
            budgetResolverActive = false
          })
      })
    )

    // ── Synthesize VW + run via workflow ──
    const { workflow } = synthesizeTeamWorkflow({
      team,
      tasks,
      initialConcurrency: concurrency.get(),
      wallClockTimeoutMs: team.config.defaultTimeout,
    })

    registerTeamRunContext({
      runId,
      teamId,
      team,
      pool,
      budget,
      notifier,
      concurrency,
      modelPref,
      storeWriter: deps.storeWriter,
    })

    try {
      const result = await runWorkflow({
        workflow,
        trigger: {
          workflowId: workflow.id,
          kind: "trigger.team",
          payload: { teamId },
          originAt: Date.now(),
        },
        runId,
        signal: ac.signal,
        concurrency,
      })
      const status: RunTeamLifecycleResult["status"] =
        result.status === "succeeded"
          ? "completed"
          : result.status === "cancelled"
            ? "cancelled"
            : "failed"
      return {
        runId: result.runId,
        status,
        reason: result.error?.message,
      }
    } finally {
      for (const u of subs) {
        try {
          u()
        } catch {
          /* listener already gone */
        }
      }
      unregisterTeamRunContext(runId)
      // Release any pending approval-bus waiters keyed to this run.
      approveBus({ scope: "agent-team-deadlock", id: runId })
      approveBus({ scope: "agent-team-budget", id: runId })
      rejectBus({ scope: "agent-team-deadlock", id: runId })
      rejectBus({ scope: "agent-team-budget", id: runId })
      for (const w of workers) {
        rejectBus({ scope: "agent-team-teammate-fix", id: `${runId}:${w.id}` })
      }
    }
  } finally {
    inflightControllers.delete(teamId)
  }
}

/** Cancel a running team. Returns true if a controller was found + aborted. */
export function abortTeam(teamId: string, reason?: unknown): boolean {
  const ctrl = inflightControllers.get(teamId)
  if (!ctrl || ctrl.signal.aborted) return false
  ctrl.abort(reason ?? new Error("Aborted by caller"))
  return true
}

/** Test-only — drop in-flight entries without aborting. */
export function __resetInflightForTesting(): void {
  inflightControllers.clear()
}
