/**
 * Cross-device workflow-run cancellation (ADR 0061 P4) — the single cancel
 * entry every remote surface shares (companion `workflow_cancel_run`,
 * remote-control `workflow.cancel`).
 *
 * Resolution ladder:
 *  1. **Local abort** — the run executes in THIS process
 *     (`run-cancel-registry`): abort it and let the orchestrator finalise.
 *  2. **Lease signal** — another live executor holds the run's lease:
 *     stamp `cancelRequestedAt`; the owner's lease heartbeat observes it
 *     and aborts on its side within one beat.
 *  3. **Soft cancel** — nobody is driving the run (stale mirror, crashed
 *     executor with an expired lease): mark the row cancelled and fan the
 *     terminal state out to companions. The orchestrator's pre-put
 *     terminal guard keeps a later resume replay from resurrecting it.
 */

import { getDb } from "@/lib/db/schema"
import { trackEvent } from "@/lib/telemetry/events/track-event"
import { requestCancelRun } from "./run-cancel-registry"
import { getExecutorId } from "./run-lease"
import { notifyCompanionsOfRunState } from "./companion-run-events"

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled"])

export type CancelRunMode = "aborted" | "lease-signalled" | "soft-cancelled" | "noop"

export interface CancelRunResult {
  cancelled: boolean
  /** True when the run was aborted live in this process. */
  live: boolean
  mode: CancelRunMode
}

export async function cancelWorkflowRun(runId: string, reason: string): Promise<CancelRunResult> {
  // 1. Local abort.
  if (requestCancelRun(runId, reason)) {
    void trackEvent("workflow.run.cancelled", { runId })
    return { cancelled: true, live: true, mode: "aborted" }
  }

  const db = getDb()
  const row = await db.workflowRuns.get(runId)
  if (!row || TERMINAL_RUN_STATUSES.has(row.status)) {
    return { cancelled: false, live: false, mode: "noop" }
  }

  // 2. Lease signal — a live executor elsewhere owns this run.
  const now = Date.now()
  if (row.lease && row.lease.expiresAt > now && row.lease.ownerId !== getExecutorId()) {
    await db.workflowRuns.update(runId, { cancelRequestedAt: now })
    void trackEvent("workflow.run.cancelled", { runId })
    return { cancelled: true, live: false, mode: "lease-signalled" }
  }

  // 3. Soft cancel.
  await db.workflowRuns.update(runId, { status: "cancelled", completedAt: now })
  void trackEvent("workflow.run.cancelled", { runId })
  // Fan the terminal state out (sync invalidate + status frame + push
  // policy) — a direct Dexie write bypasses the persistRunState funnel.
  void notifyCompanionsOfRunState({ runId, workflowId: row.workflowId, status: "cancelled" })
  return { cancelled: true, live: false, mode: "soft-cancelled" }
}
