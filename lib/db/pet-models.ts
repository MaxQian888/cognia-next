/**
 * CRUD layer for the pet Live2D model tables (schema v73).
 *
 * Imported and sample-downloaded Live2D models are stored as raw blobs so the
 * same code path works in the browser, the Tauri desktop shell, and the mobile
 * Capacitor shell (a future native fs backend can drop in behind this surface).
 * Two tables back a model:
 *   • `petModels`     — one metadata row per model (capabilities for the state
 *     mapper plus storage accounting).
 *   • `petModelFiles` — one blob row per model asset, keyed `${modelId}:${path}`.
 *
 * Modeled on the small data-module pattern in `lib/db/pet.ts` and
 * `lib/db/connector-attachments.ts`. The React layer reads model lists
 * reactively via `useLiveQuery` over `getDb().petModels`.
 */

import { getDb } from "./schema"
import type { Live2dMotionOverrides, Live2dTransform } from "@/types/pet"

/** Metadata row for one stored Live2D model. */
export interface PetModelRow {
  /** Collision-resistant id (`pm_<base36ts>_<rand>`) or an explicit override. */
  id: string
  /** Human-facing model name (derived from the folder/zip at import). */
  name: string
  /** Where the model came from — a user import or a downloaded sample. */
  source: "import" | "sample"
  /** For `source === "sample"`, the catalog id it was downloaded from. */
  sampleId?: string
  /** Relative path of the `.model3.json` / `.model.json` settings file. */
  settingsPath: string
  /** Motion group names declared by the model (drives state→motion mapping). */
  motionGroups: string[]
  /** Expression ids declared by the model (drives one-shot→expression mapping). */
  expressionIds: string[]
  /** Sum of all asset blob sizes in bytes (storage accounting). */
  totalBytes: number
  /** Epoch ms when the model was added. */
  createdAt: number
  /**
   * Per-model render transform (additive, non-indexed — absent on legacy rows;
   * normalized to defaults on read via `normalizeTransform`).
   */
  transform?: Live2dTransform
  /**
   * Per-model state→motion/expression overrides (additive, non-indexed —
   * absent = naming-convention mapping only).
   */
  motionOverrides?: Live2dMotionOverrides
}

/** Blob row for one Live2D model asset. */
export interface PetModelFileRow {
  /** Composite primary key: `${modelId}:${path}`. */
  id: string
  /** Owning model id (drives cascade-delete). */
  modelId: string
  /** Relative path within the model directory (matches manifest references). */
  path: string
  /** Raw asset bytes. */
  blob: Blob
  /** MIME type (best-effort; defaults to `application/octet-stream`). */
  mime: string
}

function newId(): string {
  return "pm_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

/** All stored models, ordered oldest-first by `createdAt`. */
export async function listPetModels(): Promise<PetModelRow[]> {
  return getDb().petModels.orderBy("createdAt").toArray()
}

/** Fetch a single model's metadata. Returns undefined if absent. */
export async function getPetModel(id: string): Promise<PetModelRow | undefined> {
  return getDb().petModels.get(id)
}

/**
 * Insert a model and its asset files in a single read-write transaction over
 * both tables. Generates the model id (unless an explicit `meta.id` is given)
 * and stamps `createdAt` (override via the `now` arg for deterministic tests).
 */
export async function addPetModel(
  meta: Omit<PetModelRow, "id" | "createdAt"> & { id?: string },
  files: Array<{ path: string; blob: Blob; mime?: string }>,
  now = Date.now()
): Promise<PetModelRow> {
  const db = getDb()
  const { id: explicitId, ...rest } = meta
  const id = explicitId ?? newId()
  const row: PetModelRow = { ...rest, id, createdAt: now }
  const fileRows: PetModelFileRow[] = files.map((f) => ({
    id: `${id}:${f.path}`,
    modelId: id,
    path: f.path,
    blob: f.blob,
    mime: f.mime ?? "application/octet-stream",
  }))
  await db.transaction("rw", db.petModels, db.petModelFiles, async () => {
    await db.petModels.put(row)
    if (fileRows.length > 0) await db.petModelFiles.bulkPut(fileRows)
  })
  return row
}

/**
 * Delete a model's metadata and every asset file it owns in one transaction.
 * A missing model id is a no-op (no throw — matches the read-miss convention).
 */
export async function deletePetModel(id: string): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.petModels, db.petModelFiles, async () => {
    await db.petModels.delete(id)
    await db.petModelFiles.where("modelId").equals(id).delete()
  })
}

/**
 * Patch the customization fields of a model row (shallow Dexie merge over
 * non-indexed fields — no schema version bump). A missing id is a no-op,
 * matching the read-miss convention.
 */
export async function updatePetModelCustomization(
  id: string,
  patch: { transform?: Live2dTransform; motionOverrides?: Live2dMotionOverrides }
): Promise<void> {
  await getDb().petModels.update(id, patch)
}

/** All asset blobs for a model as `{ path, blob }` pairs (empty if absent). */
export async function getPetModelEntries(id: string): Promise<Array<{ path: string; blob: Blob }>> {
  const rows = await getDb().petModelFiles.where("modelId").equals(id).toArray()
  return rows.map((r) => ({ path: r.path, blob: r.blob }))
}

/** Aggregate storage footprint: model count and summed declared `totalBytes`. */
export async function getPetModelStorageUsage(): Promise<{
  models: number
  totalBytes: number
}> {
  const rows = await getDb().petModels.toArray()
  return {
    models: rows.length,
    totalBytes: rows.reduce((sum, r) => sum + r.totalBytes, 0),
  }
}
