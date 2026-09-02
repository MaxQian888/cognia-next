// Joining spend to outcome (ADR-0165 Phase 3).
//
// The question this answers is the one every "AI cost" dashboard skips: not
// what did the turns cost, but what did the KEPT work cost. Cognia can answer
// it because the Task Workspace already records, per turn, which proposed
// changes were accepted, partially accepted, rejected or later reverted
// (`lib/code-adoption/`), which is a far stronger signal than the timestamp
// correlation CodeBurn calls "yield".
//
// Two rules the shape enforces:
//
//   * CONFIDENCE IS PART OF THE ANSWER. A join backed by the authoritative
//     Task Workspace ledger is `measured`. One backed by the older fingerprint
//     tracker is `heuristic`. A session with no adoption row at all is
//     `unknown`, and unknown NEVER means rejected. An external agent's
//     imported session is always unknown, and this module will not let a
//     caller label it wasteful on that basis.
//   * COVERAGE IS REPORTED. "60% of this window's spend has outcome evidence"
//     is the difference between a number you can act on and a number that
//     happens to describe the 3 sessions that were instrumented.

import type { CodeAdoptionState, CodeAdoptionTurnRow } from "@/lib/code-adoption/types"
import type { SessionUsageRow } from "@/lib/db/session-usage"

import { effectiveCostUsdDetailed, type PricingResolver } from "./session-analytics"
import { resolveModelPricingUsd } from "./pricing"

/** How much the join can be trusted for one session. */
export type AttributionConfidence =
  /** The Task Workspace ledger recorded what was accepted. */
  | "measured"
  /** The older fingerprint tracker inferred it. Directionally right. */
  | "heuristic"
  /** No evidence at all. Never to be read as "rejected". */
  | "unknown"

/** Spend bucketed by what happened to the work it produced. */
export interface AttributedSpend {
  acceptedUsd: number
  partiallyAcceptedUsd: number
  rejectedUsd: number
  revertedUsd: number
  /** Spend on turns with no adoption evidence at all. */
  unattributedUsd: number
  /** Spend the pricing layer could not resolve, in any bucket. */
  unpricedTurns: number
}

export interface AdoptionAttribution {
  spend: AttributedSpend
  /** Total known spend in the window, the denominator for every share. */
  knownCostUsd: number
  /**
   * Share of known spend that carries outcome evidence, 0-1. Below roughly a
   * half, the buckets describe a sample rather than the window.
   */
  evidenceCoverage: number
  confidence: AttributionConfidence
  acceptedFiles: number
  acceptedLines: number
  /** `null` rather than Infinity when nothing was accepted. */
  costPerAcceptedFileUsd: number | null
  costPerAcceptedLineUsd: number | null
  /** Sessions folded into this attribution. */
  sessions: number
  sessionsWithEvidence: number
}

/**
 * Confidence for one adoption row.
 *
 * A row whose `measurement` says `taskWorkspace` was recorded by the
 * authoritative ledger. `legacyFingerprint` predates it and infers acceptance
 * from file fingerprints, which is directionally right and not a measurement.
 * An absent measurement is a row written before either shipped.
 */
export function rowConfidence(row: CodeAdoptionTurnRow): AttributionConfidence {
  if (row.measurement === "taskWorkspace") return "measured"
  if (row.measurement === "legacyFingerprint") return "heuristic"
  return "unknown"
}

/** The weakest confidence present, since a mixed set is only as good as its worst. */
export function foldConfidence(values: readonly AttributionConfidence[]): AttributionConfidence {
  if (values.length === 0) return "unknown"
  if (values.includes("unknown")) return "unknown"
  return values.includes("heuristic") ? "heuristic" : "measured"
}

/**
 * Which bucket a turn's spend belongs in.
 *
 * `pending`, `unavailable` and `notApplicable` all mean "we do not know what
 * happened to this", and are reported as unattributed rather than folded into
 * rejected. Calling an unfinished review a rejection would make every long
 * task look wasteful the moment it was measured.
 */
export function bucketForState(state: CodeAdoptionState | undefined): keyof AttributedSpend | null {
  switch (state) {
    case "accepted":
      return "acceptedUsd"
    case "partiallyAccepted":
      return "partiallyAcceptedUsd"
    case "rejected":
      return "rejectedUsd"
    case "reverted":
      return "revertedUsd"
    default:
      return null
  }
}

export interface AttributeSpendInput {
  rows: readonly SessionUsageRow[]
  adoption: readonly CodeAdoptionTurnRow[]
  resolve?: PricingResolver
}

/**
 * Join a window's spend to the adoption ledger.
 *
 * The join key is `sessionId`, which both tables carry. Turn-level joining
 * would be sharper, but `codeAdoptionTurns.runId` is a per-session counter
 * rather than the ADR-0090 run id on `sessionUsage`, so matching on it would
 * silently pair unrelated turns. Session-level attribution with honest
 * coverage beats turn-level attribution that is quietly wrong.
 */
export function attributeSpend(input: AttributeSpendInput): AdoptionAttribution {
  const resolve = input.resolve ?? resolveModelPricingUsd
  const bySession = new Map<string, CodeAdoptionTurnRow[]>()
  for (const row of input.adoption) {
    const bucket = bySession.get(row.sessionId)
    if (bucket) bucket.push(row)
    else bySession.set(row.sessionId, [row])
  }

  const spend: AttributedSpend = {
    acceptedUsd: 0,
    partiallyAcceptedUsd: 0,
    rejectedUsd: 0,
    revertedUsd: 0,
    unattributedUsd: 0,
    unpricedTurns: 0,
  }
  let knownCostUsd = 0
  let attributedUsd = 0
  const sessions = new Set<string>()
  const sessionsWithEvidence = new Set<string>()
  const confidences: AttributionConfidence[] = []

  for (const row of input.rows) {
    sessions.add(row.sessionId)
    const cost = effectiveCostUsdDetailed(row, resolve)
    if (!cost.known) {
      spend.unpricedTurns += 1
      continue
    }
    knownCostUsd += cost.cost

    const evidence = bySession.get(row.sessionId)
    if (!evidence || evidence.length === 0) {
      spend.unattributedUsd += cost.cost
      continue
    }
    sessionsWithEvidence.add(row.sessionId)

    // A session's turns can end in different states. Spread the row's cost
    // across the states its session actually produced rather than picking one,
    // so a session that half landed does not count entirely as accepted.
    const buckets = evidence
      .map((turn) => bucketForState(turn.adoptionState))
      .filter((b): b is keyof AttributedSpend => b !== null)
    if (buckets.length === 0) {
      spend.unattributedUsd += cost.cost
      continue
    }
    const share = cost.cost / buckets.length
    for (const bucket of buckets) {
      spend[bucket] = (spend[bucket] as number) + share
    }
    attributedUsd += cost.cost
    for (const turn of evidence) confidences.push(rowConfidence(turn))
  }

  let acceptedFiles = 0
  let acceptedLines = 0
  for (const turn of input.adoption) {
    if (!sessions.has(turn.sessionId)) continue
    acceptedFiles += turn.acceptedFiles ?? 0
    acceptedLines += (turn.acceptedAdded ?? 0) + (turn.acceptedRemoved ?? 0)
  }

  const acceptedSpend = spend.acceptedUsd + spend.partiallyAcceptedUsd
  return {
    spend,
    knownCostUsd,
    evidenceCoverage: knownCostUsd > 0 ? attributedUsd / knownCostUsd : 0,
    confidence: foldConfidence(confidences),
    acceptedFiles,
    acceptedLines,
    costPerAcceptedFileUsd: acceptedFiles > 0 ? acceptedSpend / acceptedFiles : null,
    costPerAcceptedLineUsd: acceptedLines > 0 ? acceptedSpend / acceptedLines : null,
    sessions: sessions.size,
    sessionsWithEvidence: sessionsWithEvidence.size,
  }
}

/**
 * Whether an attribution is strong enough to call a session wasteful.
 *
 * Deliberately strict, and deliberately its own function so no caller can
 * reach the verdict by eyeballing a ratio. A heuristic or unknown join, or a
 * window where most spend has no evidence, cannot support the claim. This is
 * the guard that keeps timestamp-shaped reasoning out of a verdict about
 * someone's work.
 */
export function canJudgeWaste(attribution: AdoptionAttribution): boolean {
  return attribution.confidence === "measured" && attribution.evidenceCoverage >= 0.5
}
