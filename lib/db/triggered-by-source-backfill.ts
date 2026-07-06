// v91 upgrade backfill: denormalise `triggeredBy.source` into the new
// top-level INDEXED `triggeredBySource` column on `workflowRuns`. Dexie cannot
// index a nested object property, so the IM progress-runner previously scanned
// the whole `workflowRuns` table and filtered `triggeredBy.source === "im"` in
// JS — every UI/API run woke that watcher. With this column it can query
// `.where("triggeredBySource").equals("im")` directly.
//
// Faithfulness: legacy rows with no `triggeredBy` are stamped "ui" (the
// manual/desktop origin), matching the run-creation default in
// `lib/workflow/runtime/orchestrator.ts`. Existing IM-triggered runs already
// carry `triggeredBy.source === "im"`, so they index correctly.
//
// Extracted from the inline `schema.ts` upgrade so the backfill is unit-testable
// in isolation. Operates purely on the passed Dexie transaction; never calls
// `getDb()`.

import type { Transaction } from "dexie"

export async function backfillTriggeredBySourceV91(tx: Transaction): Promise<void> {
  await tx
    .table("workflowRuns")
    .toCollection()
    .modify((row: Record<string, unknown>) => {
      if (row.triggeredBySource !== undefined) return
      const triggeredBy = row.triggeredBy as { source?: string } | undefined
      row.triggeredBySource = triggeredBy?.source ?? "ui"
    })
}
