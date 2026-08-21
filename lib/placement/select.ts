import { evaluatePlacement } from "./evaluate"
import type { LivenessPolicy } from "./liveness"
import {
  PlacementWaitingError,
  type PlacementCandidate,
  type PlacementConstraint,
  type PlacementRequirement,
  type PlacementVerdict,
} from "./types"

export interface PlacementSelection {
  candidate: PlacementCandidate
  /** Every candidate considered, with its verdict — for the UI and the audit. */
  considered: ReadonlyArray<{ ref: string; verdict: PlacementVerdict }>
}

export interface SelectPlacementOptions {
  policy?: LivenessPolicy
  /**
   * Replace the compatibility check with a richer, candidate-specific one.
   *
   * Some candidate kinds match on more than "does it provide this value" —
   * an execution worker compares runtime adapters, model bindings, and
   * deployment refs, and reports which of those failed. Those reasons are
   * persisted, so they cannot be flattened into the generic vocabulary. This
   * seam lets such a caller keep its own verdicts while still reusing the part
   * that is genuinely shared: ordering, the deterministic tiebreak, and the
   * waiting-is-not-failure distinction.
   */
  evaluate?: (candidate: PlacementCandidate) => PlacementVerdict
}

/**
 * Pick where work runs.
 *
 * Generalized from `selectRemoteWorker`, preserving both of its properties that
 * matter under concurrency:
 *
 *   * **least loaded first**, so a fleet fills evenly instead of hammering
 *     whichever candidate sorts first;
 *   * **lexicographic ref as the tiebreak**, so two hosts resolving the same
 *     placement at the same instant reach the same answer. A random or
 *     insertion-order tiebreak would have them each pick a different target and
 *     both believe they won.
 */
export function selectPlacement(
  candidates: readonly PlacementCandidate[],
  constraint: PlacementConstraint,
  requirements: readonly PlacementRequirement[],
  now: number,
  options: SelectPlacementOptions = {}
): PlacementSelection {
  const policy = options.policy ?? {}
  const verdictFor =
    options.evaluate ??
    ((candidate: PlacementCandidate) => evaluatePlacement(candidate, requirements, now, policy))
  if (constraint.mode === "colocate") {
    const local = candidates.find((candidate) => candidate.kind === "local")
    if (!local) throw new PlacementWaitingError("no_compatible_capacity")
    const verdict = verdictFor(local)
    if (!verdict.ready) {
      throw new PlacementWaitingError("no_compatible_capacity", local.ref, verdict.reason)
    }
    return { candidate: local, considered: [{ ref: local.ref, verdict }] }
  }

  if (constraint.mode === "pinned") {
    const pinned = candidates.find((candidate) => candidate.ref === constraint.ref)
    if (!pinned) throw new PlacementWaitingError("pinned_candidate_unavailable", constraint.ref)
    const verdict = verdictFor(pinned)
    if (!verdict.ready) {
      // A pinned target names one machine, so there is nothing to fall back to;
      // this is a wait, not a failure, and the reason says what to fix.
      throw new PlacementWaitingError(
        verdict.reason === "offline" ? "pinned_candidate_unavailable" : "no_compatible_capacity",
        constraint.ref,
        verdict.reason
      )
    }
    return { candidate: pinned, considered: [{ ref: pinned.ref, verdict }] }
  }

  const considered = candidates.map((candidate) => ({
    ref: candidate.ref,
    verdict: verdictFor(candidate),
  }))
  const ready = candidates
    .filter((_, index) => considered[index]!.verdict.ready)
    .sort(
      (left, right) => left.activeUnits - right.activeUnits || left.ref.localeCompare(right.ref)
    )
  const selected = ready[0]
  if (!selected) throw new PlacementWaitingError("no_compatible_capacity")
  return { candidate: selected, considered }
}
