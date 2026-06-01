/**
 * CRUD for the `memories` table (schema v65) — the autonomous long-term memory
 * store. See `@/types/memory/memory` and
 * `docs/superpowers/specs/2026-06-01-agent-long-term-memory-design.md`.
 *
 * The consolidation path NEVER hard-deletes on contradiction: it calls
 * `invalidateMemory` (status → `invalidated`, history preserved). Only the
 * user-facing panel calls `hardDeleteMemory` / `clearMemories`.
 *
 * This module is mechanical (no LLM, no gating). The settings gate
 * (`memory.enabled`) is enforced by callers (read/write orchestrators), matching
 * how `lib/db/goals.ts` stays mechanical while `lib/goal/runtime.ts` enforces
 * invariants.
 */

import type { Memory, MemoryScope, MemoryStatus, MemoryType } from "@/types/memory/memory"
import { getDb } from "./schema"

function newMemoryId(): string {
  return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Fields a caller supplies on creation. The store fills timestamps, `version`,
 * `accessCount`, `status`, and `id` (unless a fixture id is supplied).
 */
export type MemoryCreateInput = Omit<
  Memory,
  | "id"
  | "createdAt"
  | "updatedAt"
  | "lastAccessedAt"
  | "accessCount"
  | "version"
  | "status"
  | "tags"
  | "pinned"
> & {
  id?: string
  createdAt?: number
  status?: MemoryStatus
  /** Defaults to `[]`. */
  tags?: string[]
  /** Defaults to `false`. */
  pinned?: boolean
}

export async function createMemory(input: MemoryCreateInput): Promise<Memory> {
  const now = input.createdAt ?? Date.now()
  const row: Memory = {
    tags: [],
    pinned: false,
    ...input,
    id: input.id ?? newMemoryId(),
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    accessCount: 0,
    version: 1,
    status: input.status ?? "active",
  }
  await getDb().memories.add(row)
  return row
}

export async function getMemory(id: string): Promise<Memory | undefined> {
  return getDb().memories.get(id)
}

export async function getMemoriesByVectorDocIds(ids: string[]): Promise<Memory[]> {
  if (ids.length === 0) return []
  return getDb().memories.where("vectorDocId").anyOf(ids).toArray()
}

export interface MemoryUpdatePatch {
  text?: string
  key?: string
  tags?: string[]
  importance?: number
  vectorDocId?: string
  pinned?: boolean
  /** When true, also bumps `version` (used by the consolidation UPDATE op). */
  bumpVersion?: boolean
}

/** Apply a partial patch, always bumping `updatedAt`. */
export async function updateMemory(id: string, patch: MemoryUpdatePatch): Promise<void> {
  const { bumpVersion, ...rest } = patch
  const next: Partial<Memory> = { ...rest, updatedAt: Date.now() }
  if (bumpVersion) {
    const existing = await getDb().memories.get(id)
    next.version = (existing?.version ?? 0) + 1
  }
  await getDb().memories.update(id, next)
}

/**
 * Soft-delete: mark a memory `invalidated` (kept for history). When a newer
 * memory supersedes it, pass `supersededById` to link the chain.
 */
export async function invalidateMemory(id: string, supersededById?: string): Promise<void> {
  const next: Partial<Memory> = {
    status: "invalidated",
    invalidatedAt: Date.now(),
    updatedAt: Date.now(),
  }
  if (supersededById) next.supersededById = supersededById
  await getDb().memories.update(id, next)
}

/** Bump `lastAccessedAt` + `accessCount` — called by the retriever on a hit. */
export async function touchMemories(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const db = getDb()
  const now = Date.now()
  await db.transaction("rw", db.memories, async () => {
    for (const id of ids) {
      const row = await db.memories.get(id)
      if (!row) continue
      await db.memories.update(id, { lastAccessedAt: now, accessCount: row.accessCount + 1 })
    }
  })
}

export async function setMemoryPinned(id: string, pinned: boolean): Promise<void> {
  await getDb().memories.update(id, { pinned, updatedAt: Date.now() })
}

export interface ListMemoriesQuery {
  scope?: MemoryScope
  characterId?: string
  type?: MemoryType
  status?: MemoryStatus
}

/**
 * Generic newest-first listing. Used by the panel. When `status` is omitted,
 * both active and invalidated rows are returned (so the panel can show history).
 */
export async function listMemories(query: ListMemoriesQuery = {}): Promise<Memory[]> {
  let collection = getDb().memories.toCollection()
  if (query.scope !== undefined) collection = collection.filter((m) => m.scope === query.scope)
  if (query.characterId !== undefined)
    collection = collection.filter((m) => m.characterId === query.characterId)
  if (query.type !== undefined) collection = collection.filter((m) => m.type === query.type)
  if (query.status !== undefined) collection = collection.filter((m) => m.status === query.status)
  const rows = await collection.toArray()
  return rows.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Active memories visible to a reader: the `global` base unioned with the
 * given character's override layer. This is the retriever's candidate pool.
 */
export async function listActiveForReader(characterId?: string): Promise<Memory[]> {
  const db = getDb()
  const global = await db.memories.where("[scope+status]").equals(["global", "active"]).toArray()
  if (!characterId) return global
  const scoped = await db.memories.where("[scope+status]").equals(["character", "active"]).toArray()
  return [...global, ...scoped.filter((m) => m.characterId === characterId)]
}

/** Active procedural memories for a reader (global + character override). */
export async function listActiveProcedural(characterId?: string): Promise<Memory[]> {
  const all = await listActiveForReader(characterId)
  return all.filter((m) => m.type === "procedural")
}

/** Count of active memories in a scope — used by the eviction cap. */
export async function countActive(scope: MemoryScope, characterId?: string): Promise<number> {
  const db = getDb()
  if (scope === "global") {
    return db.memories.where("[scope+status]").equals(["global", "active"]).count()
  }
  const scoped = await db.memories.where("[scope+status]").equals(["character", "active"]).toArray()
  return characterId ? scoped.filter((m) => m.characterId === characterId).length : scoped.length
}

/** Hard-delete a single memory (user-initiated only). */
export async function hardDeleteMemory(id: string): Promise<void> {
  await getDb().memories.delete(id)
}

/**
 * Hard-delete every memory, or just those in a scope/character. User-initiated
 * "clear all" from the panel.
 */
export async function clearMemories(query: ListMemoriesQuery = {}): Promise<number> {
  const rows = await listMemories(query)
  const ids = rows.map((m) => m.id)
  if (ids.length === 0) return 0
  await getDb().memories.bulkDelete(ids)
  return ids.length
}
