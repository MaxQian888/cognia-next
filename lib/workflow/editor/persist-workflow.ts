/**
 * Persist the current editor store through the canonical Dexie write path,
 * then mark the store saved and re-validate. `replaceWorkflow` owns trigger
 * projection for every writer, so this helper must not register twice.
 *
 * Returns validation and publication outcomes so callers can surface their
 * own toast. Saves are never blocked on validation — a dirty draft is allowed
 * on disk.
 *
 * The issue count is computed synchronously from the exact snapshot being
 * written, never read from `validationByStepId`. That map is the Inspector's
 * debounced per-field cache: an edit made inside its window (or whose queued
 * revalidation was lost) left it describing params the node no longer had,
 * and a save toast built from it reported "1 unresolved issue" for a workflow
 * whose required field had just been filled in.
 */

import { replaceWorkflow } from "@/lib/db/workflows"
import type { EditorStore } from "@/lib/workflow/editor/store"
import { validateAllNodes } from "@/lib/workflow/nodes/validate-params"

export interface PersistEditorWorkflowResult {
  /** Nodes with at least one param error in the workflow that was written. */
  issueCount: number
  publicationInvalidated: boolean
}

export async function persistEditorWorkflow(
  store: EditorStore
): Promise<PersistEditorWorkflowResult> {
  // Fold any keystroke still inside the Inspector's revalidation window into
  // the live cache before snapshotting, so badges and the toast converge.
  store.getState().flushPendingRevalidation()
  const wf = store.getState().toWorkflow()
  const savedIssues = validateAllNodes(
    wf.nodes.map((node) => ({
      id: node.id,
      data: {
        kind: node.type,
        params: (node.data?.params as Record<string, unknown> | undefined) ?? {},
      },
    }))
  )
  const persisted = await replaceWorkflow(wf)
  store.getState().markSaved(persisted.workflow)
  // Re-sync the live caches with CURRENT data — the user may have kept typing
  // while the write was in flight, so this can differ from `savedIssues`.
  store.getState().revalidateAll()
  store.getState().recomputeDiagnostics()
  return {
    issueCount: Object.keys(savedIssues).length,
    publicationInvalidated: persisted.publicationInvalidated,
  }
}
