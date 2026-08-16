"use client"

import { useLiveQuery } from "dexie-react-hooks"

import { listWorkSubmissions, type WorkSubmissionRow } from "@/lib/db/work-submissions"

/**
 * What a session's durable work is doing right now (ADR-0123).
 *
 * Deliberately narrower than `WorkSubmissionRow.dispatchState`: the dispatch
 * ledger distinguishes `pending` from `claimed` from `dispatched`, which
 * matters to a runner and to nobody else. A person needs to know only whether
 * their turn is waiting on something, and whether it needs them.
 */
export type WorkSubmissionUiState =
  /** Nothing durable in flight — the ordinary case, and the flag-off case. */
  | "idle"
  /** Accepted and queued, but no runtime has taken it yet. */
  | "queued"
  /** The execution target is away; the turn is held rather than failed. */
  | "blocked"
  /** Replay was refused because a tool may already have run. Needs a human. */
  | "recoveryRequired"

export interface WorkSubmissionStatus {
  state: WorkSubmissionUiState
  /** The submission behind the state, when there is one. */
  submission?: WorkSubmissionRow
}

const IDLE: WorkSubmissionStatus = { state: "idle" }

/**
 * Map a stored row onto the state a person should see.
 *
 * `dispatched` reads as idle on purpose: once a runtime owns the turn, the
 * existing streaming UI is already telling the user what is happening, and a
 * second indicator alongside it would be noise rather than information.
 */
export function workSubmissionUiState(row: WorkSubmissionRow | undefined): WorkSubmissionStatus {
  if (!row) return IDLE
  if (row.dispatchState === "settled") {
    return row.terminalOutcome === "recovery_required"
      ? { state: "recoveryRequired", submission: row }
      : IDLE
  }
  if (row.dispatchState === "blocked") return { state: "blocked", submission: row }
  if (row.dispatchState === "dispatched") return IDLE
  return { state: "queued", submission: row }
}

/**
 * Live-read the newest work submission for a session.
 *
 * Returns `idle` while the feature is off, because no rows exist to read — the
 * hook needs no flag of its own, and the UI it drives simply never appears.
 */
export function useWorkSubmissionStatus(sessionId: string | undefined): WorkSubmissionStatus {
  const row = useLiveQuery(async () => {
    if (!sessionId) return undefined
    const [newest] = await listWorkSubmissions({ sessionId, limit: 1 })
    return newest
  }, [sessionId])

  return workSubmissionUiState(row)
}
