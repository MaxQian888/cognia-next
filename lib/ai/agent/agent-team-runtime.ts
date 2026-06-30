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
import {
  buildKnownCapabilityIds,
  validateInstanceCapabilitiesWith,
  refreshAllInstanceCapabilityWarnings,
} from "@/lib/ai/agent/team/capability-audit"
import { runWorkflow } from "@/lib/workflow/runtime/orchestrator"
import type { VisualWorkflow, WorkflowTriggeredFrom } from "@/types/workflow/visual"
import { createConcurrencyController } from "@/lib/workflow/runtime/concurrency-controller"
import { createModelPreferenceController } from "@/lib/workflow/runtime/model-preference-controller"
import { createTeammatePool } from "./team/teammate-pool"
import { createBudgetGuard } from "./team/budget-guard"
import { createTeamNotifier, type TeamNotifierDeps } from "./team/team-notifier"
import {
  registerTeamRunContext,
  unregisterTeamRunContext,
  getTeamRunContext,
  type TeamStoreWriter,
} from "./team/team-run-context"
import { synthesizeTeamWorkflow } from "./team/synthesize-workflow"
import { createDeadlockHandler } from "./team/deadlock-gate"
import { runTeamWaves } from "./team/team-wave-runner"
import { createLedgerCheckpoint } from "./team/progress-ledger-checkpoint"
import {
  RateLimitResumeController,
  createRealResumeDeps,
  NUDGE_CONTINUE_PROMPT,
} from "./team/rate-limit-resume"
import { isUltracodeActive, type UltracodeOverride } from "./team/ultracode-trigger"
import { getPluginLifecycleHooks } from "@/lib/plugin/messaging/hooks-system"

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
  /**
   * Origin of this team run when it was triggered from an IM channel
   * (e.g. an `action.team.run` node inside a workflow that
   * `startWorkflowFromIM` kicked off). Threaded onto the synthesized team
   * `runWorkflow` as `triggeredBy` so the existing
   * `workflow-progress-runner` fans the team's progress + final result back
   * to the originating conversation. Omitted for UI / API runs, which keeps
   * their behavior unchanged (no IM fan-out).
   */
  triggeredFrom?: WorkflowTriggeredFrom
  /**
   * Operator override for ultracode orchestration (ADR-0022 addendum).
   * `"force"` runs the ultracode pattern composition regardless of autoMode;
   * `"off"` forces the flat task DAG. Omitted → the team's `ultracode.autoMode`
   * + routing assessment decide (see `isUltracodeActive`).
   */
  ultracodeOverride?: UltracodeOverride
  /**
   * Optional run-scoped agent-trace id (eval target). Threaded onto the
   * TeamRunContext so every teammate dispatch emits its span under this trace,
   * letting the caller assemble the run via `queryByTrace`.
   */
  traceId?: string
}

export interface RunTeamLifecycleResult {
  /** Matches the workflowRuns row id; UI navigation key. */
  runId: string
  status: "completed" | "failed" | "cancelled"
  reason?: string
  /** The synthesized workflow's terminal output (e.g. `{ report }` for ultracode). */
  output?: unknown
  /** Echo of the run-scoped trace id when one was supplied. */
  traceId?: string
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
    // Ultracode runs are driven by the team objective (team.task string) + a
    // planned pattern composition, not the flat task list — so they don't
    // require pre-seeded tasks. Flat runs still do.
    const ultracodeActive = isUltracodeActive(team, deps.ultracodeOverride)
    if (!ultracodeActive && tasks.length === 0) {
      return { runId: "", status: "failed", reason: "No tasks to dispatch" }
    }

    // ── Allocate runId early so the onTeamStart hook can carry it ──
    const runId = `run_team_${nanoid(12)}`
    const hooks = getPluginLifecycleHooks()
    hooks.dispatchOnTeamStart({
      teamId,
      runId,
      workers: allMembers.map((m) => ({ id: m.id, name: m.name, role: m.role })),
      taskCount: tasks.length,
    })

    // ── Pre-run capability-audit gate ──
    // If any team/teammate references a capability id that no longer resolves
    // (e.g. a contributing plugin was disabled), surface the stale ids and ask
    // the operator to confirm before spending tokens on a degraded run.
    {
      const known = await buildKnownCapabilityIds()
      const auditWarnings = [
        ...validateInstanceCapabilitiesWith(known, team),
        ...workers.flatMap((w) => validateInstanceCapabilitiesWith(known, team, w)),
      ]
      if (auditWarnings.length > 0) {
        // Populate the derived sidecar map so the consent UI + Settings red
        // dots can enumerate exactly which ids are stale.
        void refreshAllInstanceCapabilityWarnings()
        const decision = await waitForDecision(
          { scope: "agent-team-capability-audit", id: runId },
          ac.signal
        ).catch(() => ({ outcome: "reject" as const }))
        if (decision.outcome !== "approve") {
          return {
            runId: "",
            status: "cancelled",
            reason: "Operator declined to run with stale capabilities",
          }
        }
      }
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
        const planResult = await deps.runLeadPlanning({
          team,
          lead,
          feedback,
          signal: ac.signal,
        })
        const decision = await waitForDecision(
          { scope: "agent-team", id: teamId },
          ac.signal
        ).catch(() => ({ outcome: "reject" as const, feedback: "aborted" }))
        if (decision.outcome === "approve") {
          approved = true
          hooks.dispatchOnTeamPlanReady({
            teamId,
            runId,
            plan: planResult.planText,
          })
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
    const concurrency = createConcurrencyController(team.config.maxConcurrentTeammates ?? 5)
    const modelPref = createModelPreferenceController()
    const notifier = createTeamNotifier({ runId, teamId }, deps.notifierDeps)
    const pool = createTeammatePool({ teammates: workers, teamId, runId })
    const budget = createBudgetGuard({
      runId,
      limit: team.config.tokenBudget ?? 0,
      onCritical: team.config.governancePolicy?.budget?.onCritical ?? "notify",
      notifier,
      concurrencyCtrl: concurrency,
      modelCtrl: modelPref,
    })

    // ── Guarded rate-limit resume controller ──
    // On a teammate rate-limit failure, dispatch-teammate reports the cooldown
    // here; once it elapses (and the run is still alive) we post a single
    // guarded "continue" nudge into the team mailbox so the lead/member resumes
    // instead of stalling. Disposed in `finally`. Gated by config (default on).
    const nudgeCfg = team.config.nudges ?? {}
    const rateLimitResume =
      nudgeCfg.enabled !== false
        ? new RateLimitResumeController(
            createRealResumeDeps(
              ({ memberId, generation }) => {
                const member = workers.find((w) => w.id === memberId)
                notifier.notify({
                  level: "info",
                  title: `Resuming after rate-limit cooldown`,
                  body: `${member?.name ?? memberId} is being nudged to continue.`,
                  runId,
                  teamId,
                  dedupeKey: `nudge:${runId}:${memberId}:${generation}`,
                })
                deps.storeWriter.addMessage({
                  teamId,
                  senderId: "system",
                  recipientId: team.leadId || memberId,
                  type: "system",
                  content: NUDGE_CONTINUE_PROMPT,
                  structuredPayload: {
                    type: "nudge",
                    nudgeType: "rate_limit_resume",
                    generation,
                  },
                })
              },
              {
                maxPerHour: nudgeCfg.maxPerMemberPerHour,
                busyWindowMs: nudgeCfg.busySignalWindowMs,
              }
            )
          )
        : undefined

    // ── Wire HITL gate subscriptions ──
    const subs: Array<() => void> = []

    // Deadlock gate: open the HITL recovery modal, or — when the team disabled
    // `enableDeadlockRecovery` — fast-fail instead of hanging. See deadlock-gate.ts.
    subs.push(
      pool.onAllUnavailable(
        createDeadlockHandler({
          recovery: team.config.enableDeadlockRecovery !== false,
          runId,
          teamId,
          notifier,
          concurrency,
          pool,
          signal: ac.signal,
          abort: (err) => ac.abort(err),
        })
      )
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

    // Wire budget threshold events to the plugin hooks pipeline. Plugins
    // listening on onTeamBudgetWarn see both warning and critical crossings
    // with `used` / `limit` snapshots so they can decide whether to nudge
    // model preference, post a dashboard, or veto further dispatch.
    subs.push(
      budget.on("warning_crossed", () => {
        const status = budget.status()
        hooks.dispatchOnTeamBudgetWarn({
          teamId,
          runId,
          level: "warning",
          used: status.used,
          limit: status.limit,
        })
      })
    )
    subs.push(
      budget.on("critical_crossed", () => {
        const status = budget.status()
        hooks.dispatchOnTeamBudgetWarn({
          teamId,
          runId,
          level: "critical",
          used: status.used,
          limit: status.limit,
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

    // ── Register the per-run context FIRST ──
    // Ultracode planning + every pattern/dispatch node reads it via
    // getTeamRunContext(runId); registering before synthesis lets the planner
    // dispatch a teammate to author the pattern composition.
    registerTeamRunContext({
      runId,
      teamId,
      ...(deps.traceId ? { traceId: deps.traceId } : {}),
      team,
      pool,
      budget,
      notifier,
      concurrency,
      modelPref,
      storeWriter: deps.storeWriter,
      ...(rateLimitResume ? { rateLimitResume } : {}),
      // Lazily populated by dispatchTeammate on first claim — see
      // `lib/ai/agent/team/dispatch-teammate.ts`.
      resolvedCapabilities: new Map(),
      // Lazily populated by resolveTeammateExternalAgent for external-backed
      // teammates — see `lib/ai/agent/team/resolve-external-backing.ts`.
      externalAgentInstances: new Map(),
    })

    // ── Synthesize the VisualWorkflow (ultracode patterns vs. flat task DAG) ──
    // The per-wave path (synthesized inside `runTeamWaves`) is engaged by EITHER
    // adaptive re-planning OR the progress ledger — both need the between-wave
    // checkpoint hook, which the single-pass `runWorkflow` does not expose. So
    // enabling the progress ledger alone is sufficient (it does not silently
    // require `adaptiveReplan.enabled`).
    const adaptiveFlat =
      !ultracodeActive &&
      (team.config.adaptiveReplan?.enabled === true || team.config.progressLedger?.enabled === true)
    let workflow: VisualWorkflow | undefined
    if (ultracodeActive) {
      // Side-effect import registers the pattern.* node executors.
      await import("./team/patterns")
      const [{ planUltracodeWorkflow }, { synthesizeUltracodeWorkflow }] = await Promise.all([
        import("./team/ultracode-planner"),
        import("./team/synthesize-ultracode"),
      ])
      const teamCtx = getTeamRunContext(runId)!
      const plan = await planUltracodeWorkflow(teamCtx, { signal: ac.signal })
      ;({ workflow } = synthesizeUltracodeWorkflow({
        team,
        plan,
        initialConcurrency: concurrency.get(),
        wallClockTimeoutMs: team.config.defaultTimeout,
      }))
    } else if (!adaptiveFlat) {
      ;({ workflow } = synthesizeTeamWorkflow({
        team,
        tasks,
        initialConcurrency: concurrency.get(),
        wallClockTimeoutMs: team.config.defaultTimeout,
      }))
    }

    // Run one synthesized workflow with the stable runId + trigger binding.
    // Reused per-wave by the adaptive path so every wave overwrites the same
    // run row (single-run view); the IM-origin binding flows onto each call.
    const runOneWorkflow = (wf: VisualWorkflow) =>
      runWorkflow({
        workflow: wf,
        trigger: {
          workflowId: wf.id,
          kind: "trigger.team",
          payload: { teamId },
          originAt: Date.now(),
          // Carry the IM origin onto the trigger binding too, so any
          // downstream node that inspects `ctx.trigger.binding` sees the
          // originating conversation (parity with `startWorkflowFromIM`).
          ...(deps.triggeredFrom?.adapterId && deps.triggeredFrom?.conversationKey
            ? {
                binding: {
                  adapterId: deps.triggeredFrom.adapterId,
                  conversationKey: deps.triggeredFrom.conversationKey,
                  ...(deps.triggeredFrom.sessionId
                    ? { sessionId: deps.triggeredFrom.sessionId }
                    : {}),
                },
              }
            : {}),
        },
        runId,
        signal: ac.signal,
        concurrency,
        // IM-origin fan-out: the progress-runner only mirrors runs whose
        // `triggeredBy.source === "im"`. Threading this is the single line
        // that lights up team → IM result delivery; UI/API runs omit it.
        ...(deps.triggeredFrom ? { triggeredBy: deps.triggeredFrom } : {}),
      })

    // Track final status so the finally block can fire onTeamComplete
    // with a meaningful payload even when runWorkflow throws.
    let finalStatus: RunTeamLifecycleResult["status"] = "failed"
    let finalReason: string | undefined
    try {
      let result: Awaited<ReturnType<typeof runWorkflow>>
      if (adaptiveFlat) {
        const waveCtx = getTeamRunContext(runId)!
        // When the progress ledger is enabled, swap the lead-only re-plan
        // checkpoint for the ledger checkpoint (stall detection + autonomous
        // escalation). The ledger instance is created once so its cross-wave
        // stall state persists across waves.
        const ledgerCheckpoint =
          team.config.progressLedger?.enabled === true
            ? createLedgerCheckpoint({ ctx: waveCtx, signal: ac.signal })
            : undefined
        const waveRes = await runTeamWaves({
          teamCtx: waveCtx,
          tasks,
          initialConcurrency: concurrency.get(),
          ...(team.config.defaultTimeout ? { wallClockTimeoutMs: team.config.defaultTimeout } : {}),
          signal: ac.signal,
          runWave: runOneWorkflow,
          ...(ledgerCheckpoint ? { checkpoint: ledgerCheckpoint } : {}),
        })
        // A no-task run (or one with no executed wave) has no lastResult; the
        // wave status is authoritative.
        result = waveRes.lastResult ?? { runId, status: "succeeded" }
        finalStatus =
          waveRes.status === "succeeded"
            ? "completed"
            : waveRes.status === "cancelled"
              ? "cancelled"
              : "failed"
        finalReason = waveRes.error?.message ?? result.error?.message
      } else {
        result = await runOneWorkflow(workflow!)
        finalStatus =
          result.status === "succeeded"
            ? "completed"
            : result.status === "cancelled"
              ? "cancelled"
              : "failed"
        finalReason = result.error?.message
        // Ultracode runs end on a single terminal `pattern.synthesize` node;
        // runWorkflow surfaces its output as `result.output`. Persist the report
        // to `team.finalResult` so the workspace surfaces the synthesized answer.
        if (ultracodeActive && finalStatus === "completed") {
          const report = (result.output as { report?: string } | undefined)?.report
          if (report && deps.storeWriter.setFinalResult) {
            deps.storeWriter.setFinalResult(teamId, report)
          }
        }
      }
      return {
        runId: result.runId,
        status: finalStatus,
        reason: finalReason,
        output: result.output,
        ...(deps.traceId ? { traceId: deps.traceId } : {}),
      }
    } catch (err) {
      finalReason = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      hooks.dispatchOnTeamComplete({
        teamId,
        runId,
        status: finalStatus,
        reason: finalReason,
      })
      for (const u of subs) {
        try {
          u()
        } catch {
          /* listener already gone */
        }
      }
      // Cancel any pending resume timer so it can't fire after the run ends.
      rateLimitResume?.dispose()
      unregisterTeamRunContext(runId)
      // Release any pending approval-bus waiters keyed to this run.
      approveBus({ scope: "agent-team-deadlock", id: runId })
      approveBus({ scope: "agent-team-budget", id: runId })
      approveBus({ scope: "agent-team-replan", id: runId })
      rejectBus({ scope: "agent-team-deadlock", id: runId })
      rejectBus({ scope: "agent-team-budget", id: runId })
      rejectBus({ scope: "agent-team-replan", id: runId })
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
