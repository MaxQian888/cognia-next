/**
 * Fusion-database access for the routing experiment (ADR-0188 B6, fusion DB
 * v5): routing samples, sealed predictor manifests and shadow decisions.
 *
 * Three rules this module exists to keep:
 *
 *  - **Samples are idempotent.** A sample's id is derived from its run and its
 *    decision, so collecting the same run twice rewrites one row instead of
 *    growing the training set with duplicates of the same decision.
 *  - **Exactly one manifest is active.** Promotion is `activatePredictorManifest`
 *    and rollback is the same pointer moved back to the row the active one
 *    replaced; both run in one transaction, so no reader ever sees two active
 *    predictors or none where there was one.
 *  - **The manifest history is capped here, not by retention.** Reaping
 *    manifests on a window would eventually take away the rollback target of a
 *    live promotion, so the registry keeps the active row, the row it can roll
 *    back to, and the most recent `MANIFEST_HISTORY_CAP` rows, and deletes what
 *    falls out when a new manifest is sealed.
 */

import type { FusionDB } from "../db/fusion-db"
import { ROUTING_SAMPLE_TTL_MS } from "../db/retention"
import type {
  FusionPredictorManifestRow,
  FusionRoutingSampleRow,
  FusionShadowDecisionRow,
} from "../db/types"

/** Manifests kept beyond the active row and its rollback target. */
export const MANIFEST_HISTORY_CAP = 10

export class RoutingRegistryError extends Error {
  readonly code:
    | "MANIFEST_NOT_FOUND"
    | "NOT_PUBLISHED"
    | "NO_ACTIVE_MANIFEST"
    | "NO_ROLLBACK_TARGET"
    | "FEATURES_VERSION_MISMATCH"

  constructor(code: RoutingRegistryError["code"], message: string) {
    super(message)
    this.name = "RoutingRegistryError"
    this.code = code
  }
}

/** When a sample collected now falls out of the routing-sample window. */
export function routingSampleExpiry(now: number): number {
  return now + ROUTING_SAMPLE_TTL_MS
}

/** Write (or rewrite) collected samples. Idempotent on `sampleId`. */
export async function putRoutingSamples(
  db: FusionDB,
  rows: readonly FusionRoutingSampleRow[]
): Promise<number> {
  if (rows.length === 0) return 0
  await db.fusionRoutingSamples.bulkPut([...rows])
  return rows.length
}

export interface ListRoutingSamplesOptions {
  /** Only samples decided at or after this epoch millisecond. */
  since?: number
  /** Only samples of this encoding; a mixed set cannot be trained on. */
  featuresVersion?: string
  origin?: "recorded" | "simulated"
  limit?: number
}

/** Samples in `sampleId` order, so a training run is independent of read order. */
export async function listRoutingSamples(
  db: FusionDB,
  options: ListRoutingSamplesOptions = {}
): Promise<FusionRoutingSampleRow[]> {
  const collection =
    options.since === undefined
      ? db.fusionRoutingSamples.toCollection()
      : db.fusionRoutingSamples.where("decidedAt").aboveOrEqual(options.since)
  const rows = await collection
    .filter(
      (row) =>
        (options.featuresVersion === undefined ||
          row.featuresVersion === options.featuresVersion) &&
        (options.origin === undefined || row.origin === options.origin)
    )
    .toArray()
  rows.sort((left, right) => left.sampleId.localeCompare(right.sampleId))
  return options.limit === undefined ? rows : rows.slice(0, options.limit)
}

export async function countRoutingSamples(db: FusionDB): Promise<number> {
  return db.fusionRoutingSamples.count()
}

export interface SealManifestInput {
  manifestSha256: string
  kind: "training" | "published"
  featuresVersion: string
  manifest: Record<string, unknown>
  label: "live" | "simulated"
  gateVerdict: "pass" | "fail" | "inconclusive" | null
  gateReasons: readonly string[]
  now: number
}

/**
 * Record a sealed manifest without activating it. Re-sealing the same manifest
 * (same sha256) updates its gate verdict and leaves its activation alone.
 */
export async function sealPredictorManifest(
  db: FusionDB,
  input: SealManifestInput
): Promise<FusionPredictorManifestRow> {
  return db.transaction("rw", db.fusionPredictorManifests, async () => {
    const existing = await db.fusionPredictorManifests.get(input.manifestSha256)
    const row: FusionPredictorManifestRow = {
      manifestSha256: input.manifestSha256,
      kind: input.kind,
      active: existing?.active ?? 0,
      featuresVersion: input.featuresVersion,
      manifest: input.manifest,
      previousManifestSha256: existing?.previousManifestSha256 ?? null,
      gateVerdict: input.gateVerdict,
      gateReasons: [...input.gateReasons],
      label: input.label,
      activatedAt: existing?.activatedAt ?? null,
      deactivatedAt: existing?.deactivatedAt ?? null,
      createdAt: existing?.createdAt ?? input.now,
    }
    await db.fusionPredictorManifests.put(row)
    await capManifestHistory(db)
    return row
  })
}

/** Inside a `fusionPredictorManifests` transaction: drop what the cap no longer covers. */
async function capManifestHistory(db: FusionDB): Promise<void> {
  const rows = await db.fusionPredictorManifests.toArray()
  const active = rows.find((row) => row.active === 1)
  const keep = new Set<string>()
  if (active) {
    keep.add(active.manifestSha256)
    if (active.previousManifestSha256) keep.add(active.previousManifestSha256)
  }
  const byRecency = [...rows].sort(
    (left, right) =>
      right.createdAt - left.createdAt || left.manifestSha256.localeCompare(right.manifestSha256)
  )
  for (const row of byRecency.slice(0, MANIFEST_HISTORY_CAP)) keep.add(row.manifestSha256)
  const drop = rows.filter((row) => !keep.has(row.manifestSha256)).map((row) => row.manifestSha256)
  if (drop.length > 0) await db.fusionPredictorManifests.bulkDelete(drop)
}

/**
 * Promote one published manifest. The previously active row is deactivated and
 * remembered as the new one's rollback target, all in one transaction.
 */
export async function activatePredictorManifest(
  db: FusionDB,
  manifestSha256: string,
  options: { now: number; expectedFeaturesVersion?: string }
): Promise<FusionPredictorManifestRow> {
  return db.transaction("rw", db.fusionPredictorManifests, async () => {
    const target = await db.fusionPredictorManifests.get(manifestSha256)
    if (!target) {
      throw new RoutingRegistryError(
        "MANIFEST_NOT_FOUND",
        `no predictor manifest ${manifestSha256} in this account`
      )
    }
    if (target.kind !== "published") {
      throw new RoutingRegistryError(
        "NOT_PUBLISHED",
        "only a published manifest can be activated; a training manifest holds withheld heads"
      )
    }
    if (
      options.expectedFeaturesVersion !== undefined &&
      target.featuresVersion !== options.expectedFeaturesVersion
    ) {
      throw new RoutingRegistryError(
        "FEATURES_VERSION_MISMATCH",
        `manifest encodes ${target.featuresVersion}, this build encodes ${options.expectedFeaturesVersion}`
      )
    }
    const current = await db.fusionPredictorManifests.filter((row) => row.active === 1).toArray()
    for (const row of current) {
      if (row.manifestSha256 === manifestSha256) continue
      await db.fusionPredictorManifests.put({
        ...row,
        active: 0,
        deactivatedAt: options.now,
      })
    }
    const previous = current.find((row) => row.manifestSha256 !== manifestSha256)
    const activated: FusionPredictorManifestRow = {
      ...target,
      active: 1,
      // Keep the earlier rollback target when re-activating the same row, so a
      // rollback after an undo still points somewhere real.
      previousManifestSha256: previous?.manifestSha256 ?? target.previousManifestSha256,
      activatedAt: options.now,
      deactivatedAt: null,
    }
    await db.fusionPredictorManifests.put(activated)
    await capManifestHistory(db)
    return activated
  })
}

/**
 * Put the predictor back the way it was before the last promotion: one click,
 * one pointer move. Refuses when nothing is active, or when the active row
 * replaced nothing (the first promotion has no earlier manifest to restore —
 * deactivating instead is `deactivatePredictor`).
 */
export async function rollbackPredictorManifest(
  db: FusionDB,
  options: { now: number }
): Promise<FusionPredictorManifestRow> {
  const active = await activePredictorManifest(db)
  if (!active) {
    throw new RoutingRegistryError("NO_ACTIVE_MANIFEST", "no learned router is active")
  }
  if (!active.previousManifestSha256) {
    throw new RoutingRegistryError(
      "NO_ROLLBACK_TARGET",
      "the active manifest replaced no earlier one; turn the learned router off instead"
    )
  }
  return activatePredictorManifest(db, active.previousManifestSha256, { now: options.now })
}

/** Turn the learned router off without deleting anything. */
export async function deactivatePredictor(
  db: FusionDB,
  options: { now: number }
): Promise<FusionPredictorManifestRow | null> {
  return db.transaction("rw", db.fusionPredictorManifests, async () => {
    const rows = await db.fusionPredictorManifests.filter((row) => row.active === 1).toArray()
    let last: FusionPredictorManifestRow | null = null
    for (const row of rows) {
      last = { ...row, active: 0, deactivatedAt: options.now }
      await db.fusionPredictorManifests.put(last)
    }
    return last
  })
}

export async function activePredictorManifest(
  db: FusionDB
): Promise<FusionPredictorManifestRow | undefined> {
  const rows = await db.fusionPredictorManifests.filter((row) => row.active === 1).toArray()
  return rows[0]
}

export async function getPredictorManifest(
  db: FusionDB,
  manifestSha256: string
): Promise<FusionPredictorManifestRow | undefined> {
  return db.fusionPredictorManifests.get(manifestSha256)
}

/** Manifests newest first. */
export async function listPredictorManifests(
  db: FusionDB,
  options: { limit?: number } = {}
): Promise<FusionPredictorManifestRow[]> {
  const rows = await db.fusionPredictorManifests.toArray()
  rows.sort(
    (left, right) =>
      right.createdAt - left.createdAt || left.manifestSha256.localeCompare(right.manifestSha256)
  )
  return options.limit === undefined ? rows : rows.slice(0, options.limit)
}

/** Write shadow decisions. Idempotent on `shadowId` (one per sample per predictor). */
export async function putShadowDecisions(
  db: FusionDB,
  rows: readonly FusionShadowDecisionRow[]
): Promise<number> {
  if (rows.length === 0) return 0
  await db.fusionShadowDecisions.bulkPut([...rows])
  return rows.length
}

/** Shadow decisions newest first, optionally for one predictor. */
export async function listShadowDecisions(
  db: FusionDB,
  options: { manifestSha256?: string; limit?: number } = {}
): Promise<FusionShadowDecisionRow[]> {
  const collection =
    options.manifestSha256 === undefined
      ? db.fusionShadowDecisions.toCollection()
      : db.fusionShadowDecisions.where("manifestSha256").equals(options.manifestSha256)
  const rows = await collection.toArray()
  rows.sort(
    (left, right) => right.createdAt - left.createdAt || left.shadowId.localeCompare(right.shadowId)
  )
  return options.limit === undefined ? rows : rows.slice(0, options.limit)
}
