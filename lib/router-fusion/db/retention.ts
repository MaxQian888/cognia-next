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
 * - Delegate patch sets: past their own `expiresAt` (the artifact window),
 *   unless their run is still live — the same rule as the patch artifact they
 *   index, because they are the same content.
 * - Delegate step journals: in the run trail's transaction, with the run and
 *   never on a window of their own (REC-06).
 * - Routing samples and the shadow decisions annotating them: past their own
 *   `expiresAt` on the routing-sample window, which deliberately outlives the
 *   run trail — a sample is a text-free derived row a learned router trains
 *   from, and it is collected long after its run was reaped.
 * - The money ledger is never reaped: it is append-only by contract.
 * - Acceptance approvals are never reaped either: an approval is a person's
 *   decision about their own project, kept while the project exists and
 *   deleted with the database.
 * - Predictor manifests are never reaped on a window either: the active
 *   manifest and its rollback target must outlive any sweep, so
 *   `lib/router-fusion/eval/routing-store.ts` caps that history itself.
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
/** A delegate patch set is model-derived content: the artifact window (B4). */
export const PATCH_SET_TTL_MS = ttlMsOf("fusionPatchSets")
/** Routing samples and their shadow decisions share one window (B6). */
export const ROUTING_SAMPLE_TTL_MS = ttlMsOf("fusionRoutingSamples")

const OPEN_ATTEMPT_STATES: ReadonlySet<FusionAttemptState> = new Set([
  "PREPARED",
  "DISPATCHED",
  "UNKNOWN",
])

export interface FusionRetentionReport {
  artifacts: number
  /** Delegate patch sets past the artifact window whose run is no longer live. */
  patchSets: number
  /** Delegate step-journal rows, reaped with their run and never before it. */
  delegateSteps: number
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
  /** Routing samples past the routing-sample window. */
  routingSamples: number
  /** Shadow decisions past the same window, or whose sample is already gone. */
  shadowDecisions: number
  /** Terminal runs past the window that were kept because they still pin money or an effect. */
  runsKept: number
}

function emptyReport(): FusionRetentionReport {
  return {
    artifacts: 0,
    patchSets: 0,
    delegateSteps: 0,
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
    routingSamples: 0,
    shadowDecisions: 0,
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

/**
 * Delegate patch sets past their own window, unless the run that produced them
 * is still live. Same rule as artifact content, and the same reason: a live run
 * may still deliver the patch it staged.
 */
async function prunePatchSets(db: FusionDB, now: number): Promise<number> {
  const live = await liveRunIds(db)
  return db.fusionPatchSets
    .where("expiresAt")
    .belowOrEqual(now)
    .filter((patchSet) => !live.has(patchSet.runId))
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
      db.fusionDelegateSteps,
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
        // The step journal goes in the SAME transaction as the run, never on a
        // window of its own: a journal that outlived its run would keep
        // workspace-derived receipts with nothing to replay, and one that went
        // first would let a resume re-run an acceptance command or an apply
        // (REC-06).
        report.delegateSteps += await db.fusionDelegateSteps.where("runId").equals(runId).delete()
        await db.fusionRuns.delete(runId)
        report.runs += 1
      }
    }
  )
}

/**
 * Routing samples past their own window, and the shadow decisions that
 * annotate them. A shadow decision goes when its own window passed OR when the
 * sample it compares against is no longer there: a shadow verdict with nothing
 * to compare against is not a record, it is noise.
 */
async function pruneRoutingSamples(
  db: FusionDB,
  now: number,
  report: FusionRetentionReport
): Promise<void> {
  const expired = await db.fusionRoutingSamples.where("expiresAt").belowOrEqual(now).primaryKeys()
  const gone = new Set(expired)
  await db.fusionRoutingSamples.bulkDelete(expired)
  report.routingSamples = expired.length
  report.shadowDecisions = await db.fusionShadowDecisions
    .filter((shadow) => shadow.expiresAt <= now || gone.has(shadow.sampleId))
    .delete()
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
  report.patchSets = await prunePatchSets(db, now)
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
  await pruneRoutingSamples(db, now, report)
  return report
}
