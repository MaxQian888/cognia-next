/**
 * CRUD for the `memories` table (schema v65) — the autonomous long-term memory
 * store. See `@/types/memory/memory` and ADR-0069
 * (`docs/content/docs/en/adr/0069-long-term-memory-external-api-surfaces.md`).
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

import type {
  Memory,
  MemoryReaderContext,
  MemoryScope,
  MemoryStatus,
  MemoryType,
} from "@/types/memory/memory"
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
  evidenceState?: Memory["evidenceState"]
  reviewStatus?: Memory["reviewStatus"]
  conflictWithIds?: string[]
  contaminationState?: Memory["contaminationState"]
  sensitivity?: Memory["sensitivity"]
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
  projectId?: string
  agentId?: string
  branch?: string
  pathPattern?: string
  /** Match the complete scope namespace, including absent optional fields. */
  exactNamespace?: boolean
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
  if (query.exactNamespace) {
    collection = collection.filter(
      (m) =>
        m.characterId === query.characterId &&
        m.projectId === query.projectId &&
        m.agentId === query.agentId &&
        m.branch === query.branch &&
        m.pathPattern === query.pathPattern
    )
  } else {
    if (query.characterId !== undefined)
      collection = collection.filter((m) => m.characterId === query.characterId)
    if (query.projectId !== undefined)
      collection = collection.filter((m) => m.projectId === query.projectId)
    if (query.agentId !== undefined)
      collection = collection.filter((m) => m.agentId === query.agentId)
    if (query.branch !== undefined) collection = collection.filter((m) => m.branch === query.branch)
    if (query.pathPattern !== undefined)
      collection = collection.filter((m) => m.pathPattern === query.pathPattern)
  }
  if (query.type !== undefined) collection = collection.filter((m) => m.type === query.type)
  if (query.status !== undefined) collection = collection.filter((m) => m.status === query.status)
  const rows = await collection.toArray()
  return rows.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Active memories visible to a reader: the `global` base unioned with the
 * given character's override layer. This is the retriever's candidate pool.
 */
function matchesPath(pattern: string | undefined, path: string | undefined): boolean {
  if (!pattern) return true
  if (!path) return false
  const normalizedPattern = pattern.replace(/^\.\//, "").replace(/\/\*\*?$/, "")
  const normalizedPath = path.replace(/^\.\//, "")
  return normalizedPath === normalizedPattern || normalizedPath.startsWith(`${normalizedPattern}/`)
}

function isVisibleToReader(memory: Memory, reader: MemoryReaderContext): boolean {
  if (memory.reviewStatus === "conflict") return false
  if (memory.branch && memory.branch !== reader.branch) return false
  if (!matchesPath(memory.pathPattern, reader.path)) return false
  if (memory.projectId && memory.projectId !== reader.projectId) return false

  switch (memory.scope) {
    case "global":
      return true
    case "workspace":
      return Boolean(reader.projectId && memory.projectId === reader.projectId)
    case "character":
      return Boolean(reader.characterId && memory.characterId === reader.characterId)
    case "agent":
      return Boolean(reader.agentId && memory.agentId === reader.agentId)
  }
}

function scopeSpecificity(memory: Memory): number {
  const base = { global: 0, workspace: 10, character: 20, agent: 30 }[memory.scope]
  return base + (memory.pathPattern ? 5 : 0) + (memory.branch ? 1 : 0)
}

/**
 * Resolve visible active rows from broadest storage into a narrow-wins view.
 * The string overload preserves the pre-workspace character-only API.
 */
export async function listActiveForReader(
  readerOrCharacterId: MemoryReaderContext | string = {}
): Promise<Memory[]> {
  const reader: MemoryReaderContext =
    typeof readerOrCharacterId === "string"
      ? { characterId: readerOrCharacterId }
      : readerOrCharacterId
  const active = await getDb().memories.where("status").equals("active").toArray()
  const visible = active
    .filter((memory) => isVisibleToReader(memory, reader))
    .sort((a, b) => scopeSpecificity(b) - scopeSpecificity(a) || b.updatedAt - a.updatedAt)

  const stableKeys = new Set<string>()
  return visible.filter((memory) => {
    if (memory.key) {
      const key = memory.key.trim().toLocaleLowerCase()
      if (stableKeys.has(key)) return false
      stableKeys.add(key)
    }
    return true
  })
}

/** Active procedural memories for a reader (global + character override). */
export async function listActiveProcedural(
  readerOrCharacterId?: MemoryReaderContext | string
): Promise<Memory[]> {
  const all = await listActiveForReader(readerOrCharacterId)
  return all.filter((m) => m.type === "procedural")
}

/** Count of active memories in a scope — used by the eviction cap. */
export async function countActive(scope: MemoryScope, characterId?: string): Promise<number> {
  const db = getDb()
  const scoped = await db.memories.where("[scope+status]").equals([scope, "active"]).toArray()
  return characterId ? scoped.filter((m) => m.characterId === characterId).length : scoped.length
}

/** Hard-delete a single memory (user-initiated only). */
export async function hardDeleteMemory(id: string): Promise<void> {
  await getDb().memories.delete(id)
}

/** Hard-delete a specific set of memories (bulk panel action). Returns the count. */
export async function hardDeleteMemories(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  await getDb().memories.bulkDelete(ids)
  return ids.length
}

/** Pin / unpin a specific set of memories in one transaction (bulk panel action). */
export async function setMemoriesPinned(ids: string[], pinned: boolean): Promise<void> {
  if (ids.length === 0) return
  const db = getDb()
  const now = Date.now()
  await db.transaction("rw", db.memories, async () => {
    for (const id of ids) {
      await db.memories.update(id, { pinned, updatedAt: now })
    }
  })
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
