import Dexie from "dexie"

import type { SessionFolder } from "@cognia/agent-config-types"

import { getDb } from "./schema"
import { resolveScopeProjectId } from "./project-scope"
import { assertSessionWritable } from "@/lib/chat/session-write-guard"

/**
 * Conversation folders (conversation-list overhaul, Dexie v90). A lightweight,
 * workspace-scoped folder dimension orthogonal to the workspace itself.
 * Sessions reference a folder via the non-indexed `ChatSession.folderId`
 * (see `assignSessionToFolder` in `lib/db/sessions.ts`). Folders are NOT
 * sessions — deleting one only reverts its members to loose, never deletes
 * the conversations.
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

/** Create a folder at the end of the workspace's folder list. */
export async function createFolder(
  name: string,
  opts?: { projectId?: string }
): Promise<SessionFolder> {
  const pid = await resolveScopeProjectId(opts?.projectId)
  const db = getDb()
  const siblings = await db.sessionFolders.where("projectId").equals(pid).toArray()
  const order = siblings.reduce((max, f) => Math.max(max, f.order), -1) + 1
  const now = Date.now()
  const folder: SessionFolder = {
    id: newFolderId(),
    projectId: pid,
    name: name.trim(),
    order,
    createdAt: now,
    updatedAt: now,
  }
  await db.sessionFolders.put(folder)
  return folder
}

/** Rename a folder. */
export async function renameFolder(id: string, name: string): Promise<void> {
  await getDb().sessionFolders.update(id, { name: name.trim(), updatedAt: Date.now() })
}

/**
 * Persist a manual order for the workspace's folders.
 *
 * `SessionFolder.order` is what the list model sorts sections by; until this
 * existed it was only ever assigned at create time (append to the end), so the
 * "manual sort position" the type promised could not actually be changed. Ids
 * are renumbered from zero in the order given, and ids that are not folders of
 * this workspace are ignored — a stale list from a concurrent rename/delete
 * must not renumber someone else's rows.
 */
export async function reorderFolders(
  orderedIds: readonly string[],
  opts?: { projectId?: string }
): Promise<void> {
  const pid = await resolveScopeProjectId(opts?.projectId)
  const db = getDb()
  await db.transaction("rw", db.sessionFolders, async () => {
    const siblings = await db.sessionFolders.where("projectId").equals(pid).toArray()
    const byId = new Map(siblings.map((folder) => [folder.id, folder]))
    const requested = orderedIds.filter((id) => byId.has(id))
    // Anything the caller did not name keeps its relative position after the
    // ones it did — a folder created mid-drag lands at the end, not at 0.
    const rest = siblings
      .filter((folder) => !requested.includes(folder.id))
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
      .map((folder) => folder.id)
    const now = Date.now()
    await Promise.all(
      [...requested, ...rest].map((id, index) => {
        const folder = byId.get(id)
        if (!folder || folder.order === index) return Promise.resolve(0)
        return db.sessionFolders.update(id, { order: index, updatedAt: now })
      })
    )
  })
}

/**
 * Ids of the conversations filed in `folderId`.
 *
 * A table scan: `ChatSession.folderId` is not indexed, and the folder's
 * `projectId` cannot narrow it either — a conversation of NO workspace (a
 * paired client's host-synced history) can be filed into a workspace folder,
 * and such a row is absent from the `projectId` index.
 */
export async function listFolderMemberIds(folderId: string): Promise<string[]> {
  return (await getDb()
    .sessions.filter((session) => session.folderId === folderId)
    .primaryKeys()) as string[]
}

/**
 * Delete a folder. Member sessions are reverted to loose (their `folderId`
 * cleared) in the SAME transaction — the conversations themselves are never
 * deleted.
 *
 * Every member passes the handoff write gate before anything is written: a
 * conversation frozen for a cross-host handoff refuses the unfile with
 * `SessionHandoffLockedError`, and the whole delete rolls back rather than
 * leaving the folder half-emptied.
 *
 * `leaveSessionIds` names members whose unfile has already been handed to the
 * Host (`session.folder` intents on a paired client). Their rows are the Host's
 * to write — table sync brings the cleared `folderId` back — so they are
 * neither checked nor touched here; until then they point at a folder that no
 * longer exists, which the list model renders as loose.
 */
export async function deleteFolder(
  id: string,
  opts?: { leaveSessionIds?: readonly string[] }
): Promise<void> {
  const leave = new Set(opts?.leaveSessionIds ?? [])
  const db = getDb()
  await db.transaction("rw", db.sessionFolders, db.sessions, async () => {
    const members = await db.sessions
      .filter((session) => session.folderId === id && !leave.has(session.id))
      .toArray()
    for (const session of members) assertSessionWritable(session, "metadata")
    if (members.length > 0) {
      await db.sessions
        .where("id")
        .anyOf(members.map((session) => session.id))
        .modify((session) => {
          delete session.folderId
        })
    }
    await db.sessionFolders.delete(id)
  })
}
