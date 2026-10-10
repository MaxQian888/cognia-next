/**
 * What "delete forever" means for each kind of Files item in the Trash
 * (ADR-0223). One rule, shared by the Trash's own "Delete forever" / "Empty
 * Trash" and by the 30-day purge (`./trash-purge-schedule.ts`):
 *
 * - **Files-owned** (an upload made straight into Files, or an image adopted
 *   from Files' own upload menu) — Files is its only home, so it is deleted,
 *   bytes included unless a conversation still references them.
 * - **Source still alive** (the artifact's or canvas document's conversation,
 *   or any conversation showing the image or file, still exists; a canvas
 *   document made outside any conversation counts as alive) — Files never
 *   deletes another surface's content. The item leaves the Trash as "removed
 *   from Files" (`hiddenAt`) and the source is untouched.
 * - **Source gone** — nothing outside Files holds the item any more. Its row
 *   and pin go, so media GC collects bytes nobody references; an orphaned
 *   artifact or canvas row (spared at its conversation's purge only because
 *   Files kept it) is deleted with it.
 * - **Workspace files** (ADR-0223 §8) follow their conversation: alive, the
 *   item is retired as "removed from Files"; gone, its row goes. The file on
 *   disk is never touched either way.
 */

import { LIBRARY_REF_SESSION_ID } from "@/lib/db/message-media-refs"
import {
  deleteLibraryItemRows,
  deleteOwnedLibraryItem,
  retireTrashedLibraryItems,
  type LibraryItemSource,
} from "@/lib/db/files-library-items"
import type { LibraryItemKind, LibraryItemRow } from "@/lib/db/files-library-types"
import { getDb } from "@/lib/db/schema"
import { getSessionsByIds } from "@/lib/db/sessions"

import { originalMediaKey } from "./aggregate"

/** Enough of a trashed item to decide and carry out its purge. */
export interface TrashPurgeTarget {
  key: string
  kind: LibraryItemKind
  sourceId: string
  ownedByFiles: boolean
  /** Something outside Files still holds the item (see module docs). */
  originAlive: boolean
}

export type TrashPurgeAction = "delete-owned" | "retire" | "delete-orphan"

export function trashPurgeAction(target: TrashPurgeTarget): TrashPurgeAction {
  if (target.ownedByFiles) return "delete-owned"
  return target.originAlive ? "retire" : "delete-orphan"
}

export interface TrashPurgeDependencies {
  deleteOwned: (key: string) => Promise<void>
  retire: (sources: readonly LibraryItemSource[]) => Promise<unknown>
  deleteRows: (keys: readonly string[]) => Promise<void>
  /** Delete an orphaned artifact / canvas row through the store that owns it. */
  deleteOrphanSource: (kind: "artifact" | "canvas", id: string) => Promise<void>
}

async function deleteOrphanSourceFromStore(kind: "artifact" | "canvas", id: string): Promise<void> {
  const { useArtifactStore } = await import("@/stores/artifact/artifact-store")
  const store = useArtifactStore.getState()
  if (kind === "artifact") {
    if (store.artifacts[id]) store.deleteArtifact(id)
  } else if (store.canvasDocuments[id]) {
    store.deleteCanvasDocument(id)
  }
}

const DEFAULT_DEPENDENCIES: TrashPurgeDependencies = {
  deleteOwned: deleteOwnedLibraryItem,
  retire: retireTrashedLibraryItems,
  deleteRows: deleteLibraryItemRows,
  deleteOrphanSource: deleteOrphanSourceFromStore,
}

export interface TrashPurgeOutcome {
  deleted: number
  retired: number
}

/** Purge `targets` from the Trash, each by `trashPurgeAction`. */
export async function purgeTrashedItems(
  targets: readonly TrashPurgeTarget[],
  dependencies: Partial<TrashPurgeDependencies> = {}
): Promise<TrashPurgeOutcome> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies }
  const retire: LibraryItemSource[] = []
  const orphans: TrashPurgeTarget[] = []
  let deleted = 0
  for (const target of targets) {
    switch (trashPurgeAction(target)) {
      case "delete-owned":
        await deps.deleteOwned(target.key)
        deleted += 1
        break
      case "retire":
        retire.push({ kind: target.kind, sourceId: target.sourceId })
        break
      case "delete-orphan":
        orphans.push(target)
        break
    }
  }
  if (retire.length > 0) await deps.retire(retire)
  for (const orphan of orphans) {
    if (orphan.kind === "artifact" || orphan.kind === "canvas") {
      await deps.deleteOrphanSource(orphan.kind, orphan.sourceId)
    }
  }
  if (orphans.length > 0) await deps.deleteRows(orphans.map((orphan) => orphan.key))
  return { deleted: deleted + orphans.length, retired: retire.length }
}

/**
 * Whether something outside Files still holds each trashed row, read from the
 * rows themselves — the purge runs without the Files page, so it cannot ask
 * the aggregate.
 */
export async function resolveTrashPurgeTargets(
  rows: readonly LibraryItemRow[]
): Promise<TrashPurgeTarget[]> {
  const db = getDb()
  const mediaKeys = rows.flatMap((row) =>
    row.kind === "image"
      ? [row.sourceId]
      : row.kind === "session-upload"
        ? [originalMediaKey(row.sourceId)]
        : []
  )
  const refs = mediaKeys.length
    ? await db.messageMediaRefs.where("hash").anyOf(mediaKeys).toArray()
    : []
  const conversationsByHash = new Map<string, Set<string>>()
  for (const ref of refs) {
    if (ref.sessionId === LIBRARY_REF_SESSION_ID) continue
    const set = conversationsByHash.get(ref.hash) ?? new Set<string>()
    set.add(ref.sessionId)
    conversationsByHash.set(ref.hash, set)
  }
  const candidateSessions = new Set<string>()
  for (const row of rows) if (row.originSessionId) candidateSessions.add(row.originSessionId)
  for (const set of conversationsByHash.values()) for (const id of set) candidateSessions.add(id)
  const live = new Set(
    (await getSessionsByIds([...candidateSessions])).map((session) => session.id)
  )
  const anyLive = (hash: string) =>
    [...(conversationsByHash.get(hash) ?? [])].some((id) => live.has(id))

  return rows.map((row) => {
    let originAlive: boolean
    switch (row.kind) {
      case "artifact":
      case "canvas":
        // A canvas document made outside any conversation has no origin to lose.
        originAlive = row.originSessionId ? live.has(row.originSessionId) : row.kind === "canvas"
        break
      case "image":
        originAlive = anyLive(row.sourceId)
        break
      case "session-upload":
        originAlive = anyLive(originalMediaKey(row.sourceId))
        break
      case "upload":
        originAlive = true
        break
      case "workspace-file":
        originAlive = row.originSessionId ? live.has(row.originSessionId) : false
        break
    }
    return {
      key: row.key,
      kind: row.kind,
      sourceId: row.sourceId,
      ownedByFiles: row.ownedByFiles === true,
      originAlive,
    }
  })
}
