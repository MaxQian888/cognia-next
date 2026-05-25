/**
 * Workflow library folder CRUD (ADR-0011 library upgrade). Mirrors the
 * `lib/db/workflows.ts` API shape (`list / get / create / rename / update /
 * move / delete`) plus tree helpers (`getFolderPath`,
 * `getDescendantFolderIds`).
 *
 * Root is the sentinel `ROOT_FOLDER_ID` ("root"), never `null` — see
 * `types/workflow/folder.ts` for why (IndexedDB can't index null keys).
 */

import type { WorkflowFolder, WorkflowFolderPatch } from "@/types/workflow/folder"
import { ROOT_FOLDER_ID } from "@/types/workflow/folder"
import { getDb } from "./schema"

/** Guard against a corrupt `parentFolderId` cycle when walking up to root. */
const MAX_DEPTH = 64

function newFolderId(): string {
  return "wff_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

function nowMs(): number {
  return Date.now()
}

export async function listFolders(): Promise<WorkflowFolder[]> {
  return getDb().workflowFolders.orderBy("name").toArray()
}

/** Direct children of `parentFolderId`, sorted by name (uses the index). */
export async function listChildFolders(parentFolderId: string): Promise<WorkflowFolder[]> {
  return getDb().workflowFolders.where("parentFolderId").equals(parentFolderId).sortBy("name")
}

export async function getFolder(id: string): Promise<WorkflowFolder | undefined> {
  return getDb().workflowFolders.get(id)
}

export interface FolderDraft {
  name: string
  parentFolderId?: string
  color?: string
  icon?: string
}

export async function createFolder(draft: FolderDraft): Promise<WorkflowFolder> {
  const now = nowMs()
  const folder: WorkflowFolder = {
    id: newFolderId(),
    name: draft.name.trim() || "Untitled folder",
    parentFolderId: draft.parentFolderId ?? ROOT_FOLDER_ID,
    createdAt: now,
    updatedAt: now,
    color: draft.color,
    icon: draft.icon,
  }
  await getDb().workflowFolders.put(folder)
  return folder
}

export async function renameFolder(id: string, name: string): Promise<void> {
  await getDb().workflowFolders.update(id, {
    name: name.trim() || "Untitled folder",
    updatedAt: nowMs(),
  })
}

export async function updateFolder(id: string, patch: WorkflowFolderPatch): Promise<void> {
  await getDb().workflowFolders.update(id, { ...patch, updatedAt: nowMs() })
}

/**
 * Re-parent a folder. Rejects moves that would create a cycle (into itself or
 * any of its own descendants) — that would orphan a subtree and hang the
 * `getFolderPath` walk.
 */
export async function moveFolder(id: string, newParentFolderId: string): Promise<void> {
  if (id === newParentFolderId) {
    throw new Error("A folder cannot be moved into itself.")
  }
  if (newParentFolderId !== ROOT_FOLDER_ID) {
    const descendants = await getDescendantFolderIds(id)
    if (descendants.has(newParentFolderId)) {
      throw new Error("A folder cannot be moved into one of its own subfolders.")
    }
  }
  await getDb().workflowFolders.update(id, {
    parentFolderId: newParentFolderId,
    updatedAt: nowMs(),
  })
}

export type DeleteFolderMode = "reparent" | "cascade"

/**
 * Delete a folder.
 *   • "reparent" (default UX) — never destroys content: every direct child
 *     folder and workflow is moved up to the deleted folder's parent, then
 *     the folder row is removed.
 *   • "cascade" — removes the whole subtree: descendant folders and their
 *     non-built-in workflows are deleted; built-in workflows are protected
 *     (reparented to root) rather than failing the whole transaction.
 * Runs in one transaction over both tables so a crash can't half-apply it.
 */
export async function deleteFolder(id: string, mode: DeleteFolderMode = "reparent"): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.workflows, db.workflowFolders, async () => {
    const folder = await db.workflowFolders.get(id)
    if (!folder) return

    if (mode === "reparent") {
      const target = folder.parentFolderId
      await db.workflowFolders
        .where("parentFolderId")
        .equals(id)
        .modify({ parentFolderId: target, updatedAt: nowMs() })
      await db.workflows
        .where("folderId")
        .equals(id)
        .modify({ folderId: target, updatedAt: nowMs() })
      await db.workflowFolders.delete(id)
      return
    }

    // Cascade — collect the whole subtree (the folder itself + descendants).
    const subtree = await getDescendantFolderIds(id)
    subtree.add(id)
    for (const folderId of subtree) {
      const rows = await db.workflows.where("folderId").equals(folderId).toArray()
      const toDelete = rows.filter((w) => !w.isBuiltIn).map((w) => w.id)
      const builtInIds = rows.filter((w) => w.isBuiltIn).map((w) => w.id)
      if (toDelete.length > 0) await db.workflows.bulkDelete(toDelete)
      // Built-in workflows are protected from deletion — lift them to root.
      for (const builtInId of builtInIds) {
        await db.workflows.update(builtInId, {
          folderId: ROOT_FOLDER_ID,
          updatedAt: nowMs(),
        })
      }
      await db.workflowFolders.delete(folderId)
    }
  })
}

/**
 * The chain of folders from the topmost ancestor down to (and including)
 * `id`. Returns `[]` for the root sentinel or a missing folder. Capped at
 * `MAX_DEPTH` so a corrupt cycle can never hang the breadcrumb.
 */
export async function getFolderPath(id: string): Promise<WorkflowFolder[]> {
  if (id === ROOT_FOLDER_ID) return []
  const db = getDb()
  const chain: WorkflowFolder[] = []
  let cursor: string | undefined = id
  let depth = 0
  while (cursor && cursor !== ROOT_FOLDER_ID && depth < MAX_DEPTH) {
    const folder: WorkflowFolder | undefined = await db.workflowFolders.get(cursor)
    if (!folder) break
    chain.unshift(folder)
    cursor = folder.parentFolderId
    depth += 1
  }
  return chain
}

/** All folder ids strictly below `id` (BFS over the children index). */
export async function getDescendantFolderIds(id: string): Promise<Set<string>> {
  const db = getDb()
  const out = new Set<string>()
  let frontier = [id]
  let depth = 0
  while (frontier.length > 0 && depth < MAX_DEPTH) {
    const children = await db.workflowFolders.where("parentFolderId").anyOf(frontier).toArray()
    const next: string[] = []
    for (const child of children) {
      if (!out.has(child.id)) {
        out.add(child.id)
        next.push(child.id)
      }
    }
    frontier = next
    depth += 1
  }
  return out
}
