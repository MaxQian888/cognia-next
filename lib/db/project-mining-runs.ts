/**
 * Storage for explicit history-backfill runs (Dexie v212).
 *
 * A run is bookkeeping: a lease, a keyset cursor, and three counters. The
 * mining itself is ordinary `project-mining` job rows, which is what keeps a
 * backfilled claim identical in provenance to a live-mined one.
 *
 * The lease is the SAME protocol `claimMemoryJob` uses, deliberately rather
 * than a second one: an owner, a TTL, and a heartbeat, with an expired lease
 * claimable by anyone. Two Tauri WebViews against one IndexedDB is the normal
 * case here, and a run parked forever because a tab was closed is the failure
 * that protocol already solves.
 */

import {
  PROJECT_MINING_RUN_LEASE_TTL_MS,
  canClaimProjectMiningRun,
  canTransitionProjectMiningRun,
  isTerminalProjectMiningRun,
} from "@cognia/memory/lifecycle/project-mining-run"
import type {
  ProjectMiningRun,
  ProjectMiningRunEstimateRow,
  ProjectMiningRunStatus,
} from "@/types/memory/governance"
import { getDb } from "./schema"

function newRunId(): string {
  return `pmr_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

export interface CreateProjectMiningRunInput {
  projectId: string
  estimate: ProjectMiningRunEstimateRow
  id?: string
  createdAt?: number
}

/**
 * Create a run in `preconsent`.
 *
 * Never in `queued`: the row exists so a person can see what the sweep would
 * cost before agreeing to it, and a constructor that could produce a running
 * sweep would make that guarantee depend on every call site.
 */
export async function createProjectMiningRun(
  input: CreateProjectMiningRunInput
): Promise<ProjectMiningRun> {
  const now = input.createdAt ?? Date.now()
  const row: ProjectMiningRun = {
    id: input.id ?? newRunId(),
    projectId: input.projectId,
    status: "preconsent",
    estimate: input.estimate,
    createdAt: now,
    updatedAt: now,
    sessionsScanned: 0,
    jobsEnqueued: 0,
    claimsProduced: 0,
  }
  await getDb().projectMiningRuns.add(row)
  return row
}

export async function getProjectMiningRun(id: string): Promise<ProjectMiningRun | undefined> {
  return getDb().projectMiningRuns.get(id)
}

/** Every run for a workspace, newest first. */
export async function listProjectMiningRuns(projectId: string): Promise<ProjectMiningRun[]> {
  if (!projectId) return []
  const rows = await getDb().projectMiningRuns.where("projectId").equals(projectId).toArray()
  return rows.sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * The run a workspace is currently mid-way through, if any.
 *
 * `preconsent` counts as active: it is a decision the user has not made yet,
 * and offering to start a second sweep on top of it would produce two runs
 * competing for the same cursor.
 */
export async function getActiveProjectMiningRun(
  projectId: string
): Promise<ProjectMiningRun | undefined> {
  const rows = await listProjectMiningRuns(projectId)
  return rows.find((row) => !isTerminalProjectMiningRun(row.status))
}

export class ProjectMiningRunTransitionError extends Error {
  constructor(
    readonly from: ProjectMiningRunStatus,
    readonly to: ProjectMiningRunStatus
  ) {
    super(`Cannot move a project mining run from ${from} to ${to}`)
    this.name = "ProjectMiningRunTransitionError"
  }
}

/**
 * Move a run to `next`, refusing an illegal transition.
 *
 * Refuses rather than clamps: a caller that thinks it can resume a cancelled
 * run has a bug, and silently succeeding would hide it behind a sweep that
 * never runs.
 */
export async function transitionProjectMiningRun(
  id: string,
  next: ProjectMiningRunStatus,
  patch: Partial<
    Pick<
      ProjectMiningRun,
      "errorCode" | "cursorCreatedAt" | "cursorSessionId" | "leaseOwner" | "leaseExpiresAt"
    >
  > = {},
  now: number = Date.now()
): Promise<ProjectMiningRun | undefined> {
  const db = getDb()
  return db.transaction("rw", db.projectMiningRuns, async () => {
    const row = await db.projectMiningRuns.get(id)
    if (!row) return undefined
    if (row.status === next) return row
    if (!canTransitionProjectMiningRun(row.status, next)) {
      throw new ProjectMiningRunTransitionError(row.status, next)
    }
    const updated: ProjectMiningRun = {
      ...row,
      ...patch,
      status: next,
      updatedAt: now,
      ...(next === "running" && !row.startedAt ? { startedAt: now } : {}),
      ...(isTerminalProjectMiningRun(next) ? { completedAt: now } : {}),
    }
    // A run that is no longer running must not keep a lease: another tab would
    // read "owned" and decline to pick it up on resume.
    if (next !== "running") {
      updated.leaseOwner = undefined
      updated.leaseExpiresAt = undefined
    }
    await db.projectMiningRuns.put(updated)
    return updated
  })
}

/**
 * Take (or renew) the lease on a queued run and move it to `running`.
 *
 * Returns undefined when another worker holds a live lease, which is the normal
 * outcome in the second of two open windows and is not an error.
 */
export async function claimProjectMiningRun(
  id: string,
  workerId: string,
  now: number = Date.now(),
  leaseTtlMs: number = PROJECT_MINING_RUN_LEASE_TTL_MS
): Promise<ProjectMiningRun | undefined> {
  const db = getDb()
  return db.transaction("rw", db.projectMiningRuns, async () => {
    const row = await db.projectMiningRuns.get(id)
    if (!row) return undefined
    if (row.status !== "queued" && row.status !== "running") return undefined
    if (!canClaimProjectMiningRun(row, workerId, now)) return undefined
    const claimed: ProjectMiningRun = {
      ...row,
      status: "running",
      startedAt: row.startedAt ?? now,
      leaseOwner: workerId,
      leaseExpiresAt: now + leaseTtlMs,
      heartbeatAt: now,
      updatedAt: now,
      errorCode: undefined,
    }
    await db.projectMiningRuns.put(claimed)
    return claimed
  })
}

/**
 * Advance the watermark and the counters after one cursor step.
 *
 * Advances on rows CHECKED, not on claims produced. A batch of sessions that
 * yields nothing still moves the cursor, because a watermark that only moved on
 * success would make an unproductive stretch of history an infinite loop.
 */
export async function advanceProjectMiningRun(
  id: string,
  step: {
    cursorCreatedAt: number
    cursorSessionId: string
    sessionsScanned: number
    jobsEnqueued: number
    claimsProduced?: number
  },
  now: number = Date.now(),
  leaseTtlMs: number = PROJECT_MINING_RUN_LEASE_TTL_MS
): Promise<ProjectMiningRun | undefined> {
  const db = getDb()
  return db.transaction("rw", db.projectMiningRuns, async () => {
    const row = await db.projectMiningRuns.get(id)
    if (!row || row.status !== "running") return undefined
    const updated: ProjectMiningRun = {
      ...row,
      cursorCreatedAt: step.cursorCreatedAt,
      cursorSessionId: step.cursorSessionId,
      sessionsScanned: row.sessionsScanned + step.sessionsScanned,
      jobsEnqueued: row.jobsEnqueued + step.jobsEnqueued,
      claimsProduced: row.claimsProduced + (step.claimsProduced ?? 0),
      // Every step is also a heartbeat: a long batch must not let the lease
      // lapse under a worker that is plainly still working.
      heartbeatAt: now,
      leaseExpiresAt: now + leaseTtlMs,
      updatedAt: now,
    }
    await db.projectMiningRuns.put(updated)
    return updated
  })
}

/** Record claims a finished mining job attributed to this run. */
export async function recordProjectMiningRunClaims(
  id: string,
  claims: number,
  now: number = Date.now()
): Promise<void> {
  if (claims <= 0) return
  const db = getDb()
  await db.transaction("rw", db.projectMiningRuns, async () => {
    const row = await db.projectMiningRuns.get(id)
    if (!row) return
    await db.projectMiningRuns.put({
      ...row,
      claimsProduced: row.claimsProduced + claims,
      updatedAt: now,
    })
  })
}

export async function deleteProjectMiningRun(id: string): Promise<void> {
  await getDb().projectMiningRuns.delete(id)
}
