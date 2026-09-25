/**
 * PlanRuntime — the renderer-side singleton that owns plan lifecycle. (ADR-0045)
 *
 * Mirrors `lib/goal/runtime.ts:GoalRuntime`:
 *  - `createPlan()`   — materialise steps, enforce the one-open-plan-per-session
 *                       invariant, persist, log `plan_created`.
 *  - `approvePlan()` / `rejectPlan()` — pre-execution gate transitions.
 *                       `rejectPlan` lands the terminal `rejected` status (a
 *                       verdict on the plan), never a disguised cancel.
 *  - `pausePlan()` / `resumePlan()` / `cancelPlan()` — live transitions with
 *                       generationId rotation + AbortController fan-out + event log.
 *  - `failInSessionStep()` / `continueInSessionPlan()` — the in-session
 *                       failure loop: a step whose turn failed / never started /
 *                       went silent / was orphaned is marked `failed` and the
 *                       plan halts `paused` on it (`stepHalt`); the user then
 *                       retries, skips or completes the step (or cancels).
 *  - `updatePlanDraft()` — edit a not-yet-executing plan's title / steps / config.
 *  - `setStepStatus()` — write one step's status + recomputed counts/cursor
 *                       (used by the P2 in-session driver / orchestrator).
 *  - `registerAbortController()` — the driver registers its signal so a pause /
 *                       cancel can fire it before the next persist.
 *
 * Two executors hang off it, chosen by `./strategy:resolvePlanStrategy`:
 *  - `runPlan()`   — ORCHESTRATED. Compiles the plan into a VisualWorkflow and
 *                    runs it headlessly. This is what the scheduler, remote
 *                    control and the workflow node call, so it stays the
 *                    unconditional entry point for headless callers.
 *  - `startPlan()` — IN-SESSION. Marks the plan executing, moves its first step
 *                    to `in_progress`, and hands the caller that step's turn
 *                    text; `./turn-driver:handlePlanTurnComplete` advances from
 *                    there, one visible chat turn per step. Chat surfaces route
 *                    through this so an orchestrated plan is never run twice.
 *
 * Import-side singleton — one per renderer process; tests reset via
 * `__resetPlanRuntimeForTesting()`.
 */

import type {
  AgentPlan,
  CreatePlanInput,
  PlanConfig,
  PlanRefinementRequest,
  PlanStatus,
  PlanStep,
  PlanStepContinueAction,
  PlanStepHalt,
  PlanStepHaltCause,
  PlanStepStatus,
  UpdatePlanInput,
} from "@/types/agent/plan"
import type { LlmClient } from "@/lib/twin/distill/llm"
import {
  DEFAULT_PLAN_CONFIG,
  computePlanCounts,
  isRejectablePlanStatus,
  isTerminalPlanStatus,
  isTerminalStepStatus,
} from "@/types/agent/plan"
import {
  appendPlanEvent,
  createPlan,
  deletePlan,
  getExecutingPlanForSession,
  getOpenPlanForSession,
  getPlan,
  listPlansBySession,
  updatePlan,
} from "@/lib/db/plans"
import { loggers } from "@cognia/logging"
import {
  applyStepStatus,
  currentInProgressStep,
  linearAgentTurnSteps,
  materializeSteps,
  skipStepInDag,
} from "./steps"
import { findPlanPiiLeak } from "./pii-gate"
import {
  listItemTitle,
  projectStepTitles,
  rebuildPlanText,
  splitPlanDocument,
  stepsSectionWindow,
} from "./plan-doc"
import {
  emitPlanCompletedSchedulerEvent,
  emitPlanStatus,
  notifyPlanAwaitingApproval,
  notifyPlanStepHalted,
  notifyPlanTerminal,
} from "./notify"
import { haltTrailReason } from "./step-halt"
import { disarmPlanStepWatch } from "./step-watchdog"
import type { PlanTurnHookDeps } from "./turn-driver"
import { usePendingGatesStore } from "@/stores/agent/pending-gates-store"
import { resolvePlanStrategy, type PlanRunStrategy } from "./strategy"
import type { SynthesizePlanResult } from "./synthesize-workflow"

export interface PlanChatResumeFailure {
  prompt: string
  mode: "default" | "acceptEdits" | "auto"
}

/** Read only the continuation fields written by the approval dock. */
export function readPlanChatResumeFailure(plan: AgentPlan): PlanChatResumeFailure | null {
  const raw = plan.metadata?.chatResumeFailure
  if (!raw || typeof raw !== "object") return null
  const value = raw as Record<string, unknown>
  if (typeof value.prompt !== "string" || !value.prompt.trim()) return null
  if (value.mode !== "default" && value.mode !== "acceptEdits" && value.mode !== "auto") return null
  return { prompt: value.prompt, mode: value.mode }
}

/** Input to {@link PlanRuntime.failInSessionStep}. */
export interface FailInSessionStepInput {
  /**
   * The step that stopped. When given, the call is a no-op unless that exact
   * step is still `in_progress` (a late report about a step that moved on is
   * dropped); when omitted, the plan's current in-progress step is used, and
   * a plan with none halts between steps.
   */
  stepId?: string
  cause: PlanStepHaltCause
  /** Technical detail stored as the step's `error` and the halt's `detail`. */
  detail: string
  /**
   * Generation captured when the step was dispatched. A mismatch means the
   * user already paused / retried / cancelled, and that newer decision wins.
   */
  capturedGenerationId?: string
}

/** What {@link PlanRuntime.continueInSessionPlan} decided. */
export type PlanContinueOutcome =
  /** Dispatch `userMessage` as the next chat turn; the step is `in_progress`. */
  | {
      kind: "continue"
      stepId: string
      stepTitle: string
      userMessage: string
      /** Generation the dispatch belongs to — pass it back if the send fails. */
      generationId: string
    }
  /** The plan finished (or a hook paused it again) instead of starting a step. */
  | { kind: "exit"; status: PlanStatus; reason: string }
  /** Nothing to do: the plan is not a halted / paused in-session plan. */
  | { kind: "noop"; reason: string }

// ─────────────────────────────────────────────────────────────────────────────
// Config resolution
// ─────────────────────────────────────────────────────────────────────────────

/** Merge a partial config over the defaults. */
export function resolvePlanConfig(overrides: Partial<PlanConfig> = {}): PlanConfig {
  return { ...DEFAULT_PLAN_CONFIG, ...overrides }
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime
// ─────────────────────────────────────────────────────────────────────────────

interface AbortRegistration {
  planId: string
  controller: AbortController
}

class PlanRuntime {
  /** Per-plan active driver / orchestrator abort controllers. */
  private aborters = new Map<string, AbortRegistration>()
  /**
   * Plans with a `failInSessionStep` in flight. The watchdog, the approval
   * dock's rejected send and the boot recovery can all report the same dead
   * turn; the first report wins and the rest read the result.
   */
  private halting = new Set<string>()

  /**
   * Register the AbortController for an in-flight plan run. The runtime fires
   * it whenever the plan status mutates externally (pause / cancel). Returns
   * an unregister function the driver should call on completion.
   */
  registerAbortController(planId: string, controller: AbortController): () => void {
    this.aborters.set(planId, { planId, controller })
    return () => {
      const existing = this.aborters.get(planId)
      if (existing?.controller === controller) this.aborters.delete(planId)
    }
  }

  /** Abort any in-flight controller for a plan. */
  private fireAbort(planId: string): void {
    const reg = this.aborters.get(planId)
    if (!reg) return
    this.aborters.delete(planId)
    if (!reg.controller.signal.aborted) reg.controller.abort()
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Create a plan for a session. If the session already has an open plan it is
   * cancelled first so the one-open-plan-per-session invariant holds. The new
   * plan starts `awaiting_approval` when `config.requireApproval` (default),
   * else `approved`.
   */
  async createPlan(input: CreatePlanInput): Promise<AgentPlan> {
    const existing = await getOpenPlanForSession(input.sessionId)
    if (existing) {
      this.fireAbort(existing.id)
      disarmPlanStepWatch(existing.id)
      await updatePlan(existing.id, {
        status: "cancelled",
        generationId: crypto.randomUUID(),
        turnDispatch: undefined,
      })
      await appendPlanEvent({
        planId: existing.id,
        kind: "cancelled",
        payload: { kind: "cancelled" },
      })
    }

    const config = resolvePlanConfig(input.config)
    const steps = materializeSteps(input.steps)
    const counts = computePlanCounts(steps)
    const status: PlanStatus = config.requireApproval ? "awaiting_approval" : "approved"
    const executionMode = input.executionMode ?? "auto"

    const row = await createPlan({
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      characterId: input.characterId,
      title: input.title,
      description: input.description,
      source: input.source,
      executionMode,
      steps,
      status,
      totalSteps: counts.totalSteps,
      completedSteps: counts.completedSteps,
      config,
      refinementCount: 0,
      generationId: crypto.randomUUID(),
      metadata: input.metadata,
    })
    await appendPlanEvent({
      planId: row.id,
      kind: "plan_created",
      payload: {
        kind: "plan_created",
        source: row.source,
        totalSteps: row.totalSteps,
        executionMode: row.executionMode,
      },
    })
    // A plan that needs a human is the one lifecycle moment worth interrupting
    // for; the notification carries Approve / Discard so the answer does not
    // require finding the session first. No-op for a plan that landed approved.
    void notifyPlanAwaitingApproval(row)
    return row
  }

  /**
   * Edit a not-yet-executing plan (draft / awaiting_approval / approved). Steps
   * passed in replace the existing array; counts are recomputed. No-op when the
   * plan is executing / paused / terminal (use a refinement for those).
   */
  async updatePlanDraft(planId: string, patch: UpdatePlanInput): Promise<AgentPlan | null> {
    const current = await getPlan(planId)
    if (!current) return null
    if (current.status === "executing" || current.status === "paused") return current
    if (isTerminalPlanStatus(current.status)) return current

    const steps = patch.steps ?? current.steps
    const counts = computePlanCounts(steps)
    await updatePlan(planId, {
      title: patch.title ?? current.title,
      description: patch.description ?? current.description,
      steps,
      totalSteps: counts.totalSteps,
      completedSteps: counts.completedSteps,
      executionMode: patch.executionMode ?? current.executionMode,
      config: patch.config ? { ...current.config, ...patch.config } : current.config,
      metadata: patch.metadata ?? current.metadata,
      generationId: crypto.randomUUID(),
    })
    await appendPlanEvent({
      planId,
      kind: "plan_updated",
      payload: { kind: "plan_updated", totalSteps: counts.totalSteps },
    })
    return (await getPlan(planId)) ?? null
  }

  /** Retain a failed chat handoff without repeating approval or step transitions. */
  async setChatResumeFailure(planId: string, failure: PlanChatResumeFailure | null): Promise<void> {
    const current = await getPlan(planId)
    if (!current || isTerminalPlanStatus(current.status)) return
    const metadata = { ...current.metadata }
    if (failure) metadata.chatResumeFailure = failure
    else delete metadata.chatResumeFailure
    // Metadata-only: rotating generation here would invalidate an already
    // prepared in-session step and make its retry skip the original turn.
    await updatePlan(planId, { metadata })
  }

  /**
   * Approve a plan for execution (draft / awaiting_approval / approved →
   * `approved`). The actual run is kicked off by `runPlan` (P2). No-op when the
   * plan is already executing or terminal.
   */
  async approvePlan(planId: string): Promise<AgentPlan | null> {
    const current = await getPlan(planId)
    if (!current) return null
    if (current.status === "executing" || isTerminalPlanStatus(current.status)) return current
    await updatePlan(planId, { status: "approved", generationId: crypto.randomUUID() })
    await appendPlanEvent({ planId, kind: "approved", payload: { kind: "approved" } })
    const updated = (await getPlan(planId)) ?? null
    void emitPlanStatus(updated)
    return updated
  }

  /**
   * "No, keep planning" (Claude Code parity): defer the approval decision
   * WITHOUT destroying the plan. Only from `awaiting_approval` → back to
   * `draft`; the approval dock's `awaiting_approval` gate hides it, the plan
   * survives for refinement / a later re-submit, and the next `createPlan`
   * (a fresh ExitPlanMode) cancels the lingering draft via the one-open-plan
   * invariant. Contrast `rejectPlan`, which is the destructive discard.
   */
  async keepPlanning(planId: string, feedback?: string): Promise<AgentPlan | null> {
    const current = await getPlan(planId)
    if (!current) return null
    if (current.status !== "awaiting_approval") return current
    await updatePlan(planId, { status: "draft", generationId: crypto.randomUUID() })
    await appendPlanEvent({ planId, kind: "deferred", payload: { kind: "deferred", feedback } })
    const updated = (await getPlan(planId)) ?? null
    void emitPlanStatus(updated)
    return updated
  }

  /**
   * Reject a plan that has not started (draft / awaiting_approval / approved)
   * → the terminal `rejected` status, with a `rejected` trail event carrying
   * the optional reason. A rejection is a verdict on the plan, not an
   * abandoned run, so it is refused (no-op, current row returned) once the
   * plan is executing or paused — backing out of those is `cancelPlan`.
   */
  async rejectPlan(planId: string, feedback?: string): Promise<AgentPlan | null> {
    const current = await getPlan(planId)
    if (!current) return null
    if (!isRejectablePlanStatus(current.status)) return current
    const reason = feedback?.trim() || undefined
    this.fireAbort(planId)
    this.clearGates(planId)
    disarmPlanStepWatch(planId)
    await updatePlan(planId, { status: "rejected", generationId: crypto.randomUUID() })
    await appendPlanEvent({
      planId,
      kind: "rejected",
      payload: { kind: "rejected", ...(reason ? { feedback: reason } : {}) },
    })
    const updated = (await getPlan(planId)) ?? null
    void emitPlanStatus(updated)
    return updated
  }

  /**
   * Drop any `approval_gate` dialogs still standing for this plan.
   *
   * The executor's own `finally` already closes a gate it is blocked on, but a
   * gate restored from persistence after a reload has no live waiter behind it
   * — cancelling / finishing the plan is what makes that ghost card obsolete.
   */
  private clearGates(planId: string): void {
    try {
      usePendingGatesStore.getState().clearForPlan(planId)
    } catch {
      // Store unavailable (headless / SSR) — the gate UI does not exist there.
    }
  }

  /** Pause an executing plan → `paused`; fires the run's AbortController. */
  async pausePlan(planId: string): Promise<AgentPlan | null> {
    const current = await getPlan(planId)
    if (!current) return null
    if (current.status !== "executing") return current
    this.fireAbort(planId)
    // A paused plan has no live step to supervise; the turn that was running
    // finishes on its own and the driver drops it as stale.
    disarmPlanStepWatch(planId)
    await updatePlan(planId, {
      status: "paused",
      generationId: crypto.randomUUID(),
      turnDispatch: undefined,
    })
    await appendPlanEvent({ planId, kind: "paused", payload: { kind: "paused" } })
    const updated = (await getPlan(planId)) ?? null
    void emitPlanStatus(updated)
    return updated
  }

  /**
   * Resume a paused plan → `executing`. An orchestrated plan is re-driven by
   * `runPlan`. An IN-SESSION plan is re-driven one turn at a time by a chat
   * surface, which uses {@link continueInSessionPlan} to get the turn text; a
   * headless caller (plugin, workflow node, remote control) reaching this
   * method gets the same transition — the step restarts and is armed on the
   * watchdog — so an undispatched turn surfaces as a `not_started` halt the
   * chat surface can retry, instead of an `executing` plan nothing drives.
   */
  async resumePlan(planId: string): Promise<AgentPlan | null> {
    const current = await getPlan(planId)
    if (!current) return null
    if (current.status !== "paused") return current
    if (resolvePlanStrategy(current) === "in_session") {
      await this.continueInSessionPlan(planId, "resume")
      return (await getPlan(planId)) ?? null
    }
    await updatePlan(planId, { status: "executing", generationId: crypto.randomUUID() })
    await appendPlanEvent({ planId, kind: "resumed", payload: { kind: "resumed" } })
    const updated = (await getPlan(planId)) ?? null
    void emitPlanStatus(updated)
    return updated
  }

  /** Cancel any non-terminal plan → `cancelled`; fires the AbortController. */
  async cancelPlan(planId: string): Promise<AgentPlan | null> {
    const current = await getPlan(planId)
    if (!current) return null
    if (isTerminalPlanStatus(current.status)) return current
    this.fireAbort(planId)
    this.clearGates(planId)
    disarmPlanStepWatch(planId)
    await updatePlan(planId, {
      status: "cancelled",
      generationId: crypto.randomUUID(),
      turnDispatch: undefined,
    })
    await appendPlanEvent({ planId, kind: "cancelled", payload: { kind: "cancelled" } })
    await appendPlanEvent({
      planId,
      kind: "exit",
      payload: { kind: "exit", status: "cancelled", reason: "user cancelled the plan" },
    })
    const updated = (await getPlan(planId)) ?? null
    void emitPlanStatus(updated)
    return updated
  }

  /**
   * Write one step's status (+ optional field patch), recomputing the plan's
   * denormalised counts and current-step cursor. Used by the P2 in-session
   * driver / orchestrator. No-op when the plan is missing or terminal.
   */
  async setStepStatus(
    planId: string,
    stepId: string,
    status: PlanStepStatus,
    patch: Partial<Omit<PlanStep, "id" | "status">> = {}
  ): Promise<AgentPlan | null> {
    const current = await getPlan(planId)
    if (!current) return null
    if (isTerminalPlanStatus(current.status)) return current
    const applied = applyStepStatus(current.steps, stepId, status, patch)
    await updatePlan(planId, {
      steps: applied.steps,
      totalSteps: applied.totalSteps,
      completedSteps: applied.completedSteps,
      currentStepId: applied.currentStepId,
    })
    const step = applied.steps.find((candidate) => candidate.id === stepId)
    // `step_failed` is declared in `PlanEventKind` with its own payload and,
    // until now, was appended by nobody: a kind that existed in the type and
    // never in the trail. This is its chokepoint. The orchestrated path
    // (`step-dispatch` through the writer adapter), the plugin API and
    // `action.plan.setStepStatus` all land here, and the conversational turn
    // driver cannot double-emit because it only ever writes `completed`.
    if (status === "failed" && step) {
      void appendPlanEvent({
        planId,
        kind: "step_failed",
        payload: {
          kind: "step_failed",
          stepId,
          title: step.title,
          error: typeof patch.error === "string" ? patch.error : "step failed",
          attempt: typeof step.attempts === "number" ? step.attempts : 1,
        },
      }).catch(() => {
        // The trail is a projection of the plan, so a failed append must not
        // fail the status write that is the source of truth.
      })
    }
    if (step) this.recordIssueSettled(planId, step, status)
    return (await getPlan(planId)) ?? null
  }

  /**
   * A step bound to a tracker issue tells the issue how it ended (spec
   * 2026-09-06 D9). Off the write path and best-effort: the plan is the source
   * of truth, the trail entry is a projection of it. Shared by every writer
   * that settles a step, so a skip or a user "mark done" reaches the issue too.
   */
  private recordIssueSettled(planId: string, step: PlanStep, status: PlanStepStatus): void {
    if (!step.issueId || !isTerminalStepStatus(status)) return
    const issueId = step.issueId
    void import("@/lib/issues/work-item-link")
      .then(({ recordWorkSettled }) =>
        recordWorkSettled({
          issueId,
          submissionId: `plan:${planId}:${step.id}`,
          source: "plan",
          outcome: status,
        })
      )
      .catch(() => {
        // The issue may be gone. The plan does not care.
      })
  }

  /**
   * An in-session step stopped without finishing: its turn failed, was never
   * sent, went silent, ended unrecorded, or died with the renderer. Mark the
   * step `failed` (a `step_failed` trail entry with the detail), halt the plan
   * `paused` on it with a {@link PlanStepHalt}, log the driver's `exit`, close
   * the step's lifecycle-hook bracket as a failure, and tell the user.
   *
   * `paused`, not `failed`: the plan is intact and one step is broken, so the
   * user decides — retry / skip / mark done via {@link continueInSessionPlan},
   * or cancel. Terminal `failed` would make those decisions impossible.
   *
   * Idempotent and race-safe. Refused (current row returned) unless the plan
   * is an executing in-session plan, the captured generation still matches,
   * and a named step is still in progress, so the watchdog, a rejected send
   * and the boot recovery can all report the same dead turn.
   */
  async failInSessionStep(
    planId: string,
    input: FailInSessionStepInput
  ): Promise<AgentPlan | null> {
    if (this.halting.has(planId)) return (await getPlan(planId)) ?? null
    this.halting.add(planId)
    try {
      const current = await getPlan(planId)
      if (!current) return null
      if (current.status !== "executing") return current
      if (input.capturedGenerationId && current.generationId !== input.capturedGenerationId) {
        return current
      }
      // An orchestrated plan's steps belong to the workflow run, whose own
      // failure path finishes the plan.
      if (resolvePlanStrategy(current) !== "in_session") return current
      const step = input.stepId
        ? current.steps.find((s) => s.id === input.stepId && s.status === "in_progress")
        : currentInProgressStep(current.steps, current.currentStepId)
      if (input.stepId && !step) return current

      const at = Date.now()
      const halt: PlanStepHalt = {
        ...(step ? { stepId: step.id } : {}),
        cause: input.cause,
        detail: input.detail,
        at,
      }
      this.fireAbort(planId)
      disarmPlanStepWatch(planId)
      // Status + generation FIRST: a turn completing in this window now finds
      // the plan paused under a new generation and stands down, instead of
      // advancing past the step being failed.
      await updatePlan(planId, {
        status: "paused",
        generationId: crypto.randomUUID(),
        stepHalt: halt,
        turnDispatch: undefined,
      })
      if (step) {
        await this.setStepStatus(planId, step.id, "failed", {
          error: input.detail,
          completedAt: at,
          ...(typeof step.startedAt === "number"
            ? { actualDurationMs: Math.max(0, at - step.startedAt) }
            : {}),
        })
        void this.closeFailedStepBracket(current, input.detail)
      }
      await appendPlanEvent({
        planId,
        kind: "exit",
        payload: { kind: "exit", status: "paused", reason: haltTrailReason(step, halt) },
      })
      const updated = (await getPlan(planId)) ?? null
      void emitPlanStatus(updated)
      if (updated) void notifyPlanStepHalted(updated, step, halt)
      return updated
    } finally {
      this.halting.delete(planId)
    }
  }

  /** Close a failed step's hook bracket (StopFailure + SessionEnd). Observational. */
  private async closeFailedStepBracket(plan: AgentPlan, error: string): Promise<void> {
    try {
      const [{ chatPlanStepHooks }, { firePostCallHooks }] = await Promise.all([
        import("./turn-driver"),
        import("@/lib/claude/hooks/lifecycle-firer"),
      ])
      const hooks = chatPlanStepHooks(plan.id, plan.sessionId)
      if (!hooks.firer || !hooks.hookContext) return
      await firePostCallHooks(hooks.firer, hooks.hookContext, { success: false, error })
    } catch {
      // Hooks are best-effort; the halt is already recorded.
    }
  }

  /**
   * The user's decision on a PAUSED in-session plan — halted on a failed step
   * or paused by the user / a hook — and the turn to send for it.
   *
   *   retry    → the halted (or interrupted in-progress) step runs again
   *   skip     → the step is `skipped` and taken out of the dependency chain
   *              (`step_skipped`), then the next step runs
   *   complete → the step is marked `completed` (`step_completed`; the user
   *              says the work is done), then the next step runs
   *   resume   → continue: an interrupted / halted step re-runs, otherwise the
   *              next runnable step starts
   *
   * Clears the halt, rotates the generation, logs `resumed`, and hands off to
   * the driver's `advancePlanToNextStep` — so the new turn is stamped, armed on
   * the watchdog and bracketed by hooks exactly like any other step. Returns
   * the turn for the caller to dispatch; the caller reports a refused send
   * back through {@link failInSessionStep} with the returned generation.
   */
  async continueInSessionPlan(
    planId: string,
    action: PlanStepContinueAction,
    opts: { hooks?: PlanTurnHookDeps; result?: string } = {}
  ): Promise<PlanContinueOutcome> {
    const current = await getPlan(planId)
    if (!current) return { kind: "noop", reason: "plan not found" }
    if (current.status !== "paused") {
      return { kind: "noop", reason: `plan status is ${current.status}` }
    }
    if (resolvePlanStrategy(current) !== "in_session") {
      return { kind: "noop", reason: "the plan runs on the orchestrator" }
    }

    const haltedId = current.stepHalt?.stepId
    const target =
      (haltedId ? current.steps.find((s) => s.id === haltedId) : undefined) ??
      currentInProgressStep(current.steps, current.currentStepId)
    const actsOnStep = action === "retry" || action === "skip" || action === "complete"
    if (actsOnStep && !target) return { kind: "noop", reason: "no halted step to act on" }
    if (target && (target.status === "completed" || target.status === "skipped")) {
      if (actsOnStep) return { kind: "noop", reason: `step is already ${target.status}` }
    }

    const at = Date.now()
    let steps = current.steps
    let settled: { step: PlanStep; status: "skipped" | "completed" } | null = null
    if (target && target.status !== "completed" && target.status !== "skipped") {
      if (action === "retry" || action === "resume") {
        steps = applyStepStatus(steps, target.id, "pending", {
          error: undefined,
          completedAt: undefined,
          actualDurationMs: undefined,
        }).steps
      } else if (action === "skip") {
        steps = skipStepInDag(steps, target.id, { error: undefined, completedAt: at }).steps
        settled = { step: target, status: "skipped" }
      } else {
        const result = opts.result?.trim()
        steps = applyStepStatus(steps, target.id, "completed", {
          error: undefined,
          completedAt: at,
          ...(result ? { result: result.slice(0, 2000) } : {}),
        }).steps
        settled = { step: target, status: "completed" }
      }
    }

    const counts = computePlanCounts(steps)
    const generationId = crypto.randomUUID()
    await updatePlan(planId, {
      steps,
      totalSteps: counts.totalSteps,
      completedSteps: counts.completedSteps,
      status: "executing",
      generationId,
      stepHalt: undefined,
      turnDispatch: undefined,
    })
    if (settled?.status === "skipped") {
      await appendPlanEvent({
        planId,
        kind: "step_skipped",
        payload: {
          kind: "step_skipped",
          stepId: settled.step.id,
          title: settled.step.title,
          reason: "skipped by the user",
        },
      })
    } else if (settled?.status === "completed") {
      await appendPlanEvent({
        planId,
        kind: "step_completed",
        payload: { kind: "step_completed", stepId: settled.step.id, title: settled.step.title },
      })
    }
    if (settled) this.recordIssueSettled(planId, settled.step, settled.status)
    await appendPlanEvent({ planId, kind: "resumed", payload: { kind: "resumed" } })
    void emitPlanStatus((await getPlan(planId)) ?? null)

    const { advancePlanToNextStep } = await import("./turn-driver")
    const outcome = await advancePlanToNextStep(planId, generationId, opts.hooks ?? {})
    if (outcome.kind === "continue") return { ...outcome, generationId }
    if (outcome.kind === "exit") return outcome
    return {
      kind: "noop",
      reason: outcome.kind === "stale" ? outcome.reason : `driver returned ${outcome.kind}`,
    }
  }

  /**
   * Execute an approved (or paused-then-resumed) plan via the orchestrated
   * path: compile the plan into a VisualWorkflow and run it through the
   * workflow orchestrator, which executes each `action.plan.step.dispatch`
   * node by step kind (agent_turn / approval_gate / sub_workflow). The plan
   * transitions to `executing` for the duration and to `completed` / `failed`
   * at the end. A user `pausePlan` / `cancelPlan` mid-run fires the registered
   * AbortController, which the orchestrator honors.
   *
   * The in-session conversational driver (for linear all-`agent_turn` plans
   * that should run visibly in the chat session) is wired in P3, where the
   * chat hook can drive turns; until then every executable plan runs through
   * this orchestrated path.
   *
   * Returns the terminal status + run output, or null when the plan is missing
   * or not in a runnable state.
   */
  async runPlan(
    planId: string,
    opts: { signal?: AbortSignal; client?: LlmClient } = {}
  ): Promise<{ status: PlanStatus; output?: unknown } | null> {
    const plan = await getPlan(planId)
    if (!plan) return null
    if (plan.status !== "approved" && plan.status !== "paused" && plan.status !== "executing") {
      return { status: plan.status }
    }

    await updatePlan(planId, { status: "executing", generationId: crypto.randomUUID() })
    const executing = await getPlan(planId)
    if (!executing) return null
    void emitPlanStatus(executing)

    const ac = new AbortController()
    if (opts.signal) {
      if (opts.signal.aborted) ac.abort()
      else opts.signal.addEventListener("abort", () => ac.abort(), { once: true })
    }
    const unregisterAbort = this.registerAbortController(planId, ac)

    const runId = `plan_run_${crypto.randomUUID()}`
    const [{ synthesizePlanWorkflow }, { runWorkflow }, planRunCtx] = await Promise.all([
      import("./synthesize-workflow"),
      import("@/lib/workflow/runtime/orchestrator"),
      import("./plan-run-context"),
    ])

    let synthResult: SynthesizePlanResult
    try {
      synthResult = synthesizePlanWorkflow(executing)
    } catch (err) {
      // Malformed plan (cycle / empty / bad dep) — fail terminally.
      await this.finishPlanRun(planId, "failed")
      unregisterAbort()
      throw err
    }

    // Resolved once, not per step: a plan is one piece of work, and steps that
    // cannot see each other's edits are not a plan.
    const { resolvePlanExecutionRoot } = await import("./step-workspace")
    const executionRoot = await resolvePlanExecutionRoot(executing).catch(() => undefined)

    planRunCtx.registerPlanRunContext({
      runId,
      planId,
      plan: executing,
      ...(executing.characterId ? { characterId: executing.characterId } : {}),
      ...(executionRoot ? { executionRoot: executionRoot.root } : {}),
      writer: {
        setStepStatus: async (stepId, status, patch) => {
          await this.setStepStatus(planId, stepId, status, patch)
        },
      },
    })

    try {
      const result = await runWorkflow({
        workflow: synthResult.workflow,
        trigger: {
          workflowId: synthResult.workflow.id,
          kind: "trigger.manual",
          payload: { planId },
          originAt: Date.now(),
        },
        runId,
        signal: ac.signal,
      })
      const status: PlanStatus = result.status === "succeeded" ? "completed" : "failed"
      await this.finishPlanRun(planId, status, result.error?.message)
      // Step-failure auto-replan (ADR-0045 §4): when a client is supplied and
      // the refinement budget allows, repair the plan into a fresh
      // awaiting_approval draft (fire-and-forget; never auto-re-executes).
      if (status === "failed" && opts.client) {
        const failedStepId = result.error?.nodeId
        void this.refinePlan(
          {
            planId,
            refinementType: "repair",
            trigger: "step_failure",
            ...(failedStepId ? { failedStepId } : {}),
          },
          opts.client
        ).catch(() => {})
      }
      return { status, output: result.output }
    } finally {
      planRunCtx.unregisterPlanRunContext(runId)
      unregisterAbort()
    }
  }

  /**
   * Begin an IN-SESSION run: flip the plan to `executing` and hand back the
   * first step's turn text for the chat surface to dispatch (ADR-0045 §2, P3).
   *
   * Refuses a plan the strategy resolver assigns to the orchestrator, so a
   * caller that skipped the resolver cannot start a fan-out plan one turn at a
   * time — it returns `{ strategy: "orchestrated" }` and the caller falls back
   * to `runPlan` (or, in chat, to the single implementing turn).
   *
   * Returns `null` when the plan is missing or not in a runnable state.
   */
  async startPlan(
    planId: string,
    hooks: PlanTurnHookDeps = {}
  ): Promise<{
    strategy: PlanRunStrategy
    status: PlanStatus
    stepId?: string
    userMessage?: string
    /** Generation the first step's dispatch belongs to (in-session only). */
    generationId?: string
  } | null> {
    const plan = await getPlan(planId)
    if (!plan) return null
    if (plan.status !== "approved" && plan.status !== "paused" && plan.status !== "executing") {
      return { strategy: resolvePlanStrategy(plan), status: plan.status }
    }

    const strategy = resolvePlanStrategy(plan)
    if (strategy === "orchestrated") return { strategy, status: plan.status }

    const generationId = crypto.randomUUID()
    await updatePlan(planId, { status: "executing", generationId })
    const executing = await getPlan(planId)
    void emitPlanStatus(executing)

    const { advancePlanToNextStep } = await import("./turn-driver")
    const outcome = await advancePlanToNextStep(planId, generationId, hooks)
    if (outcome.kind === "continue") {
      return {
        strategy,
        status: "executing",
        stepId: outcome.stepId,
        userMessage: outcome.userMessage,
        generationId,
      }
    }
    if (outcome.kind === "exit") return { strategy, status: outcome.status }
    // no_plan | stale | aborted — the row moved under us; report what it says.
    const after = await getPlan(planId)
    return { strategy, status: after?.status ?? plan.status }
  }

  /**
   * Refine (replan) a plan via the planner LLM. Drives all three triggers
   * (ADR-0045 §4): `manual`, `step_failure` (auto, capped by
   * `config.maxAutoRefinements`), and `judge_deviation`. The revised steps
   * replace the plan and it returns to `awaiting_approval` so a human (or the
   * caller) re-confirms before the next run — auto-replan never silently
   * re-executes. Fail-OPEN: any planner failure leaves the plan unchanged.
   *
   * A plan captured as markdown (`metadata.planText`) IS its document: the
   * planner sees the steps section a reader sees (not the Files / checklist
   * bullets the projection also carries), the result is written back into
   * that section, and `steps[]` is re-projected from the rewritten body — the
   * same single-source rule as a manual edit. Either way the plan is stamped
   * `userEdited`: it no longer matches the proposal in the transcript, so the
   * approval prompt must embed this version instead of pointing at "the plan
   * above".
   */
  async refinePlan(
    request: PlanRefinementRequest,
    client: LlmClient,
    opts: { signal?: AbortSignal } = {}
  ): Promise<AgentPlan | null> {
    const current = await getPlan(request.planId)
    if (!current) return null
    if (current.status === "cancelled" || current.status === "completed") return current

    // Auto triggers respect the refinement budget; manual is always allowed.
    if (
      request.trigger !== "manual" &&
      current.refinementCount >= current.config.maxAutoRefinements
    ) {
      return current
    }

    // PII red-line (ADR-0045): a refinement call ships the WHOLE plan — titles,
    // descriptions, step results — to the planner model. Fail-OPEN on the flow:
    // skip the send and keep the plan rather than leaking it or destroying it.
    const leak = findPlanPiiLeak(current)
    if (leak) {
      loggers.agent.warn(`Plan refinement blocked: PII at ${leak}`)
      return current
    }

    const planText = typeof current.metadata?.planText === "string" ? current.metadata.planText : ""
    let subject = current
    if (planText) {
      const ordered = [...current.steps].sort((a, b) => a.order - b.order)
      const section = splitPlanDocument(planText).steps?.map(listItemTitle) ?? null
      const window = stepsSectionWindow(
        section,
        ordered.map((s) => s.title)
      )
      subject = { ...current, steps: ordered.slice(window.start, window.end) }
    }

    const { refinePlanSteps } = await import("./planner")
    const result = await refinePlanSteps(subject, request, client, opts.signal)
    if (!result) return current // fail-OPEN — keep the existing plan
    disarmPlanStepWatch(request.planId)

    const nextText = planText ? rebuildPlanText(planText, result.titles) : null
    const steps = materializeSteps(
      linearAgentTurnSteps(nextText ? projectStepTitles(nextText) : result.titles)
    )
    const counts = computePlanCounts(steps)
    await updatePlan(request.planId, {
      steps,
      metadata: {
        ...current.metadata,
        userEdited: true,
        ...(nextText ? { planText: nextText } : {}),
      },
      totalSteps: counts.totalSteps,
      completedSteps: counts.completedSteps,
      currentStepId: undefined,
      status: "awaiting_approval",
      refinementCount: current.refinementCount + 1,
      generationId: crypto.randomUUID(),
      // A repaired plan goes back through approval: whatever halt or in-flight
      // turn the old steps had no longer describes anything.
      stepHalt: undefined,
      turnDispatch: undefined,
    })
    await appendPlanEvent({
      planId: request.planId,
      kind: "refined",
      payload: {
        kind: "refined",
        refinementType: request.refinementType,
        trigger: request.trigger,
        changes: [result.reasoning],
      },
    })
    await appendPlanEvent({
      planId: request.planId,
      kind: "replanned",
      payload: {
        kind: "replanned",
        reason: request.trigger,
        ...(request.failedStepId ? { failedStepId: request.failedStepId } : {}),
      },
    })
    const updated = (await getPlan(request.planId)) ?? null
    void emitPlanStatus(updated)
    return updated
  }

  /**
   * Transition a finished run to its terminal status + log the exit event.
   *
   * Public because the in-session driver owns the terminal transition for the
   * conversational path exactly as `runPlan` owns it for the orchestrated one —
   * both must emit the same exit event, companion broadcast and `plan:completed`
   * scheduler event, so a watcher cannot tell which executor ran the plan.
   */
  async finishPlanRun(planId: string, status: PlanStatus, reason?: string): Promise<void> {
    const current = await getPlan(planId)
    // A concurrent pause / cancel may have already moved the plan terminal —
    // don't overwrite a user-driven cancellation with a derived failure.
    if (!current || isTerminalPlanStatus(current.status)) return
    if (current.status === "paused") return
    disarmPlanStepWatch(planId)
    await updatePlan(planId, { status, generationId: crypto.randomUUID(), turnDispatch: undefined })
    await appendPlanEvent({
      planId,
      kind: "exit",
      payload: { kind: "exit", status, reason: reason ?? `plan run ${status}` },
    })
    const updated = await getPlan(planId)
    this.clearGates(planId)
    void emitPlanStatus(updated ?? null)
    void emitPlanCompletedSchedulerEvent(planId, status)
    if (updated) void notifyPlanTerminal(updated, status)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Pass-through readers (call-sites only ever import this module).
  // ───────────────────────────────────────────────────────────────────────────

  getPlan(planId: string): Promise<AgentPlan | undefined> {
    return getPlan(planId)
  }

  getOpenPlanForSession(sessionId: string): Promise<AgentPlan | undefined> {
    return getOpenPlanForSession(sessionId)
  }

  getExecutingPlanForSession(sessionId: string): Promise<AgentPlan | undefined> {
    return getExecutingPlanForSession(sessionId)
  }

  listPlansBySession(sessionId: string): Promise<AgentPlan[]> {
    return listPlansBySession(sessionId)
  }

  /** Delete a plan (and its events). For history "remove" actions. */
  async deletePlan(planId: string): Promise<void> {
    this.fireAbort(planId)
    this.clearGates(planId)
    disarmPlanStepWatch(planId)
    await deletePlan(planId)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton accessor
// ─────────────────────────────────────────────────────────────────────────────

let _instance: PlanRuntime | null = null

export function getPlanRuntime(): PlanRuntime {
  if (!_instance) _instance = new PlanRuntime()
  return _instance
}

/** Test-only escape hatch — wipes registered AbortControllers + singleton state. */
export function __resetPlanRuntimeForTesting(): void {
  _instance = null
}

export type { PlanRuntime }
