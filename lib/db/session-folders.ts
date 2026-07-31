import Dexie from "dexie"

import type { SessionFolder } from "@cognia/agent-config-types"

import { getDb } from "./schema"
import { resolveScopeProjectId } from "./project-scope"

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
 * Delete a folder. Member sessions are reverted to loose (their `folderId`
 * cleared) in the SAME transaction — the conversations themselves are never
 * deleted. `folderId` is non-indexed, so members are found by a table scan.
 */
export async function deleteFolder(id: string): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.sessionFolders, db.sessions, async () => {
    await db.sessions
      .filter((s) => s.folderId === id)
      .modify((s) => {
        delete s.folderId
      })
    await db.sessionFolders.delete(id)
  })
}
