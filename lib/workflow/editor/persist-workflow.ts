/**
 * Persist the current editor store through the canonical Dexie write path,
 * then mark the store saved and re-validate. `replaceWorkflow` owns trigger
 * projection for every writer, so this helper must not register twice.
 *
 * Returns validation and publication outcomes so callers can surface their
 * own toast. Saves are never blocked on validation — a dirty draft is allowed
 * on disk.
 */

import { replaceWorkflow } from "@/lib/db/workflows"
import type { EditorStore } from "@/lib/workflow/editor/store"

export interface PersistEditorWorkflowResult {
  issueCount: number
  publicationInvalidated: boolean
}

export async function persistEditorWorkflow(
  store: EditorStore
): Promise<PersistEditorWorkflowResult> {
  const wf = store.getState().toWorkflow()
  const persisted = await replaceWorkflow(wf)
  store.getState().markSaved(persisted.workflow)
  const issues = store.getState().revalidateAll()
  return {
    issueCount: Object.keys(issues).length,
    publicationInvalidated: persisted.publicationInvalidated,
  }
}
