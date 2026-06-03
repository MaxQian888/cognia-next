/**
 * PlanRuntime — the renderer-side singleton that owns plan lifecycle. (ADR-0045)
 *
 * Mirrors `lib/goal/runtime.ts:GoalRuntime`:
 *  - `createPlan()`   — materialise steps, enforce the one-open-plan-per-session
 *                       invariant, persist, log `plan_created`.
 *  - `approvePlan()` / `rejectPlan()` — pre-execution gate transitions.
 *  - `pausePlan()` / `resumePlan()` / `cancelPlan()` — live transitions with
 *                       generationId rotation + AbortController fan-out + event log.
 *  - `updatePlanDraft()` — edit a not-yet-executing plan's title / steps / config.
 *  - `setStepStatus()` — write one step's status + recomputed counts/cursor
 *                       (used by the P2 in-session driver / orchestrator).
 *  - `registerAbortController()` — the driver registers its signal so a pause /
 *                       cancel can fire it before the next persist.
 *
 * Execution (`runPlan`) lands in P2; here it is a guarded stub so the lifecycle
 * is fully exercisable on its own.
 *
 * Import-side singleton — one per renderer process; tests reset via
 * `__resetPlanRuntimeForTesting()`.
 */

import type {
  AgentPlan,
  CreatePlanInput,
  PlanConfig,
  PlanStatus,
  PlanStep,
  PlanStepStatus,
  UpdatePlanInput,
} from "@/types/agent/plan"
import { DEFAULT_PLAN_CONFIG, computePlanCounts, isTerminalPlanStatus } from "@/types/agent/plan"
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
import { isTauri } from "@/lib/platform/detect"
import { applyStepStatus, materializeSteps } from "./steps"
import type { SynthesizePlanResult } from "./synthesize-workflow"

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
      await updatePlan(existing.id, { status: "cancelled", generationId: crypto.randomUUID() })
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

  /** Reject a pending plan → `cancelled`, recording optional feedback. */
  async rejectPlan(planId: string, feedback?: string): Promise<AgentPlan | null> {
    const current = await getPlan(planId)
    if (!current) return null
    if (isTerminalPlanStatus(current.status)) return current
    this.fireAbort(planId)
    await updatePlan(planId, { status: "cancelled", generationId: crypto.randomUUID() })
    await appendPlanEvent({ planId, kind: "rejected", payload: { kind: "rejected", feedback } })
    const updated = (await getPlan(planId)) ?? null
    void emitPlanStatus(updated)
    return updated
  }

  /** Pause an executing plan → `paused`; fires the run's AbortController. */
  async pausePlan(planId: string): Promise<AgentPlan | null> {
    const current = await getPlan(planId)
    if (!current) return null
    if (current.status !== "executing") return current
    this.fireAbort(planId)
    await updatePlan(planId, { status: "paused", generationId: crypto.randomUUID() })
    await appendPlanEvent({ planId, kind: "paused", payload: { kind: "paused" } })
    const updated = (await getPlan(planId)) ?? null
    void emitPlanStatus(updated)
    return updated
  }

  /** Resume a paused plan → `executing`. Re-driving is handled by `runPlan` (P2). */
  async resumePlan(planId: string): Promise<AgentPlan | null> {
    const current = await getPlan(planId)
    if (!current) return null
    if (current.status !== "paused") return current
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
    await updatePlan(planId, { status: "cancelled", generationId: crypto.randomUUID() })
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
    return (await getPlan(planId)) ?? null
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
    opts: { signal?: AbortSignal } = {}
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

    planRunCtx.registerPlanRunContext({
      runId,
      planId,
      plan: executing,
      ...(executing.characterId ? { characterId: executing.characterId } : {}),
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
      return { status, output: result.output }
    } finally {
      planRunCtx.unregisterPlanRunContext(runId)
      unregisterAbort()
    }
  }

  /** Transition a finished run to its terminal status + log the exit event. */
  private async finishPlanRun(planId: string, status: PlanStatus, reason?: string): Promise<void> {
    const current = await getPlan(planId)
    // A concurrent pause / cancel may have already moved the plan terminal —
    // don't overwrite a user-driven cancellation with a derived failure.
    if (!current || isTerminalPlanStatus(current.status)) return
    if (current.status === "paused") return
    await updatePlan(planId, { status, generationId: crypto.randomUUID() })
    await appendPlanEvent({
      planId,
      kind: "exit",
      payload: { kind: "exit", status, reason: reason ?? `plan run ${status}` },
    })
    const updated = await getPlan(planId)
    void emitPlanStatus(updated ?? null)
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
    await deletePlan(planId)
  }
}

/**
 * Broadcast a plan status snapshot to companion WebSocket subscribers as a
 * `plan://status` Tauri event so a remote watcher sees transitions live.
 * Mirrors `lib/goal/runtime.ts:emitGoalStatus`: lazy Tauri import so the web
 * build stays decoupled; failures are swallowed (the Dexie write succeeded).
 */
async function emitPlanStatus(plan: AgentPlan | null): Promise<void> {
  if (!plan) return
  if (!isTauri()) return
  try {
    const moduleId = "@tauri-apps/api/event"
    const mod = (await import(/* webpackIgnore: true */ moduleId)) as {
      emit: (event: string, payload: unknown) => Promise<void>
    }
    await mod.emit("plan://status", {
      planId: plan.id,
      sessionId: plan.sessionId,
      status: plan.status,
    })
  } catch {
    // Tauri unavailable or transport hiccup — best effort.
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
