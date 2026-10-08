"use client"

/**
 * One Squad's most recent run, as the journal sees it, and what it cost.
 *
 * Two rows answer two halves of "how did the last run go". The execution run
 * (`executionRuns`, kind `team`) is the canonical projection every control and
 * every surface reads (ADR-0169): its status and `allowedActions` are what the
 * Start / Pause / Resume / Stop block acts on. The durable Squad run record
 * (`agentTeamRuns`) is the only place the run's objective and resource usage
 * (tokens, cost, wall time) are kept, keyed by the same run id without the
 * `execution:team:` prefix.
 *
 * This lived inline in the fleet inspector, which only needed the first half.
 * The Squad overview needs both, and the control hook needs the first, so the
 * query is written once and both read it.
 *
 * Errors read as "no run" rather than as a stuck loading state: a locked
 * account makes `getDb()` throw, and an unresolved live query would pin a
 * skeleton on screen for good.
 */

import { useClientLiveQuery } from "@/hooks/data"
import { squadRunIdFromExecutionRunId } from "@/hooks/squads/use-pending-squad-reviews"
import { getDb } from "@/lib/db/schema"
import type { AgentTeamRunRecord } from "@/types/agent/agent-team-runtime"
import type { ExecutionRun } from "@/types/execution/run"

export interface SquadLatestRun {
  /** The newest execution run for the Squad, or `null` when it has none. */
  run: ExecutionRun | null
  /** The durable record behind `run`, when this device carries it. */
  record: AgentTeamRunRecord | null
}

const NONE: SquadLatestRun = { run: null, record: null }

/** The read itself, exported so it can be tested without a live query. */
export async function readSquadLatestRun(squadId: string): Promise<SquadLatestRun> {
  try {
    const db = getDb()
    const rows = await db.executionRuns
      .where("kind")
      .equals("team")
      .filter((row) => row.latestSnapshot?.teamId === squadId)
      .sortBy("updatedAt")
    const run = rows.at(-1) ?? null
    if (!run) return NONE
    const recordId = squadRunIdFromExecutionRunId(run.id)
    const record = recordId ? ((await db.agentTeamRuns.get(recordId)) ?? null) : null
    return { run, record }
  } catch {
    return NONE
  }
}

export interface SquadLatestRunState extends SquadLatestRun {
  /** True until the first read lands. `run: null` means nothing before then. */
  loading: boolean
}

export function useSquadLatestRun(squadId: string | undefined): SquadLatestRunState {
  const result = useClientLiveQuery(
    async () => (squadId ? readSquadLatestRun(squadId) : NONE),
    [squadId],
    undefined
  )
  return result ? { ...result, loading: false } : { ...NONE, loading: true }
}
