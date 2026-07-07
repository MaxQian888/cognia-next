/**
 * Dexie accessor for Agent Team PR observations (ADR — team PR feedback loop).
 * One row per (team run, PR): the durable {@link PrObservation} facts, the
 * read-time-derived {@link PrDerivedStatus} (cached so the workspace UI can
 * liveQuery it without re-deriving), and the persisted reaction dedup ledger
 * ({@link PrReactionSignature}) so a reload never re-nudges for feedback already
 * sent. Display status is a cache of a derivation — the `facts` are the source
 * of truth.
 *
 * Table declared in `lib/db/schema.ts` v103.
 */

import type { PrReactionSignature } from "@/lib/ai/agent/team/pr-feedback/reactions"
import type { PrDerivedStatus, PrObservation } from "@/lib/github/pr-observe/types"
import { getDb } from "./schema"

export interface TeamPrObservationRow {
  /** `${runId}:${prUrl}` — one row per (run, PR). */
  id: string
  runId: string
  teamId: string
  teammateId: string
  taskId: string
  prUrl: string
  branch: string
  /** "owner/name". */
  repo: string
  /** Full observation snapshot (durable facts + carried ETags). */
  facts: PrObservation
  /** Cached read-time status derivation for the workspace UI. */
  derivedStatus: PrDerivedStatus
  /** Persisted reaction dedup ledger (restart-safe). */
  lastNudgeSignature: PrReactionSignature
  observedAt: number
  updatedAt: number
}

/** Deterministic row id for a (run, PR) pair. */
export function teamPrObservationId(runId: string, prUrl: string): string {
  return `${runId}:${prUrl}`
}

/** Insert or replace the observation row (idempotent by id). */
export async function recordTeamPrObservation(row: TeamPrObservationRow): Promise<void> {
  await getDb().teamPrObservations.put(row)
}

export async function getTeamPrObservation(id: string): Promise<TeamPrObservationRow | undefined> {
  return getDb().teamPrObservations.get(id)
}

/** Newest-first observations for a team (drives the workspace PR-status UI). */
export async function listTeamPrObservationsByTeam(
  teamId: string
): Promise<TeamPrObservationRow[]> {
  const rows = await getDb().teamPrObservations.where("teamId").equals(teamId).toArray()
  return rows.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Persist the reaction dedup ledger after a delivery (restart-safe dedup). */
export async function updateTeamPrNudgeSignature(
  id: string,
  lastNudgeSignature: PrReactionSignature,
  updatedAt: number
): Promise<void> {
  await getDb().teamPrObservations.update(id, { lastNudgeSignature, updatedAt })
}

/** Drop every observation for a finished run (called on run cleanup). */
export async function clearTeamPrObservationsForRun(runId: string): Promise<number> {
  return getDb().teamPrObservations.where("runId").equals(runId).delete()
}
