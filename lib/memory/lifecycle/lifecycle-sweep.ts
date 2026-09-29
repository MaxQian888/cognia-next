/**
 * The memory lifecycle sweep — what happens to episodic memory as it goes cold.
 * Ported from ai-memory's forget sweep (A2 compaction + A3 cold-cluster dedup),
 * onto Cognia's governed rows and durable job queue.
 *
 * Runs as the `memory-lifecycle-sweep` job (at most once a day, enqueued from
 * the post-turn maintenance tick) and only when the user enabled at least one
 * of its passes. Both passes are zero-LLM and reversible:
 *
 * 1. Cold selection — decayable (episodic, unpinned, not a project claim),
 *    never compacted, retention below `coldRetentionThreshold`. Coldest first,
 *    capped at {@link MAX_SWEEP_CANDIDATES} per run.
 * 2. Dedup (`dedupColdClusters`, needs vectors) — per namespace, density-cluster
 *    the cold rows; each cluster folds into its highest-retention member. The
 *    survivor's old text becomes a revision (`dedup-merge`), the other members
 *    are superseded (`invalidated` + `supersededById`), and their evidence is
 *    re-attached to the survivor so its belief reflects every witness and a
 *    later source deletion still reaches it.
 * 3. Compaction (`compactColdEpisodic`) — every remaining cold row is replaced
 *    by its summary + durable tokens; the full text becomes a revision
 *    (`compaction`). Rows too short to shrink are left alone.
 *
 * Nothing is hard-deleted. Rows a dedup cluster claimed are not compacted
 * separately. Each write goes through `updateMemory` / `invalidateMemory`, so
 * revisions, versions and audit look exactly like any other change.
 *
 * The orchestration is dependency-injected; the job worker wires Dexie and the
 * vector backend.
 */

import type { Memory, MemoryConfig } from "@/types/memory/memory"
import { isDecayable, retentionScore, type RetentionParams } from "@cognia/memory/forget/retention"
import { compactMemoryText } from "@cognia/memory/forget/compaction"
import { planColdClusterDedup } from "@cognia/memory/forget/cold-cluster"
import { sameMemoryNamespace } from "@/lib/memory/consolidate/consolidator"

export const MAX_SWEEP_CANDIDATES = 500

export interface LifecycleSweepDeps {
  /** Every active row (all namespaces). */
  listActive: () => Promise<Memory[]>
  /** Vectors by memory id for the given rows; absent ⇒ dedup is skipped. */
  loadEmbeddings?: (memories: readonly Memory[]) => Promise<Map<string, number[]>>
  /** Replace a row's text through the revision path. */
  reviseText: (
    memory: Memory,
    text: string,
    reason: "compaction" | "dedup-merge",
    now: number
  ) => Promise<void>
  /** Supersede a folded duplicate by its survivor. */
  supersede: (loser: Memory, survivor: Memory) => Promise<void>
  /** Re-attach a folded duplicate's evidence to its survivor. */
  moveEvidence: (loser: Memory, survivor: Memory) => Promise<void>
  audit: (event: {
    action: "revised" | "invalidated"
    memoryId: string
    reason: "compacted" | "dedup_merge" | "dedup_merged"
    metadata?: Record<string, string | number | boolean>
  }) => Promise<void>
}

export interface LifecycleSweepReport {
  candidates: number
  compacted: string[]
  merges: { survivorId: string; mergedIds: string[] }[]
  /** Why dedup did not run, when it was enabled but could not. */
  dedupSkipped?: "no_vectors"
}

export interface LifecycleSweepInput {
  config: Pick<
    MemoryConfig,
    | "compactColdEpisodic"
    | "dedupColdClusters"
    | "coldRetentionThreshold"
    | "accessReinforcementWeight"
  >
  now?: number
}

function namespaceGroupKey(memory: Memory): string {
  return JSON.stringify([
    memory.scope,
    memory.characterId ?? null,
    memory.projectId ?? null,
    memory.agentId ?? null,
    memory.branch ?? null,
    memory.pathPattern ?? null,
  ])
}

export function retentionParamsFor(
  config: Pick<MemoryConfig, "accessReinforcementWeight">
): Partial<RetentionParams> {
  return config.accessReinforcementWeight === undefined
    ? {}
    : { sigma: Math.max(0, config.accessReinforcementWeight) }
}

export async function runMemoryLifecycleSweep(
  input: LifecycleSweepInput,
  deps: LifecycleSweepDeps
): Promise<LifecycleSweepReport> {
  const report: LifecycleSweepReport = { candidates: 0, compacted: [], merges: [] }
  const { config } = input
  if (!config.compactColdEpisodic && !config.dedupColdClusters) return report
  const now = input.now ?? Date.now()
  const params = retentionParamsFor(config)
  const threshold = config.coldRetentionThreshold ?? 0.2

  const cold = (await deps.listActive())
    .filter((memory) => isDecayable(memory) && memory.compactedAt === undefined)
    .map((memory) => ({ memory, retention: retentionScore(memory, { now, params }) }))
    .filter((entry) => entry.retention < threshold)
    .sort((a, b) => a.retention - b.retention)
    .slice(0, MAX_SWEEP_CANDIDATES)
  report.candidates = cold.length
  if (cold.length === 0) return report

  const claimed = new Set<string>()

  if (config.dedupColdClusters) {
    const embeddings = deps.loadEmbeddings
      ? await deps.loadEmbeddings(cold.map((entry) => entry.memory)).catch(() => undefined)
      : undefined
    if (!embeddings || embeddings.size === 0) {
      report.dedupSkipped = "no_vectors"
    } else {
      const groups = new Map<string, typeof cold>()
      for (const entry of cold) {
        const key = namespaceGroupKey(entry.memory)
        groups.set(key, [...(groups.get(key) ?? []), entry])
      }
      for (const group of groups.values()) {
        const plan = planColdClusterDedup(
          group.flatMap((entry) => {
            const embedding = embeddings.get(entry.memory.id)
            return embedding ? [{ ...entry, embedding }] : []
          })
        )
        for (const merge of plan.merges) {
          // Belt and braces on top of the namespace grouping: never fold a row
          // into a survivor another reader could not see it through.
          const survivorNamespace = {
            scope: merge.survivor.scope,
            characterId: merge.survivor.characterId,
            projectId: merge.survivor.projectId,
            agentId: merge.survivor.agentId,
            branch: merge.survivor.branch,
            pathPattern: merge.survivor.pathPattern,
          }
          const merged = merge.merged.filter((memory) =>
            sameMemoryNamespace(memory, survivorNamespace)
          )
          if (merged.length === 0) continue
          await deps.reviseText(merge.survivor, merge.survivorText, "dedup-merge", now)
          for (const loser of merged) {
            await deps.moveEvidence(loser, merge.survivor)
            await deps.supersede(loser, merge.survivor)
            await deps.audit({
              action: "invalidated",
              memoryId: loser.id,
              reason: "dedup_merged",
              metadata: { survivorId: merge.survivor.id },
            })
            claimed.add(loser.id)
          }
          await deps.audit({
            action: "revised",
            memoryId: merge.survivor.id,
            reason: "dedup_merge",
            metadata: { merged: merged.length },
          })
          claimed.add(merge.survivor.id)
          report.merges.push({
            survivorId: merge.survivor.id,
            mergedIds: merged.map((memory) => memory.id),
          })
        }
      }
    }
  }

  if (config.compactColdEpisodic) {
    for (const { memory } of cold) {
      if (claimed.has(memory.id)) continue
      const compacted = compactMemoryText(memory.text)
      if (!compacted) continue
      await deps.reviseText(memory, compacted.text, "compaction", now)
      await deps.audit({
        action: "revised",
        memoryId: memory.id,
        reason: "compacted",
        metadata: { keepTokens: compacted.keepTokens.length },
      })
      report.compacted.push(memory.id)
    }
  }

  return report
}
