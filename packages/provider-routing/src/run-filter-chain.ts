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
  if (from.filterErrors) into.filterErrors = [...(into.filterErrors ?? []), ...from.filterErrors]
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return Boolean(
    value &&
    typeof value === "object" &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  )
}

async function withTimeout<T>(value: T | Promise<T>, timeoutMs: number): Promise<T> {
  if (!isPromiseLike(value)) return value
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      value,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("routing-plugin-timeout")), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
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

/** Canonical chain runner used by planRoute; supports JS and Python plugins. */
export async function runFilterChainAsync(
  chain: ReadonlyArray<DeploymentFilter>,
  candidates: ReadonlyArray<DeploymentCandidate>,
  req: FilterRequest,
  ctx: FilterContext,
  timeoutMs: number
): Promise<FilterOutcome> {
  let working: DeploymentCandidate[] = [...candidates]
  const notes: FilterNotes = {}
  const prunedBy: string[] = []
  for (const filter of chain) {
    if (working.length === 0) break
    try {
      const outcome = await withTimeout(
        filter.filterAsync
          ? filter.filterAsync(working, req, ctx)
          : filter.filter(working, req, ctx),
        timeoutMs
      )
      if (
        !outcome ||
        !Array.isArray(outcome.candidates) ||
        !outcome.candidates.every(
          (candidate) =>
            typeof candidate?.providerId === "string" && typeof candidate?.modelId === "string"
        )
      ) {
        notes.filterErrors = [
          ...(notes.filterErrors ?? []),
          { filterId: filter.id, kind: "invalid" },
        ]
        continue
      }
      if (outcome.candidates.length < working.length) prunedBy.push(filter.id)
      working = outcome.candidates
      mergeNotes(notes, outcome.notes)
    } catch (error) {
      notes.filterErrors = [
        ...(notes.filterErrors ?? []),
        {
          filterId: filter.id,
          kind:
            error instanceof Error && error.message === "routing-plugin-timeout"
              ? "timeout"
              : "error",
        },
      ]
    }
  }
  if (prunedBy.length > 0) notes.prunedBy = prunedBy
  return { candidates: working, notes }
}
