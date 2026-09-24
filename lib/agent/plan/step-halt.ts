/**
 * In-session step supervision helpers (ADR-0045 §2, in-session driver).
 *
 * Shared by the four parties that care whether an in-session step is still
 * alive, so they agree on one vocabulary:
 *
 *   - the turn driver stamps every dispatch with {@link PLAN_RENDERER_BOOT_ID};
 *   - the runtime records a {@link PlanStepHalt} when a step stops unfinished;
 *   - the boot recovery sweep treats a foreign boot id as an orphan (a chat
 *     turn cannot outlive the renderer that sent it) — unless that renderer
 *     is still open in another window or tab ({@link liveRendererBootIds});
 *   - the tracker's step-failure card renders the halt.
 *
 * Pure apart from the per-load boot id and the renderer liveness lock, so
 * every consumer stays testable without Dexie or the chat store.
 */

import type { AgentPlan, PlanStep, PlanStepHalt } from "@/types/agent/plan"

/**
 * Identity of THIS renderer load. Minted once per module instance, which is
 * once per page load: an app restart (or a reload) mints a new one, and that
 * is exactly the boundary across which an in-session turn cannot survive.
 */
export const PLAN_RENDERER_BOOT_ID: string = crypto.randomUUID()

/**
 * When this renderer load began supervising plans (module evaluation time).
 * A row last written BEFORE this instant was written by an earlier load; one
 * written after it may be mid-dispatch in this one, so recovery leaves it be.
 */
export const PLAN_RENDERER_BOOTED_AT: number = Date.now()

/**
 * Name prefix of the Web Lock each dispatching renderer holds under its boot
 * id. A boot id is per load, but a load is not per database: every window and
 * tab of this origin shares the plans table, so "not my boot id" alone would
 * let a second window halt a turn the first one is still running.
 */
const RENDERER_LOCK_PREFIX = "cognia.plan-renderer:"

type RendererLocks = Pick<LockManager, "request" | "query">

function rendererLocks(): RendererLocks | null {
  try {
    const locks = (globalThis.navigator as Navigator | undefined)?.locks
    return locks && typeof locks.request === "function" && typeof locks.query === "function"
      ? locks
      : null
  } catch {
    return null
  }
}

let holdingRendererLock = false

/**
 * Hold this renderer's liveness lock until the page goes away (the browser
 * releases it on unload, reload or crash). Called by the turn driver before it
 * stamps a dispatch with {@link PLAN_RENDERER_BOOT_ID}. Idempotent; a runtime
 * without Web Locks holds nothing, and recovery then falls back to the boot id.
 */
export function holdPlanRendererLock(): void {
  if (holdingRendererLock) return
  const locks = rendererLocks()
  if (!locks) return
  holdingRendererLock = true
  void locks
    .request(`${RENDERER_LOCK_PREFIX}${PLAN_RENDERER_BOOT_ID}`, () => new Promise<never>(() => {}))
    .catch(() => {
      holdingRendererLock = false
    })
}

/**
 * Boot ids of the renderers alive right now across this origin's windows and
 * tabs (each holding its lock), or `null` when the runtime cannot tell.
 */
export async function liveRendererBootIds(): Promise<ReadonlySet<string> | null> {
  const locks = rendererLocks()
  if (!locks) return null
  try {
    const snapshot = await locks.query()
    const live = new Set<string>()
    for (const lock of snapshot.held ?? []) {
      if (lock.name?.startsWith(RENDERER_LOCK_PREFIX)) {
        live.add(lock.name.slice(RENDERER_LOCK_PREFIX.length))
      }
    }
    return live
  } catch {
    return null
  }
}

/** Test-only: forget that this module requested its lock. */
export function __resetPlanRendererLockForTesting(): void {
  holdingRendererLock = false
}

/** The step a halt names, when it still exists in the plan. */
export function haltedStep(plan: Pick<AgentPlan, "steps" | "stepHalt">): PlanStep | undefined {
  const stepId = plan.stepHalt?.stepId
  return stepId ? plan.steps.find((step) => step.id === stepId) : undefined
}

/** 1-based position of a step in display order, or 0 when it is not in the plan. */
export function stepDisplayIndex(plan: Pick<AgentPlan, "steps">, stepId: string): number {
  const ordered = [...plan.steps].sort((a, b) => a.order - b.order)
  return ordered.findIndex((step) => step.id === stepId) + 1
}

/**
 * True when the in-session step turn a plan is waiting on was dispatched by a
 * renderer other than this one — or by none that recorded itself (a row
 * written before dispatch stamps existed). Only meaningful for an `executing`
 * in-session plan; the caller checks both.
 */
export function isOrphanedTurnDispatch(
  plan: Pick<AgentPlan, "turnDispatch">,
  bootId: string = PLAN_RENDERER_BOOT_ID
): boolean {
  return plan.turnDispatch?.bootId !== bootId
}

/**
 * The trail's `exit` reason for a halt. English by the same precedent as the
 * rest of the plan trail (`finishPlanRun` reasons, hook-block reasons): it is
 * an audit record, and the UI localizes from `stepHalt.cause`, not from this.
 */
export function haltTrailReason(
  step: Pick<PlanStep, "title"> | undefined,
  halt: Pick<PlanStepHalt, "cause" | "detail">
): string {
  const subject = step ? `step "${step.title}"` : "the in-session run"
  return `${subject} stopped (${halt.cause}): ${halt.detail}`
}
