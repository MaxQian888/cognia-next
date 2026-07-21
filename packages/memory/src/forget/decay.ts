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

import type { Memory, MemoryScope } from "../types/memory"
import { scoreMemories } from "../retrieve/scoring"

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

export async function evictOverflow(
  input: MemoryDecayInput & { maxActivePerScope: number },
  deps: DecayDeps
): Promise<{ evicted: string[] }> {
  const active = await deps.listActive(input.scope, decayNamespace(input))
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
