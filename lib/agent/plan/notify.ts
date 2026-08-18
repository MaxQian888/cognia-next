/**
 * Side-channel notifications for plan lifecycle transitions (ADR-0045 §5).
 *
 * Extracted from `runtime.ts` so the in-session turn driver — which owns the
 * terminal transition for the conversational path exactly as the runtime owns
 * it for the orchestrated path — fires the SAME companion event, scheduler
 * event and notification-center row. Two executors, one notification contract;
 * a plan that finished in chat must be indistinguishable, to a remote watcher
 * or an event-triggered scheduled task, from one that finished under the
 * orchestrator.
 *
 * Three fan-outs:
 *   • `plan://status`      — live companion WS frame (`event_channels.rs`).
 *   • `plan:completed`     — scheduler event, so event-triggered tasks chain.
 *   • notification center  — a durable row a human actually sees when the app
 *     is not in front of them. A plan waiting for approval is `directed` and
 *     carries Approve / Reject actions; a terminal plan is ambient.
 *
 * Every one is best-effort by design: the Dexie write already succeeded, so a
 * transport hiccup must never surface as a failed plan.
 */

import type { AgentPlan, PlanStatus } from "@/types/agent/plan"
import { isTauri } from "@/lib/platform/detect"
import { registerNotificationCommand } from "@/lib/notifications/action-registry"

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

// ─────────────────────────────────────────────────────────────────────────────
// Notification center (ADR-0042)
// ─────────────────────────────────────────────────────────────────────────────

/** Notification-action command key (persisted on center rows). */
export const PLAN_RESPOND_COMMAND = "plan.approval.respond"

/** Copy is English by precedent for runtime notifications (TeamNotifier, approval-notify). */
const TERMINAL_COPY: Partial<Record<PlanStatus, { level: "success" | "error"; verb: string }>> = {
  completed: { level: "success", verb: "completed" },
  failed: { level: "error", verb: "failed" },
  cancelled: { level: "success", verb: "was cancelled" },
}

async function centerNotify(
  input: Parameters<typeof import("@/lib/notifications/runtime").notify>[0]
) {
  const { notify } = await import("@/lib/notifications/runtime")
  return notify(input)
}

/**
 * A plan is waiting for a human. Directed (counts toward the badge) and
 * carries the two decisions inline, so the answer does not require finding the
 * originating chat session first.
 */
export async function notifyPlanAwaitingApproval(plan: AgentPlan): Promise<void> {
  if (plan.status !== "awaiting_approval") return
  try {
    await centerNotify({
      source: "session",
      level: "warning",
      title: `Plan awaiting approval: ${plan.title}`,
      body: `${plan.totalSteps} step(s) · ${plan.source.replace(/_/g, " ")}`,
      href: `/?session=${plan.sessionId}`,
      dedupeKey: `plan-approval:${plan.id}`,
      groupKey: plan.sessionId,
      directed: true,
      icon: "ListChecks",
      sourceRef: { kind: "plan", id: plan.id },
      actions: [
        {
          id: "approve",
          label: "Approve",
          command: PLAN_RESPOND_COMMAND,
          args: { planId: plan.id, decision: "approve" },
          variant: "primary",
        },
        {
          id: "reject",
          label: "Discard",
          command: PLAN_RESPOND_COMMAND,
          args: { planId: plan.id, decision: "reject" },
          variant: "secondary",
        },
      ],
    })
  } catch {
    // Center unavailable (headless / web) — the dock still shows the plan.
  }
}

/**
 * A plan reached a terminal status. Ambient (no badge): the user did not ask
 * for this, it is progress reporting — the same posture the scheduler and team
 * runtimes take for their own completions.
 */
export async function notifyPlanTerminal(plan: AgentPlan, status: PlanStatus): Promise<void> {
  const copy = TERMINAL_COPY[status]
  if (!copy) return
  try {
    await centerNotify({
      source: "session",
      level: copy.level,
      title: `Plan ${copy.verb}: ${plan.title}`,
      body: `${plan.completedSteps}/${plan.totalSteps} steps`,
      href: `/?session=${plan.sessionId}`,
      dedupeKey: `plan-exit:${plan.id}`,
      groupKey: plan.sessionId,
      icon: "ListChecks",
      sourceRef: { kind: "plan", id: plan.id },
    })
  } catch {
    // Best-effort.
  }
}

/**
 * Install the notification-action handler for the Approve / Discard buttons.
 * Mounted once at boot (`PlanNotificationInitializer`); returns the
 * unregister function. Without it the actions render and do nothing — the
 * exact built-but-dormant shape this subsystem already paid for once.
 */
export function installPlanNotificationActions(): () => void {
  return registerNotificationCommand(PLAN_RESPOND_COMMAND, async (ctx) => {
    const planId = ctx.args?.planId
    const decision = ctx.args?.decision
    if (typeof planId !== "string") return
    if (decision !== "approve" && decision !== "reject") return
    const { getPlanRuntime } = await import("./runtime")
    const runtime = getPlanRuntime()
    if (decision === "reject") {
      await runtime.rejectPlan(planId)
      return
    }
    await runtime.approvePlan(planId)
    // Orchestrated plans can start headlessly from here; an in-session plan is
    // handed to the chat surface that owns its visible turns (same split as
    // the run-control `approve` command).
    const started = await runtime.startPlan(planId)
    if (started?.strategy === "orchestrated") void runtime.runPlan(planId)
  })
}
