/**
 * The Router + Fusion database — separate from the account database (ADR-0188 D39).
 *
 * One IndexedDB per account database, named `<main database>-router-fusion-v1`,
 * so it follows account switches and runtime targets exactly as the main
 * database does, and deleting the main database's family deletes it too.
 * Created lazily: nothing opens it until a surface is switched on and a run is
 * created. The main `lib/db/schema.ts` version is never touched.
 *
 * Single-version schema in the same spirit as the main database: to change it,
 * edit `FUSION_SCHEMA` and bump `FUSION_DB_SCHEMA_VERSION`. There is no upgrade
 * chain; the fusion database holds a ledger that is rebuilt from nothing only by
 * losing history, so a bump must keep every existing store compatible.
 */

import Dexie, { type Table } from "dexie"

import { fusionDatabaseName } from "../gate/database-name"
import { RouterFusionInfrastructureError, toInfrastructureFault } from "../gate/faults"
import type {
  FusionAccountRow,
  FusionApiSessionRow,
  FusionArtifactRow,
  FusionCallAttemptRow,
  FusionConfigSnapshotRow,
  FusionFeedbackRow,
  FusionIdempotencyRow,
  FusionLedgerRow,
  FusionOutboxRow,
  FusionReservationRow,
  FusionRouteDecisionRow,
  FusionRunEventRow,
  FusionRunRow,
  FusionSessionLockRow,
  FusionToolOperationRow,
} from "./types"

export { FUSION_DB_SUFFIX, fusionDatabaseName, isFusionDatabaseName } from "../gate/database-name"

/**
 * v2 (ADR-0188 B2) adds `fusionIdempotency` and `fusionFeedback` for the Run
 * API, and an `actorKeyId` index on `fusionRuns` so a gateway key sees only its
 * own runs. v3 (B3) adds `fusionApiSessions`, the Run API's UUID for a
 * conversation, and `fusionToolOperations`, the receipts of the read-only tools
 * a panel may use. Every earlier store keeps its exact schema string, so an
 * existing database upgrades without touching a row.
 */
export const FUSION_DB_SCHEMA_VERSION = 3

export const FUSION_SCHEMA = {
  fusionAccount: "&id",
  fusionRuns: "&runId, sessionId, status, surface, actorKeyId, createdAt, [sessionId+createdAt]",
  fusionRunEvents: "[runId+seq], runId, createdAt",
  fusionSessionLocks: "&sessionId, runId",
  fusionRouteDecisions: "&decisionId, runId",
  fusionReservations: "&reservationId, runId, [runId+state], stageId, attemptId",
  fusionCallAttempts: "&attemptId, runId, [runId+logicalStepId], [runId+state], state, createdAt",
  fusionLedger: "&dedupeKey, runId, attemptId, kind, createdAt",
  fusionArtifacts: "&artifactId, runId, contentSha256, expiresAt",
  fusionConfigSnapshots: "&digest, createdAt",
  fusionOutbox: "&effectId, runId, kind, status, createdAt",
  fusionIdempotency: "&scopedKey, runId, expiresAt",
  fusionFeedback: "&feedbackId, runId, createdAt",
  fusionApiSessions: "&apiSessionId, sessionId, actorKeyId",
  fusionToolOperations: "&operationId, runId, [runId+logicalStepId], createdAt",
} as const

export const FUSION_TABLE_NAMES = Object.keys(FUSION_SCHEMA) as Array<keyof typeof FUSION_SCHEMA>

export class FusionDB extends Dexie {
  fusionAccount!: Table<FusionAccountRow, string>
  fusionRuns!: Table<FusionRunRow, string>
  fusionRunEvents!: Table<FusionRunEventRow, [string, number]>
  fusionSessionLocks!: Table<FusionSessionLockRow, string>
  fusionRouteDecisions!: Table<FusionRouteDecisionRow, string>
  fusionReservations!: Table<FusionReservationRow, string>
  fusionCallAttempts!: Table<FusionCallAttemptRow, string>
  fusionLedger!: Table<FusionLedgerRow, string>
  fusionArtifacts!: Table<FusionArtifactRow, string>
  fusionConfigSnapshots!: Table<FusionConfigSnapshotRow, string>
  fusionOutbox!: Table<FusionOutboxRow, string>
  fusionIdempotency!: Table<FusionIdempotencyRow, string>
  fusionFeedback!: Table<FusionFeedbackRow, string>
  fusionApiSessions!: Table<FusionApiSessionRow, string>
  fusionToolOperations!: Table<FusionToolOperationRow, string>

  constructor(name: string) {
    super(name)
    this.version(FUSION_DB_SCHEMA_VERSION).stores(FUSION_SCHEMA)
    // Another context needs to upgrade: step aside instead of blocking it.
    this.on("versionchange", () => {
      this.close()
      if (cached?.db === this) cached = null
    })
  }
}

let cached: { mainName: string; db: FusionDB } | null = null

/**
 * The fusion database for the given main database. Switching accounts or
 * runtime targets changes the main name, which closes the previous instance.
 */
export function getFusionDb(mainDatabaseName: string): FusionDB {
  if (cached && cached.mainName === mainDatabaseName) return cached.db
  if (cached) cached.db.close()
  const db = new FusionDB(fusionDatabaseName(mainDatabaseName))
  cached = { mainName: mainDatabaseName, db }
  return db
}

/** Open (or confirm open) and turn any failure into an infrastructure fault. */
export async function openFusionDb(mainDatabaseName: string): Promise<FusionDB> {
  const db = getFusionDb(mainDatabaseName)
  if (db.isOpen()) return db
  try {
    await db.open()
    return db
  } catch (error) {
    if (cached?.db === db) cached = null
    const fault = toInfrastructureFault(error)
    throw fault?.code === "internal"
      ? new RouterFusionInfrastructureError("db_unavailable", fault.message, error)
      : (fault ?? error)
  }
}

export function closeFusionDb(): void {
  cached?.db.close()
  cached = null
}

export function __resetFusionDbForTesting(): void {
  closeFusionDb()
}
