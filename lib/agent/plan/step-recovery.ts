/**
 * Boot recovery for in-session plan steps (ADR-0045 §2, in-session driver).
 *
 * Extends the direct-chat recovery (`recoverStaleDirectChatExecutionRuns`,
 * `lib/execution/direct-chat-run.ts`) to the plans those turns belong to. A
 * direct-chat turn cannot keep executing across a renderer restart — that
 * module's own contract — so an in-session plan left `executing` with a step
 * `in_progress` by a previous load is waiting on a turn that no longer exists.
 * Before this, nothing noticed: the step sat `in_progress` forever and the
 * tracker offered only Pause / Cancel.
 *
 * Same posture as the execution-run recovery: explicit, not invented. The step
 * is not guessed complete and the plan is not failed; the step is marked
 * `failed` with cause `interrupted` and the plan halts `paused` on it through
 * `PlanRuntime.failInSessionStep`, so the tracker card offers retry / skip /
 * mark done / cancel.
 *
 * Orchestrated plans are out of scope here: their steps belong to a workflow
 * run, which the workflow resume controller replays at boot.
 */

import { listPlansByStatus } from "@/lib/db/plans"
import {
  PLAN_RENDERER_BOOTED_AT,
  PLAN_RENDERER_BOOT_ID,
  isOrphanedTurnDispatch,
  liveRendererBootIds,
} from "./step-halt"
import { currentInProgressStep } from "./steps"
import { resolvePlanStrategy } from "./strategy"

export interface PlanStepRecoveryOptions {
  bootId?: string
  bootedAt?: number
  /** Boot ids of renderers still open elsewhere (default: their Web Locks). */
  liveBootIds?: () => Promise<ReadonlySet<string> | null>
}

/**
 * Halt every executing in-session plan whose in-flight turn was dispatched by
 * an earlier renderer load. Returns how many plans were halted.
 */
export async function recoverOrphanedInSessionSteps(
  options: PlanStepRecoveryOptions = {}
): Promise<number> {
  const bootId = options.bootId ?? PLAN_RENDERER_BOOT_ID
  const bootedAt = options.bootedAt ?? PLAN_RENDERER_BOOTED_AT
  const executing = await listPlansByStatus("executing")
  if (executing.length === 0) return 0
  const { getPlanRuntime } = await import("./runtime")
  const runtime = getPlanRuntime()
  // Another window or tab of this origin is its own renderer load with its
  // own boot id, and it shares these rows: its turns are alive, not orphans.
  const live = await (options.liveBootIds ?? liveRendererBootIds)()
  let recovered = 0
  for (const plan of executing) {
    if (resolvePlanStrategy(plan) !== "in_session") continue
    // This load dispatched it (the watchdog owns it), or this load touched the
    // row after booting (a dispatch may be between its status write and its
    // stamp) — either way it is not an orphan.
    if (!isOrphanedTurnDispatch(plan, bootId)) continue
    const dispatcher = plan.turnDispatch?.bootId
    if (dispatcher && live?.has(dispatcher)) continue
    if (plan.updatedAt >= bootedAt) continue
    const step = currentInProgressStep(plan.steps, plan.currentStepId)
    const halted = await runtime.failInSessionStep(plan.id, {
      ...(step ? { stepId: step.id } : {}),
      cause: "interrupted",
      detail: step
        ? "the app restarted while this step's turn was running"
        : "the app restarted between plan steps",
      capturedGenerationId: plan.generationId,
    })
    if (halted?.status === "paused") recovered += 1
  }
  return recovered
}

let pending: Promise<number> | null = null

/**
 * Run the recovery once per renderer load. Called by the plan surfaces every
 * chat view mounts (tracker dock, plan panel): an in-session plan can only be
 * driven from a chat surface, so the sweep runs before one can be shown. A
 * failed sweep is logged and may be retried by the next mount.
 */
export function ensurePlanStepRecovery(): Promise<number> {
  if (!pending) {
    pending = recoverOrphanedInSessionSteps().catch((error: unknown) => {
      console.warn("plan step recovery failed", error)
      pending = null
      return 0
    })
  }
  return pending
}

/** Test-only: forget that the sweep ran. */
export function __resetPlanStepRecoveryForTesting(): void {
  pending = null
}
