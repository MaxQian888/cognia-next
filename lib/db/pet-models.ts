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
import type { Live2dMotionOverrides, Live2dParameterMapping, Live2dTransform } from "@/types/pet"
import type { Live2dCompatibilitySummary } from "@/lib/pet/live2d/types"
import { validateLive2dImport } from "@/lib/pet/live2d/import-validate"
import type { PetModelRow } from "@cognia/plugin-contract/lib/db/pet-models"
export type { PetModelRow } from "@cognia/plugin-contract/lib/db/pet-models"

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
  const row = await getDb().petModels.get(id)
  if (!row || row.compatibility?.version === 1) return row
  return revalidatePetModelCompatibility(id)
}

/** Lazily upgrade a legacy row's non-indexed compatibility summary once. */
export async function revalidatePetModelCompatibility(
  id: string
): Promise<PetModelRow | undefined> {
  const db = getDb()
  const row = await db.petModels.get(id)
  if (!row || row.compatibility?.version === 1) return row
  const files = await db.petModelFiles.where("modelId").equals(id).toArray()
  const result = await validateLive2dImport(
    files.map((file) => ({ path: file.path, blob: file.blob }))
  )
  if (!result.ok) {
    const compatibility: Live2dCompatibilitySummary = {
      version: 1,
      status: "invalid",
      diagnostics: [
        {
          code: result.code,
          severity: "error",
          ...(result.detail ? { path: result.detail } : {}),
        },
      ],
      usableMotionGroups: [],
      usableExpressionIds: [],
      usableParameterIds: [],
      resourceCost: {
        totalBytes: row.totalBytes,
        fileCount: files.length,
        textureBytes: 0,
      },
    }
    await db.petModels.update(id, { compatibility })
    return { ...row, compatibility }
  }

  const { manifest, compatibility, entries } = result.model
  await db.transaction("rw", db.petModels, db.petModelFiles, async () => {
    await db.petModels.update(id, {
      compatibility,
      motionGroups: manifest.motionGroups,
      expressionIds: manifest.expressionIds,
      totalBytes: result.model.totalBytes,
    })
    const settings = entries.find((entry) => entry.path === manifest.settingsPath)
    if (settings) {
      await db.petModelFiles.update(`${id}:${manifest.settingsPath}`, {
        blob: settings.blob,
        mime: "application/json",
      })
    }
  })
  return {
    ...row,
    compatibility,
    motionGroups: manifest.motionGroups,
    expressionIds: manifest.expressionIds,
    totalBytes: result.model.totalBytes,
  }
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
  await db.transaction(
    "rw",
    db.petModels,
    db.petModelFiles,
    db.settings,
    db.petCharacterBindings,
    async () => {
      const settings = await db.settings.get("singleton")
      if (settings?.petSettings?.activeLive2dModelId === id) {
        await db.settings.put({
          ...settings,
          updatedAt: Date.now(),
          petSettings: {
            ...settings.petSettings,
            skinId: "svg",
            activeLive2dModelId: undefined,
          },
        })
      }
      const bindings = await db.petCharacterBindings.toArray()
      for (const binding of bindings) {
        const legacyMatch = binding.live2dModelId === id
        const typedMatch = binding.skin?.skinId === "live2d" && binding.skin.modelId === id
        if (!legacyMatch && !typedMatch) continue
        await db.petCharacterBindings.put({
          ...binding,
          live2dModelId: undefined,
          skin: typedMatch ? undefined : binding.skin,
          updatedAt: new Date().toISOString(),
        })
      }
      await db.petModels.delete(id)
      await db.petModelFiles.where("modelId").equals(id).delete()
    }
  )
  const { invalidatePetSkinAsset } = await import("@/lib/pet/skin-assets")
  invalidatePetSkinAsset({ skinId: "live2d", modelId: id })
}

/**
 * Patch the customization fields of a model row (shallow Dexie merge over
 * non-indexed fields — no schema version bump). A missing id is a no-op,
 * matching the read-miss convention.
 */
export async function updatePetModelCustomization(
  id: string,
  patch: {
    transform?: Live2dTransform
    motionOverrides?: Live2dMotionOverrides
    parameterMapping?: Live2dParameterMapping
  }
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
