/**
 * The recipients of a parked outbound tool request, for the phone that answers
 * it (ADR-0239, ADR-0224 A7).
 *
 * A parked request's interrupt row (`executionRunInterrupts`) is metadata-only
 * and never holds a recipient. The recipients live here, in the memory of the
 * host process that parked the request, for exactly as long as the request
 * waits: the park records them before it announces the interrupt and drops
 * them when the wait ends. A request whose host restarted is no longer waiting
 * on anyone, so nothing is lost with the memory.
 *
 * `listRunApprovals` reads them into the phone's summary; `respondRunApproval`
 * uses them to decide whether "allow for this request" may be offered.
 */

import type { PendingOutboundReview } from "@cognia/agent-config-types"

/** More parked requests than one host ever holds at once; the oldest go first. */
export const MAX_PARKED_OUTBOUND = 256

const parked = new Map<string, PendingOutboundReview>()

/** Remember the recipients of the parked request behind `interruptId`. */
export function rememberRunApprovalOutbound(
  interruptId: string,
  review: PendingOutboundReview
): void {
  parked.delete(interruptId)
  parked.set(interruptId, review)
  while (parked.size > MAX_PARKED_OUTBOUND) {
    const oldest = parked.keys().next().value
    if (oldest === undefined) break
    parked.delete(oldest)
  }
}

/** The recipients of a parked request, or `undefined` when it named none. */
export function runApprovalOutbound(interruptId: string): PendingOutboundReview | undefined {
  return parked.get(interruptId)
}

/** Forget a request once nobody waits on it. */
export function forgetRunApprovalOutbound(interruptId: string): void {
  parked.delete(interruptId)
}

export function __resetRunApprovalOutboundForTesting(): void {
  parked.clear()
}
