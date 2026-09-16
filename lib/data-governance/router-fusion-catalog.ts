/**
 * Governance for the Router + Fusion database (ADR-0188 D39).
 *
 * Router + Fusion keeps its ledger in its own IndexedDB beside each main
 * database (`<main database>-router-fusion-v1`), so its tables are not part of
 * `CORE_TABLE_NAMES` and the main schema never bumps for them. They still get
 * the same policy record every CogniaDB table carries. `router-fusion-catalog.
 * test.ts` holds this list equal to `FUSION_SCHEMA`, so a new fusion table
 * without a policy fails there.
 *
 * What the policies promise, and who keeps each promise:
 * - Deletion: every path that deletes a main database deletes the sibling
 *   (account deletion, runtime-target removal, the refused-layout reset,
 *   "clear all data"), via `lib/router-fusion/gate/database-name.ts`.
 * - Retention: `lib/router-fusion/db/retention.ts` reaps expired artifact
 *   content, the event journal of runs that ended more than the event window
 *   ago, and the run trail of runs that ended more than the run window ago,
 *   reading its windows from THIS catalog. It runs daily while a Router +
 *   Fusion surface is on; with every surface off nothing opens the database, so
 *   what is there stays until a surface is back on or the database is deleted.
 * - Backup: device-local. A ledger is a record of this device's spending, not
 *   portable user content; nothing in `BackupPayloadV3` carries it.
 * - Sync: none. Companions never read the fusion database directly.
 */

import type { DataRetentionPolicy, DataTableCatalogEntry } from "./table-catalog"

/** Days a finished run's trail (attempts, reservations, decision, outbox, the run itself) is kept. */
export const ROUTER_FUSION_RUN_TRAIL_DAYS = 30
/** Days committed model output (artifact content) is kept after it was written. */
export const ROUTER_FUSION_ARTIFACT_CONTENT_DAYS = 7
/**
 * Days a finished run's event journal can be replayed. The spec keeps an
 * `Idempotency-Key` for at least this long, and a client reconnecting after
 * that is told `410 EVENT_HISTORY_EXPIRED` and reads the run snapshot instead,
 * which stays until the run window ends.
 */
export const ROUTER_FUSION_EVENT_HISTORY_DAYS = 7
/**
 * Days an `Idempotency-Key` keeps pointing at the run it created. The spec
 * (§15.1) asks for at least seven: a client retrying a request within a week
 * replays its run rather than paying for a second one.
 */
export const ROUTER_FUSION_IDEMPOTENCY_DAYS = 7

const OWNER = "router-fusion"

const RUN_TRAIL: DataRetentionPolicy = {
  mode: "ttl",
  days: ROUTER_FUSION_RUN_TRAIL_DAYS,
  enforcement: "domain",
  reason:
    "Reaped by lib/router-fusion/db/retention.ts with the run, once the run is terminal, ended longer ago than the window, and holds no money or pending effect.",
}

function entry(
  name: string,
  shape: Pick<DataTableCatalogEntry, "role" | "retentionPolicy" | "expectedScale"> &
    Partial<Pick<DataTableCatalogEntry, "sensitivity" | "contentProtection">>
): DataTableCatalogEntry {
  return {
    name,
    owner: OWNER,
    role: shape.role,
    sensitivity: shape.sensitivity ?? "internal",
    contentProtection: shape.contentProtection ?? "metadata-only",
    accountScope: "runtime-target",
    backupPolicy: {
      mode: "device-local",
      reason: "This device's Router + Fusion ledger; not portable user content.",
    },
    syncPolicy: {
      mode: "none",
      reason: "The fusion database is never exposed through the Companion data plane.",
    },
    retentionPolicy: shape.retentionPolicy,
    deleteCascade: {
      account: true,
      runtimeTarget: true,
      plugin: false,
      reason: "The whole fusion database is deleted with the main database it sits beside.",
    },
    storageCategory: "system",
    cleanupPolicy: "protected",
    expectedScale: shape.expectedScale,
    queryBudget: { hotReadMaxMs: 50, pageSize: 500 },
  }
}

export const ROUTER_FUSION_TABLE_CATALOG: readonly DataTableCatalogEntry[] = [
  entry("fusionAccount", {
    role: "authoritative",
    expectedScale: "small",
    retentionPolicy: {
      mode: "permanent",
      enforcement: "explicit-delete",
      reason: "One tenant row (active holds, revocations); deleted only with the database.",
    },
  }),
  entry("fusionRuns", {
    role: "authoritative",
    expectedScale: "large",
    retentionPolicy: RUN_TRAIL,
  }),
  entry("fusionRunEvents", {
    role: "audit",
    expectedScale: "very-large",
    retentionPolicy: {
      mode: "ttl",
      days: ROUTER_FUSION_EVENT_HISTORY_DAYS,
      enforcement: "domain",
      reason:
        "A finished run's journal is reaped by lib/router-fusion/db/retention.ts once the run ended longer ago than the window; the run snapshot outlives it, and a replay from before the gap answers 410 EVENT_HISTORY_EXPIRED.",
    },
  }),
  entry("fusionSessionLocks", {
    role: "queue",
    expectedScale: "small",
    retentionPolicy: {
      mode: "permanent",
      enforcement: "explicit-delete",
      reason:
        "A lock row lives only while its run holds the session; the terminal transaction or stale-lease recovery deletes it.",
    },
  }),
  entry("fusionRouteDecisions", {
    role: "audit",
    expectedScale: "large",
    retentionPolicy: RUN_TRAIL,
  }),
  entry("fusionReservations", {
    role: "authoritative",
    expectedScale: "large",
    retentionPolicy: RUN_TRAIL,
  }),
  entry("fusionCallAttempts", {
    role: "authoritative",
    expectedScale: "large",
    retentionPolicy: RUN_TRAIL,
  }),
  entry("fusionLedger", {
    role: "audit",
    expectedScale: "very-large",
    retentionPolicy: {
      mode: "permanent",
      enforcement: "explicit-delete",
      reason:
        "Append-only money record: corrections are new adjustment rows, never edits or deletions. Deleted only with the database.",
    },
  }),
  entry("fusionArtifacts", {
    role: "authoritative",
    sensitivity: "confidential",
    contentProtection: "encrypted-content",
    expectedScale: "large",
    retentionPolicy: {
      mode: "ttl",
      days: ROUTER_FUSION_ARTIFACT_CONTENT_DAYS,
      enforcement: "domain",
      reason:
        "Each row carries its own expiresAt; lib/router-fusion/db/retention.ts deletes it once passed.",
    },
  }),
  entry("fusionConfigSnapshots", {
    role: "audit",
    expectedScale: "small",
    retentionPolicy: {
      ...RUN_TRAIL,
      reason:
        "Reaped by lib/router-fusion/db/retention.ts once older than the window and no retained run was compiled from it.",
    },
  }),
  entry("fusionOutbox", {
    role: "queue",
    expectedScale: "large",
    retentionPolicy: {
      ...RUN_TRAIL,
      reason:
        "Applied and skipped effects go with their run; a pending effect keeps its run from being reaped until it is replayed.",
    },
  }),
  entry("fusionIdempotency", {
    role: "authoritative",
    expectedScale: "medium",
    retentionPolicy: {
      mode: "ttl",
      days: ROUTER_FUSION_IDEMPOTENCY_DAYS,
      enforcement: "domain",
      reason:
        "Each row carries its own expiresAt; lib/router-fusion/db/retention.ts deletes it once passed, after which the same key starts a new run.",
    },
  }),
  entry("fusionApiSessions", {
    role: "authoritative",
    expectedScale: "medium",
    retentionPolicy: {
      mode: "permanent",
      enforcement: "explicit-delete",
      reason:
        "One id per conversation a gateway key opened, kept while the conversation can be continued; deleted with the database, and an id whose session was deleted resolves to 404.",
    },
  }),
  entry("fusionToolOperations", {
    role: "audit",
    expectedScale: "large",
    retentionPolicy: {
      ...RUN_TRAIL,
      reason:
        "Tool receipts go with their run: reaped by lib/router-fusion/db/retention.ts together with the run trail; the text the model saw is an artifact with its own content window.",
    },
  }),
  entry("fusionFeedback", {
    role: "audit",
    expectedScale: "medium",
    retentionPolicy: {
      ...RUN_TRAIL,
      reason:
        "A caller's verdict is part of its run's trail and is reaped with it; the comment text is an artifact and expires on the artifact window.",
    },
  }),
]

const BY_NAME = new Map(ROUTER_FUSION_TABLE_CATALOG.map((row) => [row.name, row]))

/** The policy of one fusion table; undefined for a name this catalog does not govern. */
export function routerFusionTablePolicy(name: string): DataTableCatalogEntry | undefined {
  return BY_NAME.get(name)
}
