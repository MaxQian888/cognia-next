import type { CanonicalSession } from "@cognia/agent-config-types/canonical-session"
import type { ThreadHandoffTicket } from "@cognia/agent-config-types/thread-handoff"

import {
  HostDispatchDeliveryError,
  registerHostDispatchDelivery,
  type HostDispatchDelivery,
} from "@/lib/placement/host-dispatch-delivery"
import { emitCompanionEvent } from "@/lib/workflow/runtime/companion-run-events"

import { THREAD_HANDOFF_OFFER_CHANNEL, type ThreadHandoffOfferFrame } from "./orchestrator"

export interface ThreadHandoffDeliveryDependencies {
  emit?: (event: string, payload: unknown) => Promise<void>
  /** Injected for tests; defaults to the Dexie sweep. */
  sweep?: (now: number) => Promise<unknown>
  /** How often to retire expired tickets. */
  sweepIntervalMs?: number
}

/**
 * How often the expiry sweep runs. Well under the 30-minute ticket TTL, so a
 * ticket that expires is retired within one interval rather than sitting on a
 * `handoffLock` that makes its session permanently read-only.
 */
export const THREAD_HANDOFF_SWEEP_INTERVAL_MS = 5 * 60_000

export function createThreadHandoffDelivery(
  dependencies: ThreadHandoffDeliveryDependencies = {}
): HostDispatchDelivery {
  const emit = dependencies.emit ?? emitCompanionEvent
  return async (job) => {
    const ticket = job.payload.ticket as ThreadHandoffTicket | undefined
    const envelope = job.payload.envelope as CanonicalSession | undefined
    if (
      job.kind !== "offer" ||
      !ticket ||
      !envelope ||
      ticket.ticketId !== job.id ||
      ticket.target.hostRef !== job.targetRef ||
      ticket.role !== "target"
    ) {
      throw new HostDispatchDeliveryError(
        "malformed",
        false,
        "thread-handoff offer payload is malformed"
      )
    }
    try {
      await emit(THREAD_HANDOFF_OFFER_CHANNEL, {
        ticket,
        envelope,
      } satisfies ThreadHandoffOfferFrame)
      return "awaiting-result"
    } catch (error) {
      throw new HostDispatchDeliveryError(
        "dispatch_failed",
        true,
        `thread-handoff dispatch failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
}

/**
 * Register the offer delivery AND the expiry sweep.
 *
 * They share a lifecycle on purpose: a host that can receive an offer is a host
 * that can strand one. `sweepExpiredThreadHandoffTickets` is the only thing
 * that aborts an expired `preparing` ticket, and an unswept ticket leaves its
 * session's `handoffLock` set forever — every ordinary write then throws
 * `SessionHandoffLockedError` with no automatic recovery.
 */
export function registerThreadHandoffDelivery(
  dependencies: ThreadHandoffDeliveryDependencies = {}
): () => void {
  const unregister = registerHostDispatchDelivery(
    "thread-handoff",
    createThreadHandoffDelivery(dependencies)
  )
  const sweep =
    dependencies.sweep ??
    (async (now: number) => {
      const { sweepExpiredThreadHandoffTickets } = await import("@/lib/db/thread-handoff-tickets")
      return sweepExpiredThreadHandoffTickets(now)
    })
  const runSweep = () => {
    // Best-effort: a sweep failure (no Dexie on this host, a locked upgrade)
    // must never take the delivery registration down with it.
    void Promise.resolve(sweep(Date.now())).catch(() => {})
  }
  runSweep()
  const timer = setInterval(
    runSweep,
    dependencies.sweepIntervalMs ?? THREAD_HANDOFF_SWEEP_INTERVAL_MS
  )
  return () => {
    clearInterval(timer)
    unregister()
  }
}
