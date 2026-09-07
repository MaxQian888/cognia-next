/**
 * In-process fan-out of plan trail activity (ADR-0045).
 *
 * `agentPlanEvents` is append-only and read back through Dexie, which serves
 * the tracker panel and gives a workflow trigger nothing to subscribe to
 * without polling. `lib/db/plans.ts:appendPlanEvent` publishes every appended
 * entry here after its write commits, so a subscriber only ever sees rows that
 * exist. Same shape as `lib/issues/event-bus.ts`: one `EventTarget`, a typed
 * `emit`, and `on*` returning a disposer, with a throwing handler logged
 * rather than allowed to break the write path or its siblings.
 */

import type { PlanEvent, PlanEventKind } from "@/types/agent/plan"

const EVENT_NAME = "plans:event"
const bus: EventTarget = new EventTarget()

export type PlanEventListener = (event: PlanEvent) => void

/** Publish one committed trail entry. Called by the append path only. */
export function emitPlanEvent(event: PlanEvent): void {
  bus.dispatchEvent(new CustomEvent<PlanEvent>(EVENT_NAME, { detail: event }))
}

export interface OnPlanEventOptions {
  /** Only these kinds. Absent means every kind. */
  kinds?: readonly PlanEventKind[]
  /** Only this plan. */
  planId?: string
}

/** Subscribe. Returns the disposer. */
export function onPlanEvent(
  handler: PlanEventListener,
  options: OnPlanEventOptions = {}
): () => void {
  const kinds = options.kinds ? new Set<PlanEventKind>(options.kinds) : null
  const listener = (raw: Event) => {
    const event = (raw as CustomEvent<PlanEvent>).detail
    if (!event) return
    if (kinds && !kinds.has(event.kind)) return
    if (options.planId && event.planId !== options.planId) return
    try {
      handler(event)
    } catch (error) {
      console.error(
        `[agent/plan/plan-event-bus] handler threw for ${event.kind} on ${event.planId}:`,
        error instanceof Error ? error.message : String(error)
      )
    }
  }
  bus.addEventListener(EVENT_NAME, listener)
  return () => bus.removeEventListener(EVENT_NAME, listener)
}
