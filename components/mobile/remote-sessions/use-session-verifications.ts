"use client"

/**
 * Verification (test) results for one remote session.
 *
 * Unlike Changes, this needs no RPC. Verification artifacts live on
 * `ExecutionRun.latestSnapshot.artifacts`, and `executionRuns` is one of the
 * tables `lib/sync/handlers/execution-runs.ts` mirrors to this device — so the
 * counts are already here, offline included.
 *
 * The snapshot is also the ONLY place they could come from on a phone: the
 * `artifact.created` journal events are not synced. That is why the empty case
 * is split in two below. "No run for this session has reached this device" and
 * "runs are here and none recorded a verification" look identical in the data
 * and mean opposite things, and reporting the first as the second would tell
 * someone their tests reported nothing when in fact nothing was ever asked.
 */

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { listExecutionRuns } from "@/lib/db/execution-runs"
import { projectRunDetail, type VerificationArtifact } from "@/lib/execution/run-detail-model"
import type { ExecutionRunStatus } from "@/types/execution/run"

/** How many of the session's runs are inspected for verification artifacts. */
export const SESSION_VERIFICATION_RUN_LIMIT = 20

export interface SessionVerificationRun {
  runId: string
  title: string
  status: ExecutionRunStatus
  updatedAt: number
  endedAt?: number
  verifications: readonly VerificationArtifact[]
}

export interface SessionVerificationsState {
  loading: boolean
  /** No run for this session has reached this device yet. */
  noRuns: boolean
  /** Runs are present; none of them recorded a verification. */
  runs: SessionVerificationRun[]
}

export function useSessionVerifications(sessionId: string): SessionVerificationsState {
  const rows = useLiveQuery(
    () => listExecutionRuns({ sessionId, limit: SESSION_VERIFICATION_RUN_LIMIT }),
    [sessionId]
  )

  return useMemo(() => {
    if (rows === undefined) return { loading: true, noRuns: false, runs: [] }
    const runs = rows
      .map((run) => {
        // Events are deliberately empty: `projectRunDetail` reads changes from
        // the journal and verifications from the snapshot, and only the second
        // half is available off the owning machine.
        const { verifications } = projectRunDetail(run.latestSnapshot, [])
        return {
          runId: run.id,
          title: run.latestSnapshot?.title || run.title,
          status: run.status,
          updatedAt: run.updatedAt,
          ...(run.endedAt ? { endedAt: run.endedAt } : {}),
          verifications,
        }
      })
      .filter((run) => run.verifications.length > 0)
    return { loading: false, noRuns: rows.length === 0, runs }
  }, [rows])
}
