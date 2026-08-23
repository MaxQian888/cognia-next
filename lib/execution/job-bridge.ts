/**
 * Projects renderer background tasks onto the canonical run journal as
 * `kind: "job"`.
 *
 * Background subagent / plugin-agent / team-delegation runs have always had
 * their own Dexie table (`backgroundTasks`, keyed `&runId`) and their own id
 * space, with no link to `executionRuns`. The consequence was product-visible:
 * the unified execution monitor, which reads `listExecutionRuns`, could not
 * show them at all, so "what is running right now?" had a permanent blind spot.
 *
 * This bridge OWNS projection only. `BackgroundTaskRegistry` keeps owning
 * execution, cancellation, redispatch and retention — exactly as
 * `workflow-bridge` leaves `workflowRuns` authoritative. Nothing here writes
 * back to the source table.
 *
 * ## What deliberately does not cross
 *
 * `prompt`, `resultText` and `error` stay in the source row. The run journal is
 * projected into IM cards and remote surfaces, and those three are free text
 * straight from a user or a model. The title is the subagent's id, which is a
 * name the user chose from a registry — not free text.
 */

import Dexie, { type Subscription } from "dexie"
import { getDb } from "@/lib/db/schema"
import {
  createExecutionRun,
  getExecutionRun,
  runEventJournal,
  semanticRunEvent,
} from "@/lib/db/execution-runs"
import type { BackgroundTaskJournalRecord } from "@/lib/background-tasks/registry-core"
import type { ExecutionRunStatus } from "@/types/execution/run"

export function jobExecutionRunId(sourceRunId: string): string {
  return `execution:job:${sourceRunId}`
}

/**
 * `interrupted` maps to `cancelled`, not `failed`: the work did not go wrong,
 * its writer went away (a reload, a closed session, a teardown drain). Calling
 * that a failure would put a red row in front of the user for something they
 * did.
 */
function runStatusFor(status: BackgroundTaskJournalRecord["status"]): ExecutionRunStatus {
  switch (status) {
    case "running":
      return "running"
    case "done":
      return "completed"
    case "error":
      return "failed"
    case "interrupted":
      return "cancelled"
  }
}

const TERMINAL_EVENT = {
  completed: "run.completed",
  failed: "run.failed",
  cancelled: "run.cancelled",
} as const

/** Project one background-task row. Safe to call repeatedly with the same row. */
export async function syncJobExecutionRun(record: BackgroundTaskJournalRecord): Promise<void> {
  const runId = jobExecutionRunId(record.runId)
  const status = runStatusFor(record.status)
  const existing = await getExecutionRun(runId)

  if (!existing) {
    await createExecutionRun({
      id: runId,
      kind: "job",
      sourceId: record.runId,
      sessionId: record.sessionId,
      title: record.subagentId,
      status: "running",
      currentRevision: 0,
      startedAt: record.startedAt,
      updatedAt: record.startedAt,
    })
    await runEventJournal.append(
      runId,
      semanticRunEvent(
        "run.started",
        { jobKind: record.kind, safeTitle: true, title: record.subagentId },
        { ts: record.startedAt, sourceEventId: `job:${record.runId}:started` }
      )
    )
  }

  if (status === "running") return

  // The journal closes on a settled run, so a second settle is not an error to
  // report — it is the ordinary result of the live query re-emitting a row that
  // has not changed. `sourceEventId` makes the append idempotent.
  const current = existing ?? (await getExecutionRun(runId))
  if (current && ["completed", "failed", "cancelled"].includes(current.status)) return

  await runEventJournal
    .append(
      runId,
      semanticRunEvent(
        TERMINAL_EVENT[status as keyof typeof TERMINAL_EVENT],
        // No `resultText` / `error` — see the module docblock.
        { summary: status === "completed" ? "Background task completed" : undefined },
        {
          ts: record.settledAt ?? Date.now(),
          sourceEventId: `job:${record.runId}:${status}`,
        }
      )
    )
    .catch(() => undefined)
}

let subscription: Subscription | null = null

export function startJobExecutionBridge(): () => void {
  if (subscription) return stopJobExecutionBridge
  // `Dexie.liveQuery`, not a named `liveQuery` import: dexie's CJS build makes
  // `liveQuery` non-enumerable, so SWC's wildcard interop drops it the moment a
  // module also imports the `Dexie` default. See `lib/db/outbound-jobs.ts`.
  subscription = Dexie.liveQuery(async () =>
    // Renderer-host rows only. CLI-host rows belong to a different process's
    // journal and would project runs this app can neither show nor control.
    getDb().backgroundTasks.where("host").equals("renderer").toArray()
  ).subscribe({
    next(rows) {
      for (const row of rows) {
        void syncJobExecutionRun(row as BackgroundTaskJournalRecord).catch((error) => {
          console.error(`[job-execution-bridge] sync failed for run=${row.runId}`, error)
        })
      }
    },
    error(error) {
      console.error("[job-execution-bridge] subscription failed", error)
    },
  })
  return stopJobExecutionBridge
}

function stopJobExecutionBridge(): void {
  subscription?.unsubscribe()
  subscription = null
}

export function __resetJobExecutionBridgeForTesting(): void {
  stopJobExecutionBridge()
}
