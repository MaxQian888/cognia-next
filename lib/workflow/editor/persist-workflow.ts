/**
 * Persist the current editor store to Dexie + sync its triggers, then mark
 * the store saved and re-validate. Shared by the desktop canvas toolbar and
 * the mobile editor top bar so the save path lives in exactly one place.
 *
 * `syncWorkflowTriggers` is self-guarded (no-ops off Tauri), so this is safe
 * to call from the Capacitor mobile shell — the workflow definition still
 * persists locally; cron/webhook registration just no-ops.
 *
 * Returns the count of nodes with validation issues so callers can surface
 * their own toast. Saves are never blocked on validation — a dirty draft is
 * allowed on disk.
 */

import { replaceWorkflow } from "@/lib/db/workflows"
import { syncWorkflowTriggers } from "@/lib/workflow/runtime/webhook-bridge"
import type { EditorStore } from "@/lib/workflow/editor/store"

export async function persistEditorWorkflow(store: EditorStore): Promise<number> {
  const wf = store.getState().toWorkflow()
  await replaceWorkflow(wf)
  await syncWorkflowTriggers(wf).catch((err: unknown) => {
    console.warn("syncWorkflowTriggers failed:", err)
  })
  store.getState().markSaved()
  const issues = store.getState().revalidateAll()
  return Object.keys(issues).length
}
