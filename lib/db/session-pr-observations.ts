/**
 * Dexie accessor for project-thread PR observations (ADR-0204). The session
 * counterpart of `team-pr-observations.ts`: one row per thread conversation,
 * holding the observed {@link PrObservation} facts, the cached derived status
 * the threads board reads, and the reaction dedup ledger so a reload never
 * re-nudges for feedback already sent.
 *
 * Its own table rather than rows in `teamPrObservations`: team queries key on
 * `teamId`/`runId`, and a session row there would have to impersonate both.
 * Table declared in `lib/db/schema.ts` v233.
 */

import type { PrReactionSignature } from "@/lib/ai/agent/team/pr-feedback/reactions"
import type { PrDerivedStatus, PrObservation } from "@/lib/github/pr-observe/types"
import { getDb } from "./schema"

export interface SessionPrObservationRow {
  /** The thread's session id — a thread follows one PR at a time. */
  id: string
  sessionId: string
  projectId: string
  prUrl: string
  prNumber?: number
  branch: string
  /** "owner/name". */
  repo: string
  facts: PrObservation
  derivedStatus: PrDerivedStatus
  lastNudgeSignature: PrReactionSignature
  observedAt: number
  updatedAt: number
}

export async function recordSessionPrObservation(row: SessionPrObservationRow): Promise<void> {
  await getDb().sessionPrObservations.put(row)
}

export async function getSessionPrObservation(
  sessionId: string
): Promise<SessionPrObservationRow | undefined> {
  return getDb().sessionPrObservations.get(sessionId)
}

/** Every observed thread PR of a workspace, for the threads board. */
export async function listSessionPrObservationsByProject(
  projectId: string
): Promise<SessionPrObservationRow[]> {
  return getDb().sessionPrObservations.where("projectId").equals(projectId).toArray()
}

export async function deleteSessionPrObservation(sessionId: string): Promise<void> {
  await getDb().sessionPrObservations.delete(sessionId)
}
