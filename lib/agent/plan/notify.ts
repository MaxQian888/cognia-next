/**
 * Side-channel notifications for plan lifecycle transitions (ADR-0045).
 *
 * Extracted from `runtime.ts` so the in-session turn driver — which owns the
 * terminal transition for the conversational path exactly as the runtime owns
 * it for the orchestrated path — fires the SAME companion event and scheduler
 * event. Two executors, one notification contract; a plan that finished in
 * chat must be indistinguishable, to a remote watcher or an event-triggered
 * scheduled task, from one that finished under the orchestrator.
 *
 * Both are best-effort by design: the Dexie write already succeeded, so a
 * transport hiccup must never surface as a failed plan.
 */

import type { AgentPlan, PlanStatus } from "@/types/agent/plan"
import { isTauri } from "@/lib/platform/detect"

/**
 * Broadcast a plan status snapshot to companion WebSocket subscribers as a
 * `plan://status` Tauri event so a remote watcher sees transitions live.
 * Mirrors `lib/goal/runtime.ts:emitGoalStatus`: lazy Tauri import so the web
 * build stays decoupled; failures are swallowed.
 */
export async function emitPlanStatus(plan: AgentPlan | null | undefined): Promise<void> {
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

/**
 * Emit a `plan:completed` scheduler event when a plan run reaches a terminal
 * status, so event-triggered scheduled tasks (and forward chains) can react.
 * Lazy import + best-effort, mirroring the goal completion linkage.
 */
export async function emitPlanCompletedSchedulerEvent(
  planId: string,
  status: PlanStatus
): Promise<void> {
  try {
    const { emitSchedulerEvent } = await import("@/lib/scheduler/event-integration")
    await emitSchedulerEvent("plan:completed", { planId, status }, "plan")
  } catch {
    // Scheduler unavailable (e.g. web-only path) — best-effort.
  }
}
