/**
 * Workflow audit log helpers.
 *
 * The `workflowAudit` table (schema v30) records coarse-grained workflow
 * transitions: run started / completed / failed / cancelled, step failures,
 * and trigger dispatch / rejection. It is intentionally distinct from
 * `workflowRunEvents` (the durable per-step timeline) and `mcpAuditLog`
 * (MCP server / external bridge audit). The Audit Tab live-queries this
 * table and the ZIP / Markdown exporter (M4) reads from it.
 *
 * Persistence is best-effort: writers wrap the put in try/catch so a
 * Dexie error never bubbles into the orchestrator and kills a run.
 */

import { getDb } from "./schema"
import type { WorkflowAuditEntry } from "@/types/workflow/visual"

/** Cap for the audit table — same convention as connectorAudit / mcpAuditLog. */
const WORKFLOW_AUDIT_CAP = 5000

export interface RecordWorkflowAuditInput {
  workflowId?: string
  runId?: string
  ts?: number
  kind: WorkflowAuditEntry["kind"]
  source: WorkflowAuditEntry["source"]
  triggerKind?: WorkflowAuditEntry["triggerKind"]
  stepId?: string
  reason?: string
  payload?: Record<string, unknown>
}

/**
 * Append a single audit row. Returns the inserted entry (with `id` filled in)
 * or `null` if persistence failed. Never throws.
 */
export async function recordWorkflowAudit(
  input: RecordWorkflowAuditInput
): Promise<WorkflowAuditEntry | null> {
  const row: WorkflowAuditEntry = {
    workflowId: input.workflowId,
    runId: input.runId,
    ts: input.ts ?? Date.now(),
    kind: input.kind,
    source: input.source,
    triggerKind: input.triggerKind,
    stepId: input.stepId,
    reason: input.reason,
    payload: input.payload,
  }
  try {
    const id = await getDb().workflowAudit.put(row)
    const persisted: WorkflowAuditEntry = {
      ...row,
      id: typeof id === "number" ? id : row.id,
    }
    // Prune asynchronously so callers don't block on FIFO eviction.
    void pruneWorkflowAudit().catch(() => undefined)
    return persisted
  } catch {
    return null
  }
}

export interface ListWorkflowAuditFilter {
  workflowId?: string
  runId?: string
  kind?: WorkflowAuditEntry["kind"]
  source?: WorkflowAuditEntry["source"]
  /** Inclusive lower bound. */
  fromTs?: number
  /** Inclusive upper bound. */
  toTs?: number
  /** True keeps only `step_failed` / `run_failed` / `trigger_rejected` rows. */
  failedOnly?: boolean
  limit?: number
}

/**
 * Newest-first listing with simple post-filtering. The `[workflowId+ts]` and
 * `[runId+ts]` indices keep range scans cheap for the common drill-down cases.
 */
export async function listWorkflowAudit(
  filter: ListWorkflowAuditFilter = {}
): Promise<WorkflowAuditEntry[]> {
  const db = getDb()
  let collection
  if (filter.workflowId) {
    collection = db.workflowAudit
      .where("[workflowId+ts]")
      .between(
        [filter.workflowId, filter.fromTs ?? 0],
        [filter.workflowId, filter.toTs ?? Number.MAX_SAFE_INTEGER]
      )
  } else if (filter.runId) {
    collection = db.workflowAudit
      .where("[runId+ts]")
      .between(
        [filter.runId, filter.fromTs ?? 0],
        [filter.runId, filter.toTs ?? Number.MAX_SAFE_INTEGER]
      )
  } else if (filter.fromTs != null || filter.toTs != null) {
    collection = db.workflowAudit
      .where("ts")
      .between(filter.fromTs ?? 0, filter.toTs ?? Number.MAX_SAFE_INTEGER, true, true)
  } else {
    collection = db.workflowAudit.orderBy("ts")
  }

  let rows = await collection.reverse().toArray()
  if (filter.kind) rows = rows.filter((r) => r.kind === filter.kind)
  if (filter.source) rows = rows.filter((r) => r.source === filter.source)
  if (filter.failedOnly) {
    rows = rows.filter(
      (r) => r.kind === "step_failed" || r.kind === "run_failed" || r.kind === "trigger_rejected"
    )
  }
  if (filter.limit && filter.limit > 0) rows = rows.slice(0, filter.limit)
  return rows
}

/**
 * Cap the audit table at {@link WORKFLOW_AUDIT_CAP} rows. Deletes the oldest
 * overflow by `ts`. Idempotent. Safe to call concurrently — the worst case
 * is a few duplicate deletes that Dexie tolerates.
 */
export async function pruneWorkflowAudit(): Promise<number> {
  const db = getDb()
  const count = await db.workflowAudit.count()
  if (count <= WORKFLOW_AUDIT_CAP) return 0
  const overflow = count - WORKFLOW_AUDIT_CAP
  const oldest = await db.workflowAudit.orderBy("ts").limit(overflow).primaryKeys()
  if (oldest.length === 0) return 0
  await db.workflowAudit.bulkDelete(oldest as number[])
  return oldest.length
}

/** Test-only — wipe every audit row. */
export async function _clearWorkflowAudit(): Promise<void> {
  await getDb().workflowAudit.clear()
}
