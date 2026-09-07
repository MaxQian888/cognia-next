/**
 * `trigger.plan.event` runner (ADR-0045).
 *
 * `action.plan.*` has seventeen nodes and, until this, no trigger at all: a
 * graph could drive a plan but could not react to one, so anything waiting on
 * an approval or a failure had to poll.
 *
 * Subscribes `lib/agent/plan/plan-event-bus.ts`, which `appendPlanEvent`
 * publishes after each write commits. Both executors write through that one
 * append, so a plan that finished in a chat turn is indistinguishable from one
 * that finished under the orchestrator, which is the contract the plan runtime
 * states for itself.
 */

import { loggers } from "@cognia/logging"
import type { PlanEvent } from "@/types/agent/plan"
import {
  createFanOutState,
  disposeFanOut,
  fanOutTrigger,
  type TriggerFanOutState,
} from "./trigger-fan-out"

const log = loggers.scheduler

let state: TriggerFanOutState | null = null

/** Plans this runner's own dispatches created, so it cannot chase itself. */
const dispatchedPlans = new Map<string, number>()
const SELF_PLAN_WINDOW_MS = 30_000

async function onPlanEvent(event: PlanEvent): Promise<void> {
  const s = state
  if (!s || !s.active) return
  try {
    const { getPlan } = await import("@/lib/db/plans")
    const plan = await getPlan(event.planId)

    const payload: Record<string, unknown> = {
      kind: event.kind,
      at: event.ts,
      eventId: event.id,
      planId: event.planId,
      ...(plan
        ? {
            title: plan.title,
            status: plan.status,
            source: plan.source,
            sessionId: plan.sessionId,
            characterId: plan.characterId,
            totalSteps: plan.totalSteps,
            completedSteps: plan.completedSteps,
          }
        : {}),
      event: event.payload,
    }

    await fanOutTrigger({
      state: s,
      kind: "trigger.plan.event",
      match: {
        planEventKind: event.kind,
        planId: event.planId,
        status: plan?.status,
        sessionId: plan?.sessionId,
        characterId: plan?.characterId,
        planSource: plan?.source,
      },
      payload,
      // A workflow whose own dispatch minted this plan must not react to it.
      // The cooldown only narrows that window, so this closes it outright.
      reject: (workflowId) => {
        const stamped = dispatchedPlans.get(`${workflowId}::${event.planId}`)
        if (stamped === undefined) return null
        return s.now() - stamped < SELF_PLAN_WINDOW_MS ? "it created this plan" : null
      },
    })
  } catch (error) {
    log.warn("plan-event-trigger: dispatch failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Record that a workflow's run created a plan, for the self-rejection above. */
export function notePlanCreatedByWorkflow(workflowId: string, planId: string): void {
  const s = state
  if (!s) return
  dispatchedPlans.set(`${workflowId}::${planId}`, s.now())
}

export function initPlanEventTrigger(deps: { now?: () => number } = {}): void {
  if (typeof window === "undefined") return
  disposePlanEventTrigger()
  const s = createFanOutState(deps.now ?? Date.now)
  state = s
  void import("@/lib/agent/plan/plan-event-bus")
    .then(({ onPlanEvent: subscribe }) => {
      if (!state || state !== s || !s.active) return
      s.unsubscribe = subscribe((event) => void onPlanEvent(event))
    })
    .catch((error) => {
      log.warn("plan-event-trigger: subscribe failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    })
}

export function disposePlanEventTrigger(): void {
  disposeFanOut(state)
  state = null
  dispatchedPlans.clear()
}

/** Test-only: drive one event through the runner without the live bus. */
export async function _injectPlanEventForTest(event: PlanEvent): Promise<void> {
  await onPlanEvent(event)
}
