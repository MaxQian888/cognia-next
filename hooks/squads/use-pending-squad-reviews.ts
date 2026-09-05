"use client"

/**
 * The Squad reviews currently waiting on a person, read from the durable
 * interrupt table (ADR-0169).
 *
 * This replaces every read of `usePendingGatesStore` that used to answer "is
 * this Squad waiting on me?". That store was a per-tab mirror of an in-memory
 * bus, so a reload emptied it and a phone never saw it. `executionRunInterrupts`
 * is the record the control plane writes and every surface syncs, which is
 * what makes the fleet's "waiting" badge, the composer's Squad chip and the
 * context panel agree with the cockpit's Approvals tab.
 *
 * Shape is the `SquadPresenceGate` subset `collectSquadPresence` reads, plus
 * the ids a surface needs to deep-link to the run.
 */

import { getDb } from "@/lib/db/schema"
import { useClientLiveQuery } from "@/hooks/data"
import type { ExecutionRunInterrupt, SquadReviewKind } from "@/types/execution/run"

export interface PendingSquadReview {
  interruptId: string
  /** The execution run id (`execution:team:<runId>`). */
  executionRunId: string
  /** The durable Squad run id. */
  runId: string
  teamId: string
  kind: SquadReviewKind
  createdAt: number
  expiresAt: number
  /** Always `"open"`: a durable row is answerable from wherever it is read. */
  status: "open"
}

const EXECUTION_PREFIX = "execution:team:"

export function squadRunIdFromExecutionRunId(executionRunId: string): string | undefined {
  return executionRunId.startsWith(EXECUTION_PREFIX)
    ? executionRunId.slice(EXECUTION_PREFIX.length)
    : undefined
}

/** Pure join, exported for tests and for non-React callers. */
export function projectPendingSquadReviews(
  interrupts: readonly ExecutionRunInterrupt[],
  teamIdByRunId: ReadonlyMap<string, string>
): PendingSquadReview[] {
  const out: PendingSquadReview[] = []
  for (const interrupt of interrupts) {
    if (interrupt.status !== "pending" || !interrupt.reviewKind) continue
    const runId = squadRunIdFromExecutionRunId(interrupt.runId)
    if (!runId) continue
    const teamId = teamIdByRunId.get(runId)
    if (!teamId) continue
    out.push({
      interruptId: interrupt.id,
      executionRunId: interrupt.runId,
      runId,
      teamId,
      kind: interrupt.reviewKind,
      createdAt: interrupt.createdAt,
      expiresAt: interrupt.expiresAt,
      status: "open",
    })
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

export async function listPendingSquadReviews(): Promise<PendingSquadReview[]> {
  const db = getDb()
  const pending = await db.executionRunInterrupts.where("status").equals("pending").toArray()
  const runIds = [
    ...new Set(
      pending
        .filter((row) => row.reviewKind)
        .map((row) => squadRunIdFromExecutionRunId(row.runId))
        .filter((id): id is string => Boolean(id))
    ),
  ]
  const runs = runIds.length > 0 ? await db.agentTeamRuns.bulkGet(runIds) : []
  const teamIdByRunId = new Map<string, string>()
  runs.forEach((run, index) => {
    const id = runIds[index]
    if (run && id) teamIdByRunId.set(id, run.teamId)
  })
  return projectPendingSquadReviews(pending, teamIdByRunId)
}

const EMPTY: PendingSquadReview[] = []

export function usePendingSquadReviews(): PendingSquadReview[] {
  const rows = useClientLiveQuery(
    async () => {
      try {
        return await listPendingSquadReviews()
      } catch {
        // A locked account has no database. Nothing is waiting that this
        // tab can answer.
        return EMPTY
      }
    },
    [],
    EMPTY
  )
  // Only an array is an answer. Anything else (a query still settling, a test
  // double answering another query's shape) reads as "nothing is waiting".
  return Array.isArray(rows) ? rows : EMPTY
}
