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
 * Scoring reuses `scoreMemories` with relevance pinned to 0 (recency ×
 * importance only — there's no query at eviction time). Dependency-injected and
 * pure-logic; the lifecycle wires real Dexie functions.
 */

import type { Memory, MemoryScope } from "@/types/memory/memory"
import { scoreMemories } from "@/lib/memory/retrieve/scoring"

export interface DecayDeps {
  listActive: (scope: MemoryScope, characterId?: string) => Promise<Memory[]>
  invalidate: (id: string) => Promise<void>
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

export async function evictOverflow(
  input: { scope: MemoryScope; characterId?: string; maxActivePerScope: number },
  deps: DecayDeps
): Promise<{ evicted: string[] }> {
  const active = await deps.listActive(input.scope, input.characterId)
  const overflow = active.length - input.maxActivePerScope
  if (overflow <= 0) return { evicted: [] }

  const candidates = active.filter((m) => !m.pinned)
  if (candidates.length === 0) return { evicted: [] }

  // Lowest score first → evict from the bottom.
  const ranked = scoreMemories(
    candidates.map((m) => ({ ...m, relevance: 0 })),
    { weights: { relevance: 0 } }
  )
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
  input: { scope: MemoryScope; characterId?: string; maxIdleDays: number; now?: number },
  deps: DecayDeps
): Promise<{ expired: string[] }> {
  if (input.maxIdleDays <= 0) return { expired: [] }
  const now = input.now ?? Date.now()
  const cutoff = now - input.maxIdleDays * MS_PER_DAY
  const active = await deps.listActive(input.scope, input.characterId)
  const stale = active.filter((m) => !m.pinned && m.lastAccessedAt < cutoff)
  const expired: string[] = []
  for (const m of stale) {
    await deps.invalidate(m.id)
    expired.push(m.id)
  }
  return { expired }
}
