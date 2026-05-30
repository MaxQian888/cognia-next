/**
 * Dexie helpers for the workflow editor's viewport bookmarks.
 *
 * Bookmarks store a named `{x, y, zoom}` per workflow. The toolbar dropdown
 * lists them newest-first via the `[workflowId+createdAt]` compound index.
 */

import { nanoid } from "nanoid"
import { getDb } from "@/lib/db/schema"

/**
 * Per-workflow viewport bookmark. Persists the user-saved `{x, y, zoom}` so
 * the "Views" dropdown can restore it later with a smooth tween.
 *
 * Co-located with its CRUD here (mirrors `WorkflowProposalHistoryRow` in
 * `lib/workflow/editor/proposal-history.ts`); `lib/db/schema.ts` imports +
 * re-exports it, so existing `@/lib/db/schema` import sites keep working.
 * See `lib/db/CONVENTIONS.md`.
 */
export interface WorkflowViewportBookmarkRow {
  /** `vb_` + nanoid. */
  id: string
  workflowId: string
  /** User-supplied label (defaults to "View at NN%" in the UI). */
  name: string
  viewport: { x: number; y: number; zoom: number }
  createdAt: number
}

const ID_PREFIX = "vb_"

export type Viewport = WorkflowViewportBookmarkRow["viewport"]

export async function listBookmarks(workflowId: string): Promise<WorkflowViewportBookmarkRow[]> {
  if (!workflowId) return []
  const rows = await getDb()
    .workflowViewportBookmarks.where("[workflowId+createdAt]")
    .between([workflowId, 0], [workflowId, Number.POSITIVE_INFINITY])
    .toArray()
  // Newest first — `between` returns ascending; reverse here so the dropdown
  // and any other consumers don't need to sort again.
  return rows.sort((a, b) => b.createdAt - a.createdAt)
}

export async function saveBookmark(
  workflowId: string,
  name: string,
  viewport: Viewport
): Promise<WorkflowViewportBookmarkRow> {
  if (!workflowId) throw new Error("saveBookmark: workflowId is required")
  const trimmed = name.trim()
  const row: WorkflowViewportBookmarkRow = {
    id: ID_PREFIX + nanoid(8),
    workflowId,
    name: trimmed.length > 0 ? trimmed : "Untitled view",
    viewport,
    createdAt: Date.now(),
  }
  await getDb().workflowViewportBookmarks.put(row)
  return row
}

export async function deleteBookmark(id: string): Promise<void> {
  await getDb().workflowViewportBookmarks.delete(id)
}

export async function renameBookmark(id: string, name: string): Promise<void> {
  const trimmed = name.trim()
  if (trimmed.length === 0) return
  await getDb().workflowViewportBookmarks.update(id, { name: trimmed })
}
