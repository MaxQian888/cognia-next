/**
 * CRUD for the `remoteControlRunStatus` Dexie table (schema v92).
 *
 * Closes the result loop for the inbound `/api/v1/commands/:target` surface.
 * The HTTP caller gets a `202` + `runId` immediately; the renderer's dispatch
 * registry computes a `RemoteCommandResult` that previously only reached the
 * audit log. This projection mirrors that outcome (and, for terminal-aware
 * subsystems, the final status) keyed by `runId`, so `GET /api/v1/runs/:runId`
 * can report it.
 *
 * Workflow runs are a special case: `startWorkflowFromRemote` threads the same
 * server `runId` into `workflowRuns`, so the GET surface reads the durable
 * `workflowRuns` row directly (terminal status for free, survives restart) and
 * this projection is just the dispatch-time acknowledgement.
 */

import { getDb } from "./schema"
import type {
  RemoteCommandResultStatus,
  RemoteCommandTarget,
  RemoteControlRunStatusRow,
  RemoteControlRunStatusValue,
} from "@/types/remote-control"

/** Ring-buffer cap. The projection is observability, not a system of record. */
export const REMOTE_RUN_STATUS_MAX_ROWS = 2000

export interface RecordRunOutcomeInput {
  runId: string
  target: RemoteCommandTarget
  /** The dispatch result status (`accepted` | `rejected` | `replayed`). */
  status: RemoteCommandResultStatus
  detail?: string
  /** Subsystem-internal id this run maps to (e.g. `goalId`). Optional. */
  correlationId?: string
  /** epoch ms; defaults to `Date.now()`. Injectable for tests. */
  now?: number
}

/**
 * Stamp the dispatch-time outcome of a command run. Idempotent on `runId`: a
 * replay overwrites the row (preserving the original `startedAt` and any
 * `correlationId` a later settle may have written).
 */
export async function recordRemoteRunOutcome(
  input: RecordRunOutcomeInput
): Promise<RemoteControlRunStatusRow> {
  const now = input.now ?? Date.now()
  const existing = await getDb().remoteControlRunStatus.get(input.runId)
  const correlationId = input.correlationId ?? existing?.correlationId
  const row: RemoteControlRunStatusRow = {
    runId: input.runId,
    target: input.target,
    status: input.status,
    detail: input.detail,
    ...(correlationId !== undefined ? { correlationId } : {}),
    startedAt: existing?.startedAt ?? now,
    updatedAt: now,
  }
  await getDb().remoteControlRunStatus.put(row)
  await pruneRemoteRunStatus()
  return row
}

/**
 * Attach the subsystem-internal id a remote run maps to (e.g. the `goalId`
 * returned by `createGoal`). No-op when no row exists for `runId` — the row is
 * always written by the receiver before a handler's settle resolves. Preserves
 * `startedAt`; bumps `updatedAt`.
 */
export async function setRemoteRunCorrelation(
  runId: string,
  correlationId: string,
  now: number = Date.now()
): Promise<void> {
  const existing = await getDb().remoteControlRunStatus.get(runId)
  if (!existing) return
  await getDb().remoteControlRunStatus.update(runId, { correlationId, updatedAt: now })
}

/**
 * Advance a run to a terminal (or `running`) status. No-op when no row exists
 * for `runId` — terminal signals only matter for runs we dispatched. Preserves
 * `startedAt`.
 */
export async function markRemoteRunStatus(
  runId: string,
  status: RemoteControlRunStatusValue,
  detail?: string,
  now: number = Date.now()
): Promise<void> {
  const existing = await getDb().remoteControlRunStatus.get(runId)
  if (!existing) return
  await getDb().remoteControlRunStatus.update(runId, {
    status,
    ...(detail !== undefined ? { detail } : {}),
    updatedAt: now,
  })
}

/** Read a single run's status projection, or undefined. */
export async function getRemoteRunStatus(
  runId: string
): Promise<RemoteControlRunStatusRow | undefined> {
  return getDb().remoteControlRunStatus.get(runId)
}

/** Most-recent-first list, capped. Used by diagnostics + tests. */
export async function listRemoteRunStatus(limit = 100): Promise<RemoteControlRunStatusRow[]> {
  return getDb().remoteControlRunStatus.orderBy("updatedAt").reverse().limit(limit).toArray()
}

/** Drop the oldest rows beyond the cap. No-op under the cap. */
export async function pruneRemoteRunStatus(): Promise<void> {
  const table = getDb().remoteControlRunStatus
  const total = await table.count()
  if (total <= REMOTE_RUN_STATUS_MAX_ROWS) return
  const overflow = total - REMOTE_RUN_STATUS_MAX_ROWS
  const oldest = await table.orderBy("updatedAt").limit(overflow).primaryKeys()
  await table.bulkDelete(oldest)
}
