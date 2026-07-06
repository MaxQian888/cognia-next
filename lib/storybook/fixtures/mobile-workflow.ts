// Fixture builders for the mobile workflow stories (library rows, run rows).
// Spread `over` to vary a single field; all required columns get realistic
// defaults so the row is valid to `bulkPut` into Dexie via `seedDb` or to pass
// as props. See `types/workflow/visual.ts` for the canonical shapes.
import {
  DEFAULT_WORKFLOW_SETTINGS,
  type RunStatus,
  type VisualWorkflow,
  type WorkflowNodeKind,
  type WorkflowRow,
  type WorkflowRunRow,
} from "@/types/workflow/visual"
import { ROOT_FOLDER_ID } from "@/types/workflow/folder"

let wfSeq = 0
let runSeq = 0

/** A minimal-but-valid `VisualWorkflow` / `WorkflowRow`. */
export function makeWorkflow(over: Partial<WorkflowRow> = {}): WorkflowRow {
  wfSeq += 1
  const now = 1_700_000_000_000 + wfSeq * 1000
  const base: VisualWorkflow = {
    id: `wf-${wfSeq}`,
    schemaVersion: 2,
    name: `Workflow ${wfSeq}`,
    description: "Automates a recurring task across your connected tools.",
    folderId: ROOT_FOLDER_ID,
    createdAt: now,
    updatedAt: now,
    nodes: [],
    edges: [],
    settings: { ...DEFAULT_WORKFLOW_SETTINGS },
  }
  return { ...base, ...over }
}

/** A complete `WorkflowRunRow` with a frozen snapshot. */
export function makeRun(over: Partial<WorkflowRunRow> = {}): WorkflowRunRow {
  runSeq += 1
  const startedAt = 1_700_000_000_000 + runSeq * 60_000
  const status: RunStatus = over.status ?? "succeeded"
  const triggerKind: WorkflowNodeKind = over.triggerKind ?? "trigger.manual"
  const snapshot = over.workflowSnapshot ?? makeWorkflow({ id: over.workflowId ?? `wf-${runSeq}` })
  const terminal = status === "succeeded" || status === "failed" || status === "cancelled"
  return {
    id: `run-${runSeq}`,
    workflowId: snapshot.id,
    status,
    triggerKind,
    triggerPayload: {},
    startedAt,
    completedAt: terminal ? startedAt + 4200 : undefined,
    workflowSnapshot: snapshot,
    ...over,
  }
}
