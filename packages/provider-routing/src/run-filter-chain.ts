/**
 * Pure executor for an ordered deployment-filter chain. The engine resolves
 * filter ids → filters (skipping unknown ids) and this runs them in order,
 * merging notes. A throwing filter is skipped — one broken plugin filter can
 * never break dispatch — and an early-emptied list short-circuits.
 */

import type {
  DeploymentCandidate,
  DeploymentFilter,
  FilterContext,
  FilterNotes,
  FilterOutcome,
  FilterRequest,
} from "@cognia/provider-types/deployment-filter"

function mergeNotes(into: FilterNotes, from: FilterNotes | undefined): void {
  if (!from) return
  if (from.overBudget) into.overBudget = from.overBudget
  if (from.windowFallback) into.windowFallback = true
  if (from.affinityPinned) into.affinityPinned = from.affinityPinned
}

/** Run `chain` over `candidates`; returns survivors + merged notes. */
export function runFilterChain(
  chain: ReadonlyArray<DeploymentFilter>,
  candidates: ReadonlyArray<DeploymentCandidate>,
  req: FilterRequest,
  ctx: FilterContext
): FilterOutcome {
  let working: DeploymentCandidate[] = [...candidates]
  const notes: FilterNotes = {}
  const prunedBy: string[] = []
  for (const filter of chain) {
    if (working.length === 0) break
    try {
      const outcome = filter.filter(working, req, ctx)
      if (outcome.candidates.length < working.length) prunedBy.push(filter.id)
      working = outcome.candidates
      mergeNotes(notes, outcome.notes)
    } catch {
      // A filter must not throw (contract); skip it so dispatch survives.
      continue
    }
  }
  if (prunedBy.length > 0) notes.prunedBy = prunedBy
  return { candidates: working, notes }
}
