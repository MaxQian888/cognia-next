/**
 * How much support a project claim's evidence still gives it, and what that
 * means for the row.
 *
 * A mined claim is a statement about a repository that will be injected into
 * future turns. Its right to be injected comes entirely from evidence that can
 * be re-checked — a message that still exists and still says what it said. This
 * module turns a set of re-check verdicts into the two fields the retriever
 * already reads (`staleness`, and whether the row should be invalidated), so
 * the recall path needs no new concepts at all. That reuse is the point: the
 * alternative was inventing a "claim confidence" the scorer would have to learn.
 *
 * Weights, and why they are not all 1:
 *
 * - A verdict of `valid` is worth full support; `unvalidated` is worth a
 *   fraction. Never-checked is NOT the same as checked-and-fine, and a claim
 *   resting entirely on unchecked evidence should not read as freshly confirmed.
 * - `user-confirmation` outranks everything the miner concluded. A human saying
 *   "yes, that is how this repo works" is better evidence than any number of
 *   transcript citations.
 * - `revoked` is not weighed against anything — a single revoked citation drops
 *   support to zero. Evidence that has been deleted or altered cannot be
 *   outvoted by evidence that merely still exists, because we no longer know
 *   what the claim was actually derived from.
 * - `code-location` contributes nothing. It is recorded but deliberately not
 *   checkable on every shell (mobile and web cannot stat a path), so counting it
 *   would make the same claim stronger on desktop than on a phone.
 *
 * Pure: no I/O, no clock.
 */

import type { MemoryEvidence, MemoryValidationState } from "../types/governance"
import type { MemoryStaleness } from "../types/memory"

/** Support below which a claim is no longer worth injecting at all. */
export const CLAIM_SUPPORT_INVALIDATE_AT = 0

/** Support below which a claim is injected but marked stale. */
export const CLAIM_SUPPORT_FRESH_AT = 1

export interface ClaimSupportVerdict {
  /** Total weighted support. */
  support: number
  /** How many citations were counted at all. */
  counted: number
  /** True when at least one citation came back `revoked`. */
  revoked: boolean
  /** What `Memory.staleness` should become. */
  staleness: MemoryStaleness
  /** True when the claim should be soft-invalidated. */
  invalidate: boolean
}

function stateOf(evidence: Pick<MemoryEvidence, "validationState">): MemoryValidationState {
  return evidence.validationState ?? "unvalidated"
}

function weightOf(
  evidence: Pick<MemoryEvidence, "kind" | "validationStrategy" | "validationState">
): number {
  if (evidence.kind === "code-location" || evidence.validationStrategy === "none") return 0
  const state = stateOf(evidence)
  if (state === "revoked" || state === "unverifiable") return 0
  if (evidence.validationStrategy === "user-confirmation") return state === "valid" ? 2 : 0
  return state === "valid" ? 1 : 0.3
}

/**
 * Fold re-check verdicts into a row decision.
 *
 * An EMPTY evidence set does not invalidate. A claim with no citations at all is
 * one the sweep has nothing to say about — usually a row whose evidence writes
 * failed, or one imported from a backup, which carries descriptors but never
 * verdicts. Treating "nothing to check" as "checked and false" would delete
 * restored memories on the first sweep after an import.
 */
export function assessClaimSupport(
  evidence: readonly Pick<MemoryEvidence, "kind" | "validationStrategy" | "validationState">[]
): ClaimSupportVerdict {
  if (evidence.length === 0) {
    return { support: 0, counted: 0, revoked: false, staleness: "unknown", invalidate: false }
  }

  const revoked = evidence.some((item) => stateOf(item) === "revoked")
  const support = revoked ? 0 : evidence.reduce((total, item) => total + weightOf(item), 0)
  const counted = evidence.filter((item) => weightOf(item) > 0).length

  if (support <= CLAIM_SUPPORT_INVALIDATE_AT) {
    return { support, counted, revoked, staleness: "expired", invalidate: true }
  }
  if (support < CLAIM_SUPPORT_FRESH_AT) {
    return { support, counted, revoked, staleness: "stale", invalidate: false }
  }
  return { support, counted, revoked, staleness: "fresh", invalidate: false }
}
