/**
 * Persist the current editor store through the canonical Dexie write path,
 * then mark the store saved and re-validate. `replaceWorkflow` owns trigger
 * projection for every writer, so this helper must not register twice.
 *
 * Returns the count of nodes with validation issues so callers can surface
 * their own toast. Saves are never blocked on validation — a dirty draft is
 * allowed on disk.
 */

import { replaceWorkflow } from "@/lib/db/workflows"
import type { EditorStore } from "@/lib/workflow/editor/store"

export async function persistEditorWorkflow(store: EditorStore): Promise<number> {
  const wf = store.getState().toWorkflow()
  await replaceWorkflow(wf)
  store.getState().markSaved()
  const issues = store.getState().revalidateAll()
  return Object.keys(issues).length
}
