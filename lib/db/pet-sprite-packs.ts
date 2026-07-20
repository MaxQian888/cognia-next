import { isValidSpritePackId, type SpriteV2InstallPayload } from "@/lib/pet/sprite-v2/import"
import { getDb } from "./schema"

/** One installed Codex-compatible v2 sprite atlas and its manifest metadata. */
export interface PetSpritePackRow {
  /** Stable lowercase manifest id. */
  id: string
  /** Human-facing pack name. */
  displayName: string
  /** Human-facing pack description. */
  description: string
  /** Atlas contract discriminator; Cognia stores only v2 packs here. */
  spriteVersionNumber: 2
  /** Raw PNG or WebP 1536×2288 atlas. */
  spritesheet: Blob
  /** Persisted atlas byte count for storage accounting. */
  totalBytes: number
  /** Epoch milliseconds when the pack was installed. */
  createdAt: number
}

/** Installed packs, ordered oldest-first. */
export async function listPetSpritePacks(): Promise<PetSpritePackRow[]> {
  return getDb().petSpritePacks.orderBy("createdAt").toArray()
}

/** Get one installed pack, or undefined when absent. */
export async function getPetSpritePack(id: string): Promise<PetSpritePackRow | undefined> {
  return getDb().petSpritePacks.get(id)
}

/** Persist one previously validated v2 import without replacing an existing id. */
export async function addPetSpritePack(
  input: SpriteV2InstallPayload,
  createdAt = Date.now()
): Promise<PetSpritePackRow> {
  if (!isValidSpritePackId(input.id)) {
    throw new Error("Invalid pet sprite pack id")
  }
  if (input.spriteVersionNumber !== 2) {
    throw new Error("Pet sprite pack spriteVersionNumber must be 2")
  }
  const db = getDb()
  if (await db.petSpritePacks.get(input.id)) {
    throw new Error(`Pet sprite pack '${input.id}' is already installed`)
  }
  const row: PetSpritePackRow = {
    ...input,
    totalBytes: input.spritesheet.size,
    createdAt,
  }
  try {
    await db.petSpritePacks.add(row)
  } catch (error) {
    if (error instanceof Error && error.name === "ConstraintError") {
      throw new Error(`Pet sprite pack '${input.id}' is already installed`)
    }
    throw error
  }
  return row
}

/** Delete one pack. A missing id is intentionally a no-op. */
export async function deletePetSpritePack(id: string): Promise<void> {
  await getDb().petSpritePacks.delete(id)
}

/** Aggregate persisted atlas storage without loading blob payloads elsewhere. */
export async function getPetSpritePackStorageUsage(): Promise<{
  packs: number
  totalBytes: number
}> {
  const rows = await getDb().petSpritePacks.toArray()
  return {
    packs: rows.length,
    totalBytes: rows.reduce((sum, row) => sum + row.totalBytes, 0),
  }
}
