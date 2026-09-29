/**
 * Memory revisions — supersede, never overwrite.
 *
 * Before this, an UPDATE replaced `text` in place and bumped `version`; the
 * previous wording was gone, so a bad consolidation merge or a mistaken edit
 * could not be undone. ai-memory keeps every page version in a supersession
 * chain with `restore-page`; Cognia gets the same property without a second
 * table by writing the outgoing text as a SNAPSHOT row in `memories` itself:
 *
 * - `status: "invalidated"` — already excluded from recall, eviction and every
 *   active-row query, so a snapshot can never be injected into a prompt;
 * - `revisionOf` / `supersededById` = the live memory's id — the chain link;
 * - `revisedAt` → `invalidatedAt` — the window the preserved text was live,
 *   which is what `asOf` recall reads;
 * - no `vectorDocId`, `key`, `sourceMessageId` or `sourceSessionId` — a
 *   snapshot must not be found by vector search, by the stable-key dedupe, or
 *   by "memories learned from this message"; it is reachable only through its
 *   owner's history.
 *
 * The live row keeps its id and version counter, so external callers holding
 * an id (MCP, plugins, paired devices) and optimistic-concurrency checks are
 * unaffected.
 *
 * Pure — the Dexie layer (`lib/db/memories.ts`) decides when to call these.
 */

import type { Memory, MemoryRevisionReason } from "../types/memory"

/** When a row's current text took effect. */
export function textEffectiveFrom(memory: Pick<Memory, "createdAt" | "revisedAt">): number {
  return memory.revisedAt ?? memory.createdAt
}

export function isRevisionSnapshot(memory: Pick<Memory, "revisionOf">): boolean {
  return memory.revisionOf !== undefined
}

/**
 * The snapshot preserving `current`'s text, to be written in the same
 * transaction that replaces it.
 */
export function buildRevisionSnapshot(
  current: Memory,
  options: { id: string; now: number; reason: MemoryRevisionReason }
): Memory {
  const snapshot: Memory = {
    id: options.id,
    scope: current.scope,
    type: current.type,
    text: current.text,
    tags: [...current.tags],
    importance: current.importance,
    createdAt: current.createdAt,
    updatedAt: options.now,
    lastAccessedAt: current.lastAccessedAt,
    // Access reinforcement belongs to the live memory, not to a wording of it.
    accessCount: 0,
    version: current.version,
    status: "invalidated",
    invalidatedAt: options.now,
    supersededById: current.id,
    pinned: false,
    provenance: current.provenance,
    revisionOf: current.id,
    revisionReason: options.reason,
    revisedAt: textEffectiveFrom(current),
  }
  // Namespace fields are copied so the snapshot is encrypted, synced and
  // deleted under the same corpus as its owner.
  if (current.characterId !== undefined) snapshot.characterId = current.characterId
  if (current.projectId !== undefined) snapshot.projectId = current.projectId
  if (current.agentId !== undefined) snapshot.agentId = current.agentId
  if (current.branch !== undefined) snapshot.branch = current.branch
  if (current.pathPattern !== undefined) snapshot.pathPattern = current.pathPattern
  if (current.projectMemoryKind !== undefined) {
    snapshot.projectMemoryKind = current.projectMemoryKind
  }
  if (current.sourceChannel !== undefined) snapshot.sourceChannel = current.sourceChannel
  if (current.sourcePluginId !== undefined) snapshot.sourcePluginId = current.sourcePluginId
  if (current.evidenceState !== undefined) snapshot.evidenceState = current.evidenceState
  if (current.contaminationState !== undefined) {
    snapshot.contaminationState = current.contaminationState
  }
  if (current.sensitivity !== undefined) snapshot.sensitivity = current.sensitivity
  if (current.compactedAt !== undefined) snapshot.compactedAt = current.compactedAt
  // Governance at the time the text was live — `asOf` recall applies the same
  // exclusions (conflict, quarantine, unverified procedural) the live
  // retriever applied then.
  if (current.reviewStatus !== undefined) snapshot.reviewStatus = current.reviewStatus
  if (current.trustState !== undefined) snapshot.trustState = current.trustState
  if (current.staleness !== undefined) snapshot.staleness = current.staleness
  if (current.confidence !== undefined) snapshot.confidence = current.confidence
  if (current.expiresAt !== undefined) snapshot.expiresAt = current.expiresAt
  return snapshot
}

/**
 * Whether a row's text was the live text of its memory at `asOf`.
 *
 * - A snapshot or an invalidated memory was live over
 *   `[revisedAt ?? createdAt, invalidatedAt)`.
 * - An active memory is live from `revisedAt ?? createdAt` onward.
 * - An explicit `expiresAt` at or before `asOf` ends it, exactly as the live
 *   retriever treats expiry.
 *
 * This is ingestion time (when Cognia held the text), not event time
 * (`observedAt`) — the same "bi-temporal-lite" contract as ai-memory.
 */
export function wasLiveAt(
  memory: Pick<Memory, "createdAt" | "revisedAt" | "status" | "invalidatedAt" | "expiresAt">,
  asOf: number
): boolean {
  if (textEffectiveFrom(memory) > asOf) return false
  if (memory.expiresAt !== null && memory.expiresAt !== undefined && memory.expiresAt <= asOf) {
    return false
  }
  if (memory.status === "invalidated") {
    return memory.invalidatedAt !== undefined && memory.invalidatedAt > asOf
  }
  return true
}

/**
 * The memory identity a row speaks for — the owner's id for a snapshot, the
 * row's own id otherwise. Historical recall returns at most one row per
 * identity.
 */
export function memoryIdentity(memory: Pick<Memory, "id" | "revisionOf">): string {
  return memory.revisionOf ?? memory.id
}
