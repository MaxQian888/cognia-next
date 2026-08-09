/**
 * CRUD for the `unattendedExecAudit` table (schema v74).
 *
 * Durable audit trail for *unattended* terminal executions — workflow
 * terminal nodes (and, later, agent tools) running shell commands
 * headlessly under the `classifyCommand` consent-replacement policy
 * (`settings.terminal.allowUnattendedExecution`). Every execution AND
 * every policy block writes a row, so "what ran without a human watching,
 * and why" stays answerable after the fact.
 *
 * Append-only with a bounded retention sweep, mirroring
 * `lib/webhooks/audit.ts`.
 */

import { getDb } from "./schema"

const MAX_ROWS = 1000

export interface UnattendedExecAuditRow {
  id: string
  /** When the decision was made (ms epoch). */
  ts: number
  /** The shell command line that was executed or blocked. */
  command: string
  /** Safety-classifier verdict that drove the decision. */
  verdict: "allow" | "ask" | "deny"
  /** Classifier reason (dev-facing English). */
  reason: string
  /** True when the policy refused to run the command. */
  blocked: boolean
  /** Where the request came from. */
  source: "workflow" | "agent"
  /** Owning workflow run, when dispatched from a workflow node. */
  runId?: string
  /** Exit code, when the command ran to completion. */
  exitCode?: number | null
  /** Wall-clock duration, when the command ran. */
  durationMs?: number
}

/** Append an audit row. `id` + `ts` are generated unless supplied (tests). */
export async function appendUnattendedExecAudit(
  entry: Omit<UnattendedExecAuditRow, "id" | "ts"> & { id?: string; ts?: number }
): Promise<void> {
  const row: UnattendedExecAuditRow = {
    ...entry,
    id: entry.id ?? crypto.randomUUID(),
    ts: entry.ts ?? Date.now(),
  }
  await getDb().unattendedExecAudit.add(row)
  await pruneUnattendedExecAudit()
}

export interface ListUnattendedExecAuditOptions {
  limit?: number
  runId?: string
}

/** Newest-first list, optionally filtered by workflow run. */
export async function listUnattendedExecAudit(
  opts: ListUnattendedExecAuditOptions = {}
): Promise<UnattendedExecAuditRow[]> {
  let coll = getDb().unattendedExecAudit.orderBy("ts").reverse()
  if (opts.runId) {
    const runId = opts.runId
    coll = coll.filter((r) => r.runId === runId)
  }
  return coll.limit(opts.limit ?? 100).toArray()
}

/** Drop the oldest rows beyond `MAX_ROWS`. No-op under the cap. */
export async function pruneUnattendedExecAudit(): Promise<void> {
  const table = getDb().unattendedExecAudit
  const count = await table.count()
  if (count <= MAX_ROWS) return
  const excess = count - MAX_ROWS
  const oldest = await table.orderBy("ts").limit(excess).primaryKeys()
  await table.bulkDelete(oldest)
}
