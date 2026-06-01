/**
 * Error-analysis coding helpers (the "look at your data" flywheel).
 *
 * Pure functions over {@link TraceAnnotationRow}s:
 *  - {@link buildFailureTaxonomy} — axial-coding roll-up: cluster open-coded
 *    annotations by `failureMode`, counted and frequency-ordered.
 *  - {@link saturationReached} — the "~20 consecutive traces with no new
 *    category ⇒ stop" rule (window-configurable).
 *  - {@link suggestEvalCandidates} — frequent, labeled failure modes worth
 *    turning into evals (skip the unlabeled bucket).
 */

import type { TraceAnnotationRow } from "@/lib/db/trace-annotations"

const UNLABELED = "(unlabeled)"

export interface FailureCluster {
  failureMode: string
  count: number
  traceIds: string[]
}

/** Cluster annotations by failure mode, counted and sorted by frequency desc. */
export function buildFailureTaxonomy(annotations: TraceAnnotationRow[]): FailureCluster[] {
  const ordered = [...annotations].sort((a, b) => a.createdAt - b.createdAt)
  const map = new Map<string, FailureCluster>()
  for (const a of ordered) {
    const mode = a.failureMode ?? UNLABELED
    const cluster = map.get(mode) ?? { failureMode: mode, count: 0, traceIds: [] }
    cluster.count += 1
    cluster.traceIds.push(a.traceId)
    map.set(mode, cluster)
  }
  return [...map.values()].sort((a, b) => b.count - a.count)
}

/**
 * True when the most recent `window` annotations introduced no failure mode
 * unseen before that window — i.e. error analysis has saturated and it's safe
 * to stop reading. False when there are fewer than `window` annotations.
 */
export function saturationReached(annotations: TraceAnnotationRow[], window = 20): boolean {
  if (annotations.length < window) return false
  const ordered = [...annotations].sort((a, b) => a.createdAt - b.createdAt)
  const cut = ordered.length - window
  const before = new Set<string>()
  for (let i = 0; i < cut; i++) before.add(ordered[i].failureMode ?? UNLABELED)
  for (let i = cut; i < ordered.length; i++) {
    if (!before.has(ordered[i].failureMode ?? UNLABELED)) return false
  }
  return true
}

/** Labeled failure modes at or above `minCount`, frequency-ordered. */
export function suggestEvalCandidates(
  taxonomy: FailureCluster[],
  minCount: number
): FailureCluster[] {
  return taxonomy.filter((c) => c.failureMode !== UNLABELED && c.count >= minCount)
}
