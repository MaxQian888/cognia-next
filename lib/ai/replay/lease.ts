/**
 * Per-actor tape leases and the end-of-run consumption check (ADR-0118).
 *
 * The naive design — one ordered queue of recorded responses, popped per call —
 * breaks the moment a run has more than one actor. A parent and two children
 * interleave differently on every execution, so a global cursor makes replay
 * flaky in a way that looks like a product bug.
 *
 * So each actor takes a lease over its own tapes and matches on
 * `(purpose, requestDigest)` against the ones it has not consumed yet. Order
 * within an actor is irrelevant; order across actors cannot interfere at all.
 *
 * The other half is refusing to pass quietly. A replay that answered three of
 * five recorded requests has not reproduced the run, so `assertConsumed`
 * reports leftovers, unmatched requests, and the runner's own loose ends.
 */

import { findAmbiguousTapes } from "@cognia/agent-config-types/model-request-surface"
import type {
  ModelRequestPurpose,
  ReplayTapeV1,
} from "@cognia/agent-config-types/model-request-surface"

export interface ReplayMatchQuery {
  purpose: ModelRequestPurpose
  requestDigest: string
}

/** An unmatched request, kept for the failure report rather than thrown at once. */
export interface UnmatchedReplayRequest {
  actorRef: string
  purpose: ModelRequestPurpose
  requestDigest: string
}

export interface ReplayLease {
  readonly actorRef: string
  /**
   * Take the next tape matching this request, or `undefined`.
   *
   * A miss is recorded on the ledger instead of throwing: the run should be
   * allowed to fail the way it naturally fails (a provider error, a timeout)
   * so the report shows both the missing tape and its downstream effect.
   */
  take(query: ReplayMatchQuery): ReplayTapeV1 | undefined
  /**
   * Take a tape by request digest alone, when the caller could not supply a
   * purpose.
   *
   * The provider SDKs do not forward a "why am I calling the model" signal, so
   * a replayed compaction or title call arrives indistinguishable from a turn.
   * Rather than guess the purpose from the prompt — which would be a heuristic
   * in the one place that must be exact — this matches on the strong key and
   * refuses when the digest alone is ambiguous across purposes, which is
   * reported as an unmatched request rather than answered arbitrarily.
   */
  takeByDigest(requestDigest: string): ReplayTapeV1 | undefined
  /** Tapes this actor was given and has not used. */
  remaining(): ReplayTapeV1[]
}

/** Loose ends the runner knows about and the ledger cannot see for itself. */
export interface RunnerLooseEnds {
  unconsumedPermissions?: string[]
  unfinishedChildren?: string[]
  orphanedLogs?: string[]
}

export interface ReplayConsumptionProblem {
  kind:
    | "unconsumed-tape"
    | "unmatched-request"
    | "unconsumed-permission"
    | "unfinished-child"
    | "orphaned-log"
  actorRef?: string
  detail: string
}

export interface ReplayConsumptionReport {
  ok: boolean
  problems: ReplayConsumptionProblem[]
}

export interface ReplayLedger {
  /**
   * Open (or reuse) the lease for an actor.
   *
   * Reuse matters: a child agent that is resumed after an interrupt is the same
   * actor and must keep its already-consumed set, or its first post-resume call
   * would re-consume a tape the pre-interrupt run already used.
   */
  lease(actorRef: string): ReplayLease
  assertConsumed(looseEnds?: RunnerLooseEnds): ReplayConsumptionReport
}

export class AmbiguousReplayTapesError extends Error {
  readonly keys: string[]

  constructor(keys: string[]) {
    super(
      `replay tapes are ambiguous for ${keys.length} match key(s): ${keys.join(", ")}. ` +
        "Two tapes with the same actor, purpose and request digest must not have different behaviours."
    )
    this.name = "AmbiguousReplayTapesError"
    this.keys = keys
  }
}

/**
 * Build a ledger over a tape set.
 *
 * Ambiguity is rejected up front rather than at match time. Discovering it
 * mid-run would mean some requests already got answers, so the failure would
 * arrive with a half-executed side-effect trail behind it.
 */
export function createReplayLedger(tapes: readonly ReplayTapeV1[]): ReplayLedger {
  const ambiguous = findAmbiguousTapes(tapes)
  if (ambiguous.length > 0) throw new AmbiguousReplayTapesError(ambiguous)

  const available = new Map<string, ReplayTapeV1[]>()
  for (const tape of tapes) {
    const bucket = available.get(tape.match.actorRef)
    if (bucket) bucket.push(tape)
    else available.set(tape.match.actorRef, [tape])
  }

  const unmatched: UnmatchedReplayRequest[] = []
  const leases = new Map<string, ReplayLease>()

  function lease(actorRef: string): ReplayLease {
    const existing = leases.get(actorRef)
    if (existing) return existing

    const created: ReplayLease = {
      actorRef,
      take(query) {
        const bucket = available.get(actorRef)
        const index =
          bucket?.findIndex(
            (tape) =>
              tape.match.purpose === query.purpose &&
              tape.match.requestDigest === query.requestDigest
          ) ?? -1

        if (!bucket || index < 0) {
          unmatched.push({ actorRef, purpose: query.purpose, requestDigest: query.requestDigest })
          return undefined
        }
        return bucket.splice(index, 1)[0]
      },
      takeByDigest(requestDigest) {
        const bucket = available.get(actorRef) ?? []
        const matches = bucket.filter((tape) => tape.match.requestDigest === requestDigest)

        // Exactly one candidate is unambiguous. Zero is a miss. More than one
        // means the same question was recorded under two purposes, and picking
        // either would be a coin flip that decides what the run observes.
        if (matches.length !== 1) {
          unmatched.push({
            actorRef,
            purpose: matches.length > 1 ? matches[0].match.purpose : "other",
            requestDigest,
          })
          return undefined
        }
        bucket.splice(bucket.indexOf(matches[0]), 1)
        return matches[0]
      },
      remaining() {
        return [...(available.get(actorRef) ?? [])]
      },
    }
    leases.set(actorRef, created)
    return created
  }

  function assertConsumed(looseEnds: RunnerLooseEnds = {}): ReplayConsumptionReport {
    const problems: ReplayConsumptionProblem[] = []

    for (const [actorRef, bucket] of available) {
      for (const tape of bucket) {
        problems.push({
          kind: "unconsumed-tape",
          actorRef,
          detail: `${tape.tapeId} (${tape.match.purpose}) was recorded but never requested`,
        })
      }
    }
    for (const request of unmatched) {
      problems.push({
        kind: "unmatched-request",
        actorRef: request.actorRef,
        detail: `${request.purpose} request ${request.requestDigest} had no tape`,
      })
    }
    for (const entry of looseEnds.unconsumedPermissions ?? []) {
      problems.push({ kind: "unconsumed-permission", detail: entry })
    }
    for (const entry of looseEnds.unfinishedChildren ?? []) {
      problems.push({ kind: "unfinished-child", detail: entry })
    }
    for (const entry of looseEnds.orphanedLogs ?? []) {
      problems.push({ kind: "orphaned-log", detail: entry })
    }

    return { ok: problems.length === 0, problems }
  }

  return { lease, assertConsumed }
}

/** Render a report for a CLI or CI log. */
export function formatConsumptionReport(report: ReplayConsumptionReport): string {
  if (report.ok) return "replay consumed every tape and left nothing open"
  return [
    `replay left ${report.problems.length} problem(s):`,
    ...report.problems.map(
      (problem) =>
        `  - [${problem.kind}]${problem.actorRef ? ` ${problem.actorRef}:` : ""} ${problem.detail}`
    ),
  ].join("\n")
}
