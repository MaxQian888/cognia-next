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

import {
  PROJECT_MEMORY_KINDS,
  type Memory,
  type MemoryReaderContext,
  type MemoryRevisionReason,
  type MemoryScope,
  type MemoryStatus,
  type MemoryType,
} from "@/types/memory/memory"
import {
  applyRetrievalFeedback,
  type RetrievalFeedbackVerdict,
} from "@cognia/memory/lifecycle/retrieval-feedback"
import { buildRevisionSnapshot, isRevisionSnapshot } from "@cognia/memory/lifecycle/revision"
import { getDb } from "./schema"

export function newMemoryId(): string {
  return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Preserve `existing`'s text as a revision snapshot when `nextText` replaces
 * it, and return the fields the live row needs alongside the new text.
 *
 * MUST run inside a transaction that includes `memories` and that also writes
 * the live row — the snapshot and the replacement commit together or not at
 * all. Returns `{}` (and writes nothing) when the text is unchanged, so a patch
 * that re-sends the same text does not grow the history.
 *
 * This is the single place the "supersede, never overwrite" rule is enforced;
 * both write chokepoints (`updateMemory` here and `runMemoryMutation` in
 * `./memory-operations`) call it.
 */
export async function preserveRevisionIfTextChanges(
  existing: Memory,
  nextText: string | undefined,
  reason: MemoryRevisionReason,
  now: number
): Promise<Pick<Memory, "revisedAt"> | Record<string, never>> {
  if (nextText === undefined || nextText === existing.text) return {}
  // A snapshot is history; editing one would rewrite the past.
  if (isRevisionSnapshot(existing)) throw new Error("memory_revision_is_immutable")
  await getDb().memories.add(buildRevisionSnapshot(existing, { id: newMemoryId(), now, reason }))
  return { revisedAt: now }
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
  /**
   * Who asked for this write, for the memory-written trigger's self-rejection.
   *
   * Event-only: `createMemory` reads it for the bus and never persists it, so
   * this costs no column and no schema version. Without it a workflow that
   * writes a memory would re-trigger itself through any write that lands after
   * its own run window closed, which the in-flight guard cannot see.
   */
  writeOrigin?: import("@/lib/memory/memory-event-bus").MemoryWriteOrigin
}

export async function createMemory(input: MemoryCreateInput): Promise<Memory> {
  const now = input.createdAt ?? Date.now()
  const { writeOrigin: _writeOrigin, ...persistable } = input
  const row: Memory = {
    tags: [],
    pinned: false,
    ...persistable,
    id: input.id ?? newMemoryId(),
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    accessCount: 0,
    version: 1,
    status: input.status ?? "active",
  }
  await getDb().memories.add(row)
  // Published after the write commits, so a subscriber never sees a memory
  // that is not in the table. Ids and classification only: the row's `text` is
  // a durable fact about the user, and the bus is not the place to carry one.
  void import("@/lib/memory/memory-event-bus")
    .then(({ emitMemoryWritten }) =>
      emitMemoryWritten({
        memoryId: row.id,
        type: row.type,
        scope: row.scope,
        provenance: row.provenance,
        importance: row.importance,
        ...(row.sourceChannel ? { sourceChannel: row.sourceChannel } : {}),
        ...(row.characterId ? { characterId: row.characterId } : {}),
        ...(row.projectId ? { projectId: row.projectId } : {}),
        ...(row.agentId ? { agentId: row.agentId } : {}),
        ...(row.key ? { key: row.key } : {}),
        at: now,
        ...(input.writeOrigin ? { origin: input.writeOrigin } : {}),
      })
    )
    .catch(() => {
      // A bus nobody loaded is not a reason to fail a memory write.
    })
  return row
}

export async function getMemory(id: string): Promise<Memory | undefined> {
  return getDb().memories.get(id)
}

export async function getMemoriesByVectorDocIds(ids: string[]): Promise<Memory[]> {
  if (ids.length === 0) return []
  return getDb().memories.where("vectorDocId").anyOf(ids).toArray()
}

/**
 * Memories learned from one assistant message (v122 index), newest first.
 * Backs the per-message "learned" chip; includes invalidated rows so the chip
 * can render an undone state after 撤销.
 */
export async function listMemoriesBySourceMessageId(messageId: string): Promise<Memory[]> {
  if (!messageId) return []
  const rows = await getDb().memories.where("sourceMessageId").equals(messageId).toArray()
  return rows.sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * Rows whose scope promises a workspace but which carry no `projectId`.
 *
 * `isVisibleToReader` requires `memory.projectId === reader.projectId`, so
 * every one of these is unreadable by construction. They exist because the
 * explicit-capture path used to resolve a scope without resolving the id that
 * scope requires. Indexed on `scope`, so this is a bounded read rather than a
 * full-table scan, and it returns nothing at all on a healthy database.
 */
export async function listWorkspaceMemoriesMissingProject(limit: number): Promise<Memory[]> {
  if (limit <= 0) return []
  const rows = await getDb().memories.where("scope").equals("workspace").toArray()
  return rows.filter((row) => !row.projectId).slice(0, limit)
}

/**
 * Active project claims that have gone longest without a re-check, oldest first.
 *
 * Uses the `projectMemoryKind` index rather than scanning every memory: the
 * personal corpus is the larger of the two on most installs and has no citation
 * model to check. Rows never validated sort first — an unchecked claim is the
 * one the sweep most needs to look at.
 */
export async function listProjectClaimsNeedingRecheck(limit: number): Promise<Memory[]> {
  if (limit <= 0) return []
  const rows = await getDb()
    .memories.where("projectMemoryKind")
    .anyOf([...PROJECT_MEMORY_KINDS])
    .toArray()
  return rows
    .filter((row) => row.status === "active")
    .sort((a, b) => (a.validatedAt ?? 0) - (b.validatedAt ?? 0))
    .slice(0, limit)
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
  /**
   * Freshness and trust, written by the claim re-check sweep. Both are already
   * READ by `isMemoryEligibleForRetrieval` and `governanceScoreFor`; until this
   * patch carried them there was no way to write either, so a claim whose
   * evidence had gone stale kept being injected at full confidence.
   */
  staleness?: Memory["staleness"]
  trustState?: Memory["trustState"]
  /** When the re-check last succeeded. */
  validatedAt?: Memory["validatedAt"]
  /** Hash over the ordered evidence set, for "did the support change" in O(1). */
  evidenceHash?: Memory["evidenceHash"]
  /**
   * Why the write chose this scope, from `resolveMemoryWriteTarget`. Already
   * READ by the inspector, but until this patch carried it only the project
   * miner could ever write one, so a deliberate capture's narrowing was
   * unexplainable.
   */
  scopeRationale?: string
  /** When true, also bumps `version` (used by the consolidation UPDATE op). */
  bumpVersion?: boolean
  /**
   * Why the text is changing, recorded on the revision snapshot that keeps the
   * old text. Only read when `text` differs from the stored text; defaults to
   * `"edit"`.
   */
  revisionReason?: MemoryRevisionReason
  /**
   * Do not keep the outgoing text as a revision. Only for a paired device's
   * optimistic mirror of an edit whose authority is the desktop: the desktop
   * writes the revision and syncs it down, so a local one would be a duplicate.
   */
  skipRevision?: boolean
  /** Set by the lifecycle sweep when it compacts the row. */
  compactedAt?: number
  /** Corroboration counters, refreshed whenever evidence changes. */
  beliefInputs?: Memory["beliefInputs"]
}

/**
 * Apply a partial patch, always bumping `updatedAt`. A patch that changes
 * `text` first preserves the outgoing text as a revision snapshot, in the same
 * transaction.
 */
export async function updateMemory(id: string, patch: MemoryUpdatePatch): Promise<void> {
  const { bumpVersion, revisionReason, skipRevision, ...rest } = patch
  const db = getDb()
  await db.transaction("rw", db.memories, async () => {
    const now = Date.now()
    const needsRow = bumpVersion || rest.text !== undefined
    const existing = needsRow ? await db.memories.get(id) : undefined
    const next: Partial<Memory> = { ...rest, updatedAt: now }
    if (existing && !skipRevision) {
      Object.assign(
        next,
        await preserveRevisionIfTextChanges(existing, rest.text, revisionReason ?? "edit", now)
      )
    }
    if (bumpVersion) next.version = (existing?.version ?? 0) + 1
    await db.memories.update(id, next)
  })
}

/**
 * Earlier texts of one memory, newest first. Each snapshot's
 * `[revisedAt ?? createdAt, invalidatedAt)` is when that text was live and
 * `revisionReason` is why it was replaced.
 *
 * Unindexed by design (no schema version for a history view): the scan is
 * limited to invalidated rows, and it runs when a person opens one memory.
 */
export async function listMemoryRevisions(memoryId: string): Promise<Memory[]> {
  const rows = await getDb()
    .memories.where("status")
    .equals("invalidated")
    .filter((row) => row.revisionOf === memoryId)
    .toArray()
  return rows.sort((a, b) => (b.invalidatedAt ?? 0) - (a.invalidatedAt ?? 0))
}

export type RestoreMemoryRevisionResult =
  { ok: true; memory: Memory } | { ok: false; reason: "not_found" | "not_a_revision" | "unchanged" }

/**
 * Put an earlier text back. The text being replaced becomes a revision itself
 * (`reason: "restore"`), so a restore is undoable the same way. The live row
 * keeps its id; `version` is bumped so optimistic-concurrency callers see the
 * change. Vector re-indexing and the audit event belong to the caller.
 */
export async function restoreMemoryRevision(
  memoryId: string,
  revisionId: string
): Promise<RestoreMemoryRevisionResult> {
  const db = getDb()
  return db.transaction("rw", db.memories, async () => {
    const [live, revision] = await db.memories.bulkGet([memoryId, revisionId])
    if (!live || !revision) return { ok: false, reason: "not_found" } as const
    if (revision.revisionOf !== memoryId) return { ok: false, reason: "not_a_revision" } as const
    if (revision.text === live.text) return { ok: false, reason: "unchanged" } as const
    const now = Date.now()
    const preserved = await preserveRevisionIfTextChanges(live, revision.text, "restore", now)
    const next: Partial<Memory> = {
      ...preserved,
      text: revision.text,
      version: live.version + 1,
      updatedAt: now,
    }
    // Restoring the pre-compaction text un-compacts the row, so a later sweep
    // may compact it again if it goes cold again.
    if (live.compactedAt !== undefined && revision.compactedAt === undefined) {
      next.compactedAt = undefined
    }
    await db.memories.update(memoryId, next)
    return { ok: true, memory: { ...live, ...next } as Memory } as const
  })
}

/**
 * Move a memory to a different namespace.
 *
 * Deliberately NOT part of `MemoryUpdatePatch`. Changing `scope` or `projectId`
 * changes who can ever read the row, so it is a different kind of operation
 * from editing text or flipping a flag, and it should be greppable on its own.
 * The only caller today is the one-time repair for `workspace`-scoped rows that
 * were written without a `projectId` and were therefore unreadable.
 */
export async function relocateMemoryNamespace(
  id: string,
  next: { scope?: Memory["scope"]; projectId?: string; scopeRationale?: string }
): Promise<void> {
  await getDb().memories.update(id, { ...next, updatedAt: Date.now() })
}

/**
 * Record one user verdict on a recalled memory.
 *
 * A dedicated writer rather than `updateMemory` because of a constraint that is
 * invisible from the type signature: `updateMemory` ALWAYS stamps `updatedAt`,
 * and the BM25 corpus cache is keyed by `${count}:${latest updatedAt}`
 * (`retriever.ts`). Routing feedback through the ordinary patch would
 * re-tokenise the entire memory corpus on every single thumbs-up. `updatedAt`
 * means "the content changed"; a vote does not change the content.
 *
 * `touchMemories` skips the stamp for the same reason and would be the
 * precedent to follow if this ever grows a third caller.
 *
 * Returns false when the row is gone — a user can vote on a chip whose memory
 * was deleted in another window.
 */
export async function recordRetrievalFeedback(
  id: string,
  verdict: RetrievalFeedbackVerdict,
  now: number = Date.now()
): Promise<boolean> {
  const db = getDb()
  return db.transaction("rw", db.memories, async () => {
    const row = await db.memories.get(id)
    if (!row) return false
    await db.memories.update(id, { ...applyRetrievalFeedback(row, verdict, now) })
    return true
  })
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

/**
 * Minimum gap between two access bumps of one memory. Recall runs every turn,
 * and access count feeds retention (`forget/retention.ts`); without a cooldown
 * a memory injected on every turn of one long conversation would look like it
 * had been needed dozens of separate times. ai-memory uses the same 60 s.
 */
export const ACCESS_BUMP_COOLDOWN_MS = 60_000

/**
 * Bump `lastAccessedAt` + `accessCount` — called by the retriever on a hit.
 * A row bumped less than {@link ACCESS_BUMP_COOLDOWN_MS} ago is skipped
 * entirely, so a continuously hot memory still earns one bump per minute.
 */
export async function touchMemories(ids: string[], now: number = Date.now()): Promise<void> {
  if (ids.length === 0) return
  const db = getDb()
  await db.transaction("rw", db.memories, async () => {
    for (const id of ids) {
      const row = await db.memories.get(id)
      if (!row) continue
      if (row.accessCount > 0 && now - row.lastAccessedAt < ACCESS_BUMP_COOLDOWN_MS) continue
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
  /**
   * Include revision snapshots (earlier texts of other memories). Off by
   * default: every listing surface — console, plugin/MCP `list`, mentions,
   * global search — shows memories, not wordings of them, and a snapshot is
   * reached through its owner's history (`listMemoryRevisions`).
   */
  includeRevisions?: boolean
}

/**
 * Generic newest-first listing. Used by the panel. When `status` is omitted,
 * both active and invalidated rows are returned (so the panel can show history).
 */
export async function listMemories(query: ListMemoriesQuery = {}): Promise<Memory[]> {
  let collection = getDb().memories.toCollection()
  if (!query.includeRevisions) collection = collection.filter((m) => m.revisionOf === undefined)
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
/**
 * Does a memory's `pathPattern` apply to `path`?
 *
 * Exported because the inspector answers "does this claim apply where I am
 * standing?" and must answer it with the SAME predicate `isVisibleToReader`
 * uses. A second implementation in the UI would eventually disagree with the
 * retriever, and the visible symptom would be a badge saying a claim applies
 * to a file it is never recalled for.
 */
export function matchesPath(pattern: string | undefined, path: string | undefined): boolean {
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

/**
 * Every row visible to a reader WHATEVER its status — active, forgotten, and
 * revision snapshots — for `asOf` recall, which decides per row whether its
 * text was live at the requested instant (`wasLiveAt`). Visibility uses the
 * same predicate as live recall, so history can never widen what a reader may
 * see. No stable-key narrowing: which row held a key changes over time, and
 * the retriever resolves one row per memory identity instead.
 */
export async function listHistoricalForReader(
  readerOrCharacterId: MemoryReaderContext | string = {}
): Promise<Memory[]> {
  const reader: MemoryReaderContext =
    typeof readerOrCharacterId === "string"
      ? { characterId: readerOrCharacterId }
      : readerOrCharacterId
  const rows = await getDb().memories.toArray()
  return rows.filter((memory) => isVisibleToReader(memory, reader))
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
  await hardDeleteMemories([id])
}

/** Hard-delete a specific set of memories (bulk panel action). Returns the count. */
export async function hardDeleteMemories(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  const db = getDb()
  const uniqueIds = [...new Set(ids)]
  return db.transaction(
    "rw",
    [
      db.memories,
      db.memoryEvidence,
      db.memoryAuditEvents,
      db.retrievalEncryptedContent,
      db.retrievalTombstones,
    ],
    async () => {
      const owners = (await db.memories.bulkGet(uniqueIds)).filter(
        (row): row is Memory => row !== undefined
      )
      // Deleting a memory deletes its history: a revision snapshot holds the
      // same user fact in an earlier wording, and "delete" must mean gone.
      const ownerIds = new Set(owners.map((row) => row.id))
      const revisions = await db.memories
        .where("status")
        .equals("invalidated")
        .filter((row) => row.revisionOf !== undefined && ownerIds.has(row.revisionOf))
        .toArray()
      const rows = [...owners, ...revisions.filter((row) => !ownerIds.has(row.id))]
      const now = Date.now()
      for (const row of rows) {
        await db.memoryEvidence.where("memoryId").equals(row.id).delete()
        await db.retrievalEncryptedContent
          .where("[entityType+entityId]")
          .equals(["memory", row.id])
          .delete()
        await db.retrievalTombstones.put({
          id: `memory:${row.id}`,
          entityType: "memory",
          entityId: row.id,
          corpusId: `memory:${row.projectId ?? row.characterId ?? row.agentId ?? "global"}`,
          createdAt: now,
          acknowledgedDeviceIds: [],
          pendingDeviceIds: [],
          eligiblePurgeAt: now + 30 * 24 * 60 * 60 * 1000,
        })
        // Snapshots still get a sync tombstone above (paired devices hold
        // them too), but the audit trail records the memory, once.
        if (row.revisionOf === undefined || !ownerIds.has(row.revisionOf)) {
          await db.memoryAuditEvents.add({
            id: `mau_delete_${row.id}_${now}`,
            action: "deleted",
            memoryId: row.id,
            reason: "user_requested",
            createdAt: now,
          })
        }
      }
      await db.memories.bulkDelete(rows.map((row) => row.id))
      return owners.length
    }
  )
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
  // Clearing forgotten memories clears history too: a revision snapshot is an
  // earlier wording kept for undo, which is exactly what "clear archived"
  // asks to drop. Every other clear reaches snapshots through their owner.
  const rows = await listMemories(
    query.status === "invalidated" ? { ...query, includeRevisions: true } : query
  )
  const ids = rows.map((m) => m.id)
  if (ids.length === 0) return 0
  return hardDeleteMemories(ids)
}
