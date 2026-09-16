/**
 * Router + Fusion retention (ADR-0188 D39).
 *
 * Every routed chat turn leaves a run, its events, call attempts, reservations,
 * route decision and outbox effects in the fusion database. Without a reaper
 * that trail grows with every turn forever. The windows are the ones
 * `lib/data-governance/router-fusion-catalog.ts` declares; this module is
 * what makes the declaration true.
 *
 * - Artifact content: rows past their own `expiresAt`, unless the run that
 *   wrote them is still live (a live run may replay committed output).
 * - Event journal: a terminal run that ended more than the event window ago
 *   loses its journal and keeps everything else. The Run API sees the gap and
 *   answers `410 EVENT_HISTORY_EXPIRED`, pointing the client at the snapshot,
 *   which is still readable until the run window ends.
 * - Run trail: a run that is terminal and ended more than the run window ago
 *   goes together with its events, attempts, reservations, decision and outbox
 *   rows — in one transaction per batch, re-checked inside it. A run is kept
 *   while it still pins money (a held or uncertain reservation, an attempt that
 *   is not final) or has an outbox effect not yet applied: late usage must
 *   still find its attempt, and a pending effect must still find its run.
 * - Idempotency keys: past their own `expiresAt`, after which the same key
 *   starts a new run rather than replaying a reaped one.
 * - Config snapshots: older than the window and compiled into no retained run.
 *   Checked in the same transaction scope run creation writes, so a run created
 *   from an old snapshot mid-sweep either keeps it or re-adds it.
 * - The money ledger is never reaped: it is append-only by contract.
 */

import { isActiveReservation, isTerminalRunStatus } from "@cognia/router-fusion"

import { routerFusionTablePolicy } from "@/lib/data-governance/router-fusion-catalog"

import type { FusionDB } from "./fusion-db"
import type { FusionAttemptState, FusionRunRow } from "./types"

const DAY_MS = 86_400_000
/** Runs deleted per transaction, so one sweep never holds the database for long. */
const RUN_BATCH = 100

/** The declared window of a fusion table; a table without a TTL policy is a catalog bug. */
function ttlMsOf(table: string): number {
  const days = routerFusionTablePolicy(table)?.retentionPolicy.days
  if (!days) throw new Error(`Router + Fusion table ${table} declares no retention window`)
  return days * DAY_MS
}

export const ARTIFACT_CONTENT_TTL_MS = ttlMsOf("fusionArtifacts")
export const EVENT_HISTORY_RETENTION_MS = ttlMsOf("fusionRunEvents")
export const RUN_TRAIL_RETENTION_MS = ttlMsOf("fusionRuns")
export const IDEMPOTENCY_TTL_MS = ttlMsOf("fusionIdempotency")

const OPEN_ATTEMPT_STATES: ReadonlySet<FusionAttemptState> = new Set([
  "PREPARED",
  "DISPATCHED",
  "UNKNOWN",
])

export interface FusionRetentionReport {
  artifacts: number
  runs: number
  runEvents: number
  callAttempts: number
  reservations: number
  routeDecisions: number
  outbox: number
  configSnapshots: number
  idempotencyKeys: number
  feedback: number
  toolOperations: number
  /** Terminal runs past the window that were kept because they still pin money or an effect. */
  runsKept: number
}

function emptyReport(): FusionRetentionReport {
  return {
    artifacts: 0,
    runs: 0,
    runEvents: 0,
    callAttempts: 0,
    reservations: 0,
    routeDecisions: 0,
    outbox: 0,
    configSnapshots: 0,
    idempotencyKeys: 0,
    feedback: 0,
    toolOperations: 0,
    runsKept: 0,
  }
}

function endedBefore(run: FusionRunRow, cutoff: number): boolean {
  return isTerminalRunStatus(run.status) && run.terminalAt !== null && run.terminalAt <= cutoff
}

async function liveRunIds(db: FusionDB): Promise<Set<string>> {
  const live = new Set<string>()
  await db.fusionRuns.each((run) => {
    if (!isTerminalRunStatus(run.status)) live.add(run.runId)
  })
  return live
}

async function pruneArtifacts(db: FusionDB, now: number): Promise<number> {
  const live = await liveRunIds(db)
  return db.fusionArtifacts
    .where("expiresAt")
    .belowOrEqual(now)
    .filter((artifact) => artifact.runId === null || !live.has(artifact.runId))
    .delete()
}

async function pruneRunBatch(
  db: FusionDB,
  runIds: readonly string[],
  cutoff: number,
  report: FusionRetentionReport
): Promise<void> {
  await db.transaction(
    "rw",
    [
      db.fusionRuns,
      db.fusionRunEvents,
      db.fusionCallAttempts,
      db.fusionReservations,
      db.fusionRouteDecisions,
      db.fusionOutbox,
      db.fusionSessionLocks,
      db.fusionFeedback,
      db.fusionToolOperations,
    ],
    async () => {
      for (const runId of runIds) {
        const run = await db.fusionRuns.get(runId)
        if (!run || !endedBefore(run, cutoff)) continue
        const openAttempts = await db.fusionCallAttempts
          .where("runId")
          .equals(runId)
          .filter((attempt) => OPEN_ATTEMPT_STATES.has(attempt.state))
          .count()
        const openReservations = await db.fusionReservations
          .where("runId")
          .equals(runId)
          .filter((reservation) => isActiveReservation(reservation.state))
          .count()
        const pendingEffects = await db.fusionOutbox
          .where("runId")
          .equals(runId)
          .filter((effect) => effect.status === "pending")
          .count()
        const locks = await db.fusionSessionLocks.where("runId").equals(runId).count()
        if (openAttempts + openReservations + pendingEffects + locks > 0) {
          report.runsKept += 1
          continue
        }
        report.runEvents += await db.fusionRunEvents.where("runId").equals(runId).delete()
        report.callAttempts += await db.fusionCallAttempts.where("runId").equals(runId).delete()
        report.reservations += await db.fusionReservations.where("runId").equals(runId).delete()
        report.routeDecisions += await db.fusionRouteDecisions.where("runId").equals(runId).delete()
        report.outbox += await db.fusionOutbox.where("runId").equals(runId).delete()
        report.feedback += await db.fusionFeedback.where("runId").equals(runId).delete()
        report.toolOperations += await db.fusionToolOperations.where("runId").equals(runId).delete()
        await db.fusionRuns.delete(runId)
        report.runs += 1
      }
    }
  )
}

async function pruneConfigSnapshots(db: FusionDB, cutoff: number): Promise<number> {
  return db.transaction("rw", [db.fusionRuns, db.fusionConfigSnapshots], async () => {
    const inUse = new Set<string>()
    await db.fusionRuns.each((run) => {
      inUse.add(run.configDigest)
    })
    return db.fusionConfigSnapshots
      .where("createdAt")
      .below(cutoff)
      .filter((snapshot) => !inUse.has(snapshot.digest))
      .delete()
  })
}

async function pruneExpiredJournals(db: FusionDB, now: number): Promise<number> {
  const cutoff = now - EVENT_HISTORY_RETENTION_MS
  const runIds = await db.fusionRuns
    .where("createdAt")
    .belowOrEqual(cutoff)
    .filter((run) => endedBefore(run, cutoff))
    .primaryKeys()
  let deleted = 0
  for (const runId of runIds) {
    deleted += await db.fusionRunEvents.where("runId").equals(runId).delete()
  }
  return deleted
}

/** Apply the fusion database's retention once. Safe to repeat; never touches the ledger. */
export async function pruneFusionDatabase(
  db: FusionDB,
  now: number
): Promise<FusionRetentionReport> {
  const report = emptyReport()
  report.artifacts = await pruneArtifacts(db, now)
  report.runEvents += await pruneExpiredJournals(db, now)

  const cutoff = now - RUN_TRAIL_RETENTION_MS
  // `createdAt <= terminalAt`, so every run that ended before the cutoff was
  // also created before it: the index narrows the scan, the filter decides.
  const candidates = await db.fusionRuns
    .where("createdAt")
    .belowOrEqual(cutoff)
    .filter((run) => endedBefore(run, cutoff))
    .primaryKeys()
  for (let start = 0; start < candidates.length; start += RUN_BATCH) {
    await pruneRunBatch(db, candidates.slice(start, start + RUN_BATCH), cutoff, report)
  }

  // An expired key stops replaying its run; a caller reusing it starts a new one.
  report.idempotencyKeys = await db.fusionIdempotency.where("expiresAt").belowOrEqual(now).delete()
  report.configSnapshots = await pruneConfigSnapshots(db, cutoff)
  return report
}
