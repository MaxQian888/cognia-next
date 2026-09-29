/**
 * Forgetting — bound memory growth without losing pinned/important facts.
 *
 *  - `evictOverflow`: when a scope exceeds `maxActivePerScope`, soft-invalidate
 *    the lowest three-factor-scored NON-pinned memories until back at the cap.
 *    Pinned memories are exempt. Never hard-deletes (history preserved).
 *  - `expireStale`: optionally invalidate non-pinned memories untouched for
 *    longer than `maxIdleDays` (access-time forgetting, à la Claude's memory
 *    tool). Not run by default — the caller opts in.
 *
 * Eviction ranks by `retentionScore` (time decay since the text took effect +
 * access reinforcement, `./retention`) alongside importance — there is no query
 * at eviction time, so relevance plays no part. Both factors are min-max
 * normalized across the candidates and summed, the same shape `scoreMemories`
 * uses, so a defining fact nobody has recalled lately still outlives a trivial
 * one. Dependency-injected and pure-logic; the lifecycle wires real Dexie
 * functions.
 */

import type { Memory, MemoryScope } from "../types/memory"
import { retentionScore, type RetentionParams } from "./retention"

export interface DecayDeps {
  listActive: (scope: MemoryScope, namespace?: MemoryDecayNamespace) => Promise<Memory[]>
  invalidate: (id: string) => Promise<void>
}

export interface MemoryDecayNamespace {
  characterId?: string
  projectId?: string
  agentId?: string
  branch?: string
  pathPattern?: string
}

export interface MemoryDecayInput extends MemoryDecayNamespace {
  scope: MemoryScope
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** Min-max normalize to [0,1]; all-equal input is neutral (1s). */
function minMaxNormalize(values: number[]): number[] {
  if (values.length === 0) return []
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min
  if (range === 0) return values.map(() => 1)
  return values.map((value) => (value - min) / range)
}

/**
 * Keep-worthiness of each candidate, highest first. Exported for the lifecycle
 * sweep and the console, which must agree with eviction about what is "cold".
 */
export function rankByKeepWorthiness<T extends Memory>(
  memories: readonly T[],
  options: { now?: number; retention?: Partial<RetentionParams> } = {}
): { memory: T; retention: number; score: number }[] {
  const retention = memories.map((memory) =>
    retentionScore(memory, { now: options.now, params: options.retention })
  )
  const importance = memories.map((memory) => Math.min(10, Math.max(1, memory.importance)) / 10)
  const normRetention = minMaxNormalize(retention)
  const normImportance = minMaxNormalize(importance)
  return memories
    .map((memory, index) => ({
      memory,
      retention: retention[index],
      score: normRetention[index] + normImportance[index],
    }))
    .sort((a, b) => b.score - a.score)
}

export async function evictOverflow(
  input: MemoryDecayInput & {
    maxActivePerScope: number
    now?: number
    /** Retention knobs; `sigma` comes from `MemoryConfig.accessReinforcementWeight`. */
    retention?: Partial<RetentionParams>
  },
  deps: DecayDeps
): Promise<{ evicted: string[] }> {
  const active = await deps.listActive(input.scope, decayNamespace(input))
  const overflow = active.length - input.maxActivePerScope
  if (overflow <= 0) return { evicted: [] }

  const candidates = active.filter((m) => !m.pinned)
  if (candidates.length === 0) return { evicted: [] }

  // Lowest keep-worthiness first → evict from the bottom.
  const ranked = rankByKeepWorthiness(candidates, { now: input.now, retention: input.retention })
  const lowestFirst = ranked.slice().reverse()
  const toEvict = lowestFirst.slice(0, Math.min(overflow, candidates.length))

  const evicted: string[] = []
  for (const r of toEvict) {
    await deps.invalidate(r.memory.id)
    evicted.push(r.memory.id)
  }
  return { evicted }
}

export async function expireStale(
  input: MemoryDecayInput & { maxIdleDays: number; now?: number },
  deps: DecayDeps
): Promise<{ expired: string[] }> {
  if (input.maxIdleDays <= 0) return { expired: [] }
  const now = input.now ?? Date.now()
  const cutoff = now - input.maxIdleDays * MS_PER_DAY
  const active = await deps.listActive(input.scope, decayNamespace(input))
  const stale = active.filter((m) => !m.pinned && m.lastAccessedAt < cutoff)
  const expired: string[] = []
  for (const m of stale) {
    await deps.invalidate(m.id)
    expired.push(m.id)
  }
  return { expired }
}

function decayNamespace(input: MemoryDecayInput): MemoryDecayNamespace {
  return {
    characterId: input.characterId,
    projectId: input.projectId,
    agentId: input.agentId,
    branch: input.branch,
    pathPattern: input.pathPattern,
  }
}
