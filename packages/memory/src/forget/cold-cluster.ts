/**
 * Cold-cluster dedup planning — find near-duplicate cold episodic memories and
 * decide how to fold each group into one survivor. Zero LLM. Ported from
 * ai-memory's A3 pass (`cold_cluster.rs` + `sweep.rs::plan_cold_cluster_dedup`).
 *
 * - Distance is cosine over the memories' stored vectors.
 * - The radius adapts to the corpus (k-distance knee) but never exceeds
 *   `maxEps` (0.15 ⇒ similarity ≥ 0.85), so a sparse corpus cannot merge
 *   loosely related episodes just because nothing closer exists.
 * - The survivor is the member with the highest retention. Its new text keeps
 *   its own statement as the summary and absorbs every member's durable tokens
 *   (`compactMemoryText` with `force`), so a path or error code that lived in
 *   only one duplicate survives the merge.
 * - The other members are superseded by the survivor, not deleted.
 *
 * This module only PLANS. Applying the plan (revision snapshot for the
 * survivor, supersession for the rest, audit) is the caller's job, so the
 * decision is testable without a database.
 */

import { adaptiveEps, dbscan } from "@cognia/provider-embedding/density-clustering"
import type { Memory } from "../types/memory"
import { compactMemoryText } from "./compaction"

export const DEFAULT_DEDUP_MIN_PTS = 2
export const DEFAULT_DEDUP_MAX_EPS = 0.15

export interface ColdClusterCandidate {
  memory: Memory
  retention: number
  embedding: readonly number[]
}

export interface ColdClusterMergePlan {
  survivor: Memory
  /** Members folded into the survivor, in candidate order. */
  merged: Memory[]
  /** The survivor's text after absorbing its duplicates. */
  survivorText: string
}

export interface ColdClusterDedupPlan {
  /** The radius used; `null` when there were too few candidates to derive one. */
  eps: number | null
  merges: ColdClusterMergePlan[]
}

export function planColdClusterDedup(
  candidates: readonly ColdClusterCandidate[],
  options: { minPts?: number; maxEps?: number } = {}
): ColdClusterDedupPlan {
  const minPts = options.minPts && options.minPts > 0 ? options.minPts : DEFAULT_DEDUP_MIN_PTS
  const maxEps = options.maxEps && options.maxEps > 0 ? options.maxEps : DEFAULT_DEDUP_MAX_EPS
  // Already-compacted rows are settled: re-merging them would compound
  // summaries of summaries. They stay out of the candidate set entirely.
  const eligible = candidates.filter(
    (candidate) => candidate.memory.compactedAt === undefined && candidate.embedding.length > 0
  )
  if (eligible.length < minPts) return { eps: null, merges: [] }

  const points = eligible.map((candidate) => candidate.embedding)
  // DBSCAN's `minPts` counts the point itself; the k-distance curve excludes
  // it. So the neighbour that makes a point core is the (minPts − 1)-th one —
  // the standard k-distance convention. ai-memory passes `minPts` here, which
  // is off by one: with minPts 2, a group of exactly two duplicates can never
  // derive a radius and so never merges. Grouping by namespace makes such
  // small groups common, so this port uses the corrected k.
  const eps = adaptiveEps(points, Math.max(1, minPts - 1), maxEps)
  if (eps === null) return { eps: null, merges: [] }

  const merges: ColdClusterMergePlan[] = []
  for (const cluster of dbscan(points, eps, minPts)) {
    if (cluster.length < 2) continue
    const members = cluster.map((index) => eligible[index])
    let survivor = members[0]
    for (const member of members) {
      if (member.retention > survivor.retention) survivor = member
    }
    const merged = members.filter((member) => member !== survivor).map((member) => member.memory)
    const combined = [survivor.memory.text, ...merged.map((memory) => memory.text)].join("\n\n")
    const compacted = compactMemoryText(combined, { force: true })
    merges.push({
      survivor: survivor.memory,
      merged,
      survivorText: compacted?.text ?? survivor.memory.text,
    })
  }
  return { eps, merges }
}
