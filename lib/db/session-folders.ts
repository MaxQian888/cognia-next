import Dexie from "dexie"

import type { SessionFolder } from "@cognia/agent-config-types"

import type { AllowedHostStateIntent } from "@cognia/agent-config-types/host-state"

import { getDb } from "./schema"
import { resolveScopeProjectId } from "./project-scope"
import { stampOrganizationalWrite } from "./session-row-stamps"
import { assertSessionWritable } from "@/lib/chat/session-write-guard"
import { recordTombstones } from "@/lib/sync/tombstones"

/**
 * Conversation folders (conversation-list overhaul, Dexie v90). A lightweight,
 * workspace-scoped folder dimension orthogonal to the workspace itself.
 * Sessions reference a folder via the indexed `ChatSession.folderId` (see
 * `assignSessionToFolder` in `lib/db/sessions.ts`). Folders are NOT sessions —
 * deleting one only reverts its members to loose, never deletes the
 * conversations.
 *
 * Folders are Host-authoritative like the rest of the conversation list. The
 * Host's `sessionFolders` table reaches paired devices through `sessionFolders`
 * table sync, and the four public writers below route a paired client's write
 * to the Host as a `folder.*` HostState intent — the same routing
 * `hooks/chat/use-sessions.ts` uses for the session intents — so a caller
 * never branches on where it runs:
 *
 * - {@link createFolder} writes the row locally in every case. Standalone that
 *   IS the write; paired it is the optimistic row, under the id the Host will
 *   hold too, so a `session.folder` queued right behind it names the same
 *   folder. A refused create is discarded again by
 *   `lib/sync/host-state-intent-settlement.ts`.
 * - {@link renameFolder}, {@link reorderFolders} and {@link deleteFolder} write
 *   locally only when no Host takes them; a Host-bound one lands when table
 *   sync brings the Host's row back, as `session.rename` does.
 *
 * The `write*` functions are the raw repository: no routing, explicit ids and
 * clock, and every table they touch opened in one transaction that joins the
 * caller's. The Host applier (`lib/sync/host-state-store.ts`) calls them inside
 * its ledger transaction.
 */

function newFolderId() {
  return "f_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

/** Folders for one workspace, in manual `order` (defaults to the active project). */
export async function listFolders(projectId?: string): Promise<SessionFolder[]> {
  // liveQuery zone-safety: same as `listScopedSessions` — with an explicit pid
  // the Dexie read must start before any `await`, or the sidebar's liveQuery
  // loses dependency tracking and folder create/rename/delete never re-emit.
  const pid = projectId || (await resolveScopeProjectId())
  return getDb()
    .sessionFolders.where("[projectId+order]")
    .between([pid, Dexie.minKey], [pid, Dexie.maxKey])
    .toArray()
}

/** The tables every folder write may touch, for callers that open the transaction. */
export function folderWriteTables(db: ReturnType<typeof getDb>) {
  return [db.sessionFolders, db.sessions, db.syncTombstones]
}

/**
 * Insert a folder at the end of its workspace's list. `name` is stored
 * trimmed. Writing an id that already exists replaces that row — callers mint
 * fresh ids, and the Host refuses a create for an id it holds before calling.
 */
export async function writeFolderCreate(input: {
  id: string
  projectId: string
  name: string
  now: number
}): Promise<SessionFolder> {
  const db = getDb()
  return db.transaction("rw", folderWriteTables(db), async () => {
    const siblings = await db.sessionFolders.where("projectId").equals(input.projectId).toArray()
    const order =
      siblings
        .filter((folder) => folder.id !== input.id)
        .reduce((max, folder) => Math.max(max, folder.order), -1) + 1
    const folder: SessionFolder = {
      id: input.id,
      projectId: input.projectId,
      name: input.name.trim(),
      order,
      createdAt: input.now,
      updatedAt: input.now,
    }
    await db.sessionFolders.put(folder)
    return folder
  })
}

/** Rename a folder. Resolves `false` when there is no such folder. */
export async function writeFolderRename(id: string, name: string, now: number): Promise<boolean> {
  const updated = await getDb().sessionFolders.update(id, { name: name.trim(), updatedAt: now })
  return updated > 0
}

/**
 * Persist a manual order for a workspace's folders.
 *
 * `SessionFolder.order` is what the list model sorts sections by. Ids are
 * renumbered from zero in the order given, and ids that are not folders of
 * this workspace are ignored — a stale list from a concurrent rename/delete
 * must not renumber someone else's rows. Anything the caller did not name
 * keeps its relative position after the ones it did — a folder created
 * mid-drag lands at the end, not at 0. Rows whose position is unchanged are
 * not rewritten, so a one-folder drag syncs one row.
 */
export async function writeFolderReorder(
  projectId: string,
  orderedIds: readonly string[],
  now: number
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", folderWriteTables(db), async () => {
    const siblings = await db.sessionFolders.where("projectId").equals(projectId).toArray()
    const byId = new Map(siblings.map((folder) => [folder.id, folder]))
    const requested = [...new Set(orderedIds)].filter((id) => byId.has(id))
    const rest = siblings
      .filter((folder) => !requested.includes(folder.id))
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
      .map((folder) => folder.id)
    for (const [index, id] of [...requested, ...rest].entries()) {
      if (byId.get(id)?.order === index) continue
      await db.sessionFolders.update(id, { order: index, updatedAt: now })
    }
  })
}

/**
 * Ids of the conversations filed in `folderId`, through the `folderId` index.
 *
 * Not narrowed by the folder's `projectId`: a conversation of NO workspace (a
 * paired client's host-synced history) can be filed into a workspace folder.
 */
export async function listFolderMemberIds(folderId: string): Promise<string[]> {
  return (await getDb().sessions.where("folderId").equals(folderId).primaryKeys()) as string[]
}

/**
 * Delete a folder and unfile its members in ONE transaction; the
 * conversations themselves are never deleted.
 *
 * Every member passes the handoff write gate before anything is written: a
 * conversation frozen for a cross-host handoff refuses the unfile with
 * `SessionHandoffLockedError`, and the whole delete rolls back rather than
 * leaving the folder half-emptied. Unfiled members are stamped like any
 * organizational write, so the cleared `folderId` syncs without the rows
 * moving in the recency order, and the folder leaves a `sessionFolders`
 * tombstone so a paired device drops it too. Deleting a folder that is
 * already gone is a no-op.
 */
export async function writeFolderDelete(id: string, now: number): Promise<void> {
  const db = getDb()
  await db.transaction("rw", folderWriteTables(db), async () => {
    const members = await db.sessions.where("folderId").equals(id).toArray()
    for (const session of members) assertSessionWritable(session, "metadata")
    if (members.length > 0) {
      await db.sessions
        .where("folderId")
        .equals(id)
        .modify((session) => {
          delete session.folderId
          stampOrganizationalWrite(session, now)
        })
    }
    if (!(await db.sessionFolders.get(id))) return
    await db.sessionFolders.delete(id)
    await recordTombstones("sessionFolders", [id], now)
  })
}

/**
 * Drop a folder row that only ever existed on this device — the optimistic
 * row of a `folder.create` the Host refused. No tombstone (the Host never held
 * it) and no member rewrite (a `session.folder` naming it went to the Host,
 * never to a local row).
 */
export async function discardLocalFolder(id: string): Promise<void> {
  await getDb().sessionFolders.delete(id)
}

/**
 * Hand a folder write to the Host when this device is a paired client that
 * negotiated HostState. Resolves `false` when there is no Host to take it —
 * the caller then writes locally. Imported lazily: the outbound queue is only
 * needed on the paired path.
 */
async function forwardToHost(action: AllowedHostStateIntent): Promise<boolean> {
  const { enqueueHostStateIntentIfAvailable } = await import("./mobile-outbound-queue")
  return (await enqueueHostStateIntentIfAvailable({ action })) !== null
}

/**
 * Create a folder at the end of the workspace's folder list (defaults to the
 * active workspace). See the module doc for the paired path.
 */
export async function createFolder(
  name: string,
  opts?: { projectId?: string }
): Promise<SessionFolder> {
  const projectId = await resolveScopeProjectId(opts?.projectId)
  const id = newFolderId()
  const trimmed = name.trim()
  // Local row first: a Host that answers before this write would otherwise
  // have its synced row overwritten by the optimistic one.
  const folder = await writeFolderCreate({ id, projectId, name: trimmed, now: Date.now() })
  try {
    await forwardToHost({ kind: "folder.create", folderId: id, projectId, name: trimmed })
  } catch (error) {
    // The outbox refused it (full, or no delivery scope): nothing will ever
    // reach the Host, so the row must not stay behind as if it had.
    await discardLocalFolder(id)
    throw error
  }
  return folder
}

/** Rename a folder. */
export async function renameFolder(id: string, name: string): Promise<void> {
  const trimmed = name.trim()
  if (await forwardToHost({ kind: "folder.rename", folderId: id, name: trimmed })) return
  await writeFolderRename(id, trimmed, Date.now())
}

/** Persist a manual order for the workspace's folders (defaults to the active workspace). */
export async function reorderFolders(
  orderedIds: readonly string[],
  opts?: { projectId?: string }
): Promise<void> {
  const projectId = await resolveScopeProjectId(opts?.projectId)
  const ids = [...new Set(orderedIds)]
  if (await forwardToHost({ kind: "folder.reorder", projectId, orderedIds: ids })) return
  await writeFolderReorder(projectId, ids, Date.now())
}

/**
 * Delete a folder; its conversations become loose. On a paired client the
 * Host unfiles the members in its own transaction, under its own handoff
 * locks.
 */
export async function deleteFolder(id: string): Promise<void> {
  if (await forwardToHost({ kind: "folder.delete", folderId: id })) return
  await writeFolderDelete(id, Date.now())
}
