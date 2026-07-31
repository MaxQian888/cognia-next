// RecoveryPlanner (ADR-0090 Phase 8).
//
// Given the recovery candidates for a session/run (canonical log, runtime
// artifact, checkpoint, import), decide whether recovery may proceed
// AUTOMATICALLY or must surface `recovery_required`. Automatic recovery is
// allowed ONLY when one candidate STRICTLY dominates: its coverage is a
// superset (same shared prefix), its fidelity is >= every other candidate,
// and no candidate's history has forked (shared-prefix digests disagree).
// Tool / permission / side-effect ambiguity always pauses.
//
// `RecoveryCandidate` deliberately has NO modification-time field —
// last-modified-wins is structurally impossible, not just discouraged.

import {
  computeSequenceDigest,
  fidelityRank,
  type CanonicalTurn,
  type SessionFidelity,
} from "@cognia/agent-config-types/canonical-session"

export interface RecoveryCandidate {
  id: string
  kind: "canonical-log" | "runtime" | "checkpoint" | "import"
  fidelity: SessionFidelity
  /** The candidate's full turn sequence (its coverage). */
  turns: CanonicalTurn[]
  /**
   * True when this candidate contains work whose side effects cannot be
   * proven settled (e.g. a tool call with no recorded result). Any chosen
   * candidate carrying this forces `recovery_required` — replaying it could
   * double-fire the side effect.
   */
  hasAmbiguousSideEffects?: boolean
}

export type RecoveryPlan =
  | { action: "auto"; candidateId: string }
  | {
      action: "recovery_required"
      reason: "no-candidates" | "forked-history" | "no-dominant" | "ambiguous-side-effects"
      detail: string[]
    }

function sharedPrefixAgrees(a: RecoveryCandidate, b: RecoveryCandidate): boolean {
  const common = Math.min(a.turns.length, b.turns.length)
  if (common === 0) return true
  return (
    computeSequenceDigest(a.turns.slice(0, common)) ===
    computeSequenceDigest(b.turns.slice(0, common))
  )
}

/** A dominates B: coverage superset (prefix-consistent) AND fidelity >= B. */
function dominates(a: RecoveryCandidate, b: RecoveryCandidate): boolean {
  return a.turns.length >= b.turns.length && fidelityRank(a.fidelity) >= fidelityRank(b.fidelity)
}

/**
 * Plan the recovery. Pure and synchronous — callers gather candidates (and
 * MUST hold the run's single-writer lease before acting on an `auto` plan).
 */
export function planRecovery(candidates: RecoveryCandidate[]): RecoveryPlan {
  if (candidates.length === 0) {
    return { action: "recovery_required", reason: "no-candidates", detail: [] }
  }

  // Fork detection first: any disagreeing shared prefix disables automation
  // outright — there is no "better" side of a fork to pick.
  const forks: string[] = []
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      if (!sharedPrefixAgrees(candidates[i], candidates[j])) {
        forks.push(`${candidates[i].id} <> ${candidates[j].id}`)
      }
    }
  }
  if (forks.length > 0) {
    return { action: "recovery_required", reason: "forked-history", detail: forks }
  }

  // Pareto front over (coverage, fidelity).
  const front = candidates.filter((candidate) =>
    candidates.every(
      (other) =>
        other === candidate ||
        !(
          dominates(other, candidate) &&
          (other.turns.length > candidate.turns.length ||
            fidelityRank(other.fidelity) > fidelityRank(candidate.fidelity))
        )
    )
  )

  // Members of the front that are NOT pairwise identical mean no strict
  // dominance. Identical content (same length + digest) collapses safely.
  const digests = new Set(
    front.map(
      (c) => `${c.turns.length}:${computeSequenceDigest(c.turns)}:${fidelityRank(c.fidelity)}`
    )
  )
  if (digests.size > 1) {
    return {
      action: "recovery_required",
      reason: "no-dominant",
      detail: front.map((c) => c.id),
    }
  }

  // Deterministic pick within the identical group: lexicographic id.
  const chosen = [...front].sort((a, b) => a.id.localeCompare(b.id))[0]
  if (chosen.hasAmbiguousSideEffects) {
    return {
      action: "recovery_required",
      reason: "ambiguous-side-effects",
      detail: [chosen.id],
    }
  }
  return { action: "auto", candidateId: chosen.id }
}
