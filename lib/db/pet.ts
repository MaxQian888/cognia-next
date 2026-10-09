// Dexie CRUD for the pet subsystem (v67). Dexie is the source of truth for the
// profile, per-character bindings, the activity ledger, and achievement unlocks;
// the React layer reads these reactively via `useLiveQuery`. Modeled on the
// small data-module pattern in `lib/db/shared-links.ts`.
//
// Needs decay is NOT applied here — this module stores/returns raw rows. Lazy
// decay is a pure function (`lib/pet/needs/decay.ts`) applied at the read site so
// storage stays a faithful record of the last settled values.

import type { Character } from "@cognia/agent-config-types"
import { getDb } from "./schema"
import { publishSyncInvalidate } from "@/lib/sync/host-invalidate"
import { recordTombstones } from "@/lib/sync/tombstones"
import type {
  PetAchievementRecord,
  PetActivityRow,
  PetCharacterBinding,
  PetInventoryRow,
  PetProfile,
} from "@/types/pet"

/** Newest-N kept in the ledger; older rows are pruned (never silently — see prune). */
export const PET_ACTIVITY_CAP = 2000

const GLOBAL_ID = "global" as const

// ── Profile ────────────────────────────────────────────────────────────────

export async function getPetProfile(): Promise<PetProfile | undefined> {
  return getDb().petProfile.get(GLOBAL_ID)
}

/** Insert or replace the singleton profile. */
export async function upsertPetProfile(profile: PetProfile): Promise<PetProfile> {
  await getDb().petProfile.put(profile)
  return profile
}

/** Shallow-merge a patch into the stored profile. Returns the merged row, or
 *  undefined if no profile exists yet. */
export async function patchPetProfile(
  patch: Partial<PetProfile>,
  now = Date.now()
): Promise<PetProfile | undefined> {
  const db = getDb()
  const cur = await db.petProfile.get(GLOBAL_ID)
  if (!cur) return undefined
  const next: PetProfile = {
    ...cur,
    ...patch,
    id: GLOBAL_ID,
    updatedAt: new Date(now).toISOString(),
  }
  await db.petProfile.put(next)
  return next
}

// ── Activity ledger ──────────────────────────────────────────────────────────

/** Append one ledger entry, then prune to the newest `PET_ACTIVITY_CAP` rows. */
export async function appendPetActivity(entry: Omit<PetActivityRow, "id">): Promise<number> {
  const db = getDb()
  const id = (await db.petActivityLog.add(entry as PetActivityRow)) as number
  await prunePetActivity()
  return id
}

/** Drop ledger rows beyond the cap (oldest first). Returns the number removed. */
export async function prunePetActivity(cap = PET_ACTIVITY_CAP): Promise<number> {
  const db = getDb()
  const count = await db.petActivityLog.count()
  if (count <= cap) return 0
  const overflow = count - cap
  const oldest = await db.petActivityLog.orderBy("ts").limit(overflow).primaryKeys()
  if (oldest.length > 0) await db.petActivityLog.bulkDelete(oldest as number[])
  return oldest.length
}

/** Newest-first slice of the ledger. */
export async function listPetActivity(limit = 100): Promise<PetActivityRow[]> {
  return getDb().petActivityLog.orderBy("ts").reverse().limit(limit).toArray()
}

/**
 * One page of the ledger, newest first by append order, strictly older than
 * `beforeId` (the id of the last row the caller already has). Without
 * `beforeId` it is the newest page. Paging by the auto-increment key instead
 * of an offset keeps a page stable while new rows keep arriving at the head.
 */
export async function listPetActivityPage(
  beforeId: number | undefined,
  limit: number
): Promise<PetActivityRow[]> {
  const table = getDb().petActivityLog
  const range = beforeId === undefined ? table.toCollection() : table.where(":id").below(beforeId)
  return range.reverse().limit(Math.max(0, limit)).toArray()
}

/**
 * Every ledger row from `fromId` up, newest first. The journal pins its live
 * head here once older pages are loaded, so a row arriving at the head cannot
 * push another one out of the head page and into the gap above the older ones.
 */
export async function listPetActivitySince(fromId: number): Promise<PetActivityRow[]> {
  return getDb().petActivityLog.where(":id").aboveOrEqual(fromId).reverse().toArray()
}

/** Tally activity counts by kind across the (capped) ledger window. */
export async function getPetActivityCounters(): Promise<Record<string, number>> {
  const rows = await getDb().petActivityLog.toArray()
  const counters: Record<string, number> = {}
  for (const row of rows) counters[row.kind] = (counters[row.kind] ?? 0) + 1
  return counters
}

// ── Character bindings ───────────────────────────────────────────────────────

export async function getPetBinding(characterId: string): Promise<PetCharacterBinding | undefined> {
  return getDb().petCharacterBindings.get(characterId)
}

export async function upsertPetBinding(binding: PetCharacterBinding): Promise<PetCharacterBinding> {
  await getDb().petCharacterBindings.put(binding)
  return binding
}

export async function deletePetBinding(characterId: string): Promise<void> {
  await getDb().petCharacterBindings.delete(characterId)
  // A paired phone mirrors bindings (companion sync); without the tombstone a
  // removed binding would stay on the phone indefinitely.
  await recordTombstones("petCharacterBindings", [characterId])
}

export async function listPetBindings(): Promise<PetCharacterBinding[]> {
  return getDb().petCharacterBindings.orderBy("updatedAt").reverse().toArray()
}

export interface PetBindingsWithCharacters {
  /** Every character a session can bind, each showing its effective profile. */
  characters: Character[]
  bindings: PetCharacterBinding[]
}

/**
 * What the console's binding tab lists: the characters and their bindings in
 * one read, so the tab renders one loading state instead of two.
 *
 * Characters come through `listResolvedCharacters`, not the raw table: that
 * includes pack characters (a session can carry one, so `usePet` can bind
 * one) and resolves a variant's effective name. Imported lazily so the many
 * pet callers of this module do not load the character and pack registries.
 */
export async function listPetBindingsWithCharacters(): Promise<PetBindingsWithCharacters> {
  const { listResolvedCharacters } = await import("./characters")
  const [characters, bindings] = await Promise.all([listResolvedCharacters(), listPetBindings()])
  return { characters, bindings }
}

// ── Achievements ─────────────────────────────────────────────────────────────

export async function listPetAchievements(): Promise<PetAchievementRecord[]> {
  return getDb().petAchievements.orderBy("unlockedAt").toArray()
}

/** Record an unlock (idempotent — first write wins on the unlock time). */
export async function recordPetAchievement(id: string, now = Date.now()): Promise<boolean> {
  const db = getDb()
  const existing = await db.petAchievements.get(id)
  if (existing) return false
  await db.petAchievements.put({ id, unlockedAt: now })
  return true
}

// ── Inventory (v94) ──────────────────────────────────────────────────────────

export async function listPetInventory(): Promise<PetInventoryRow[]> {
  return getDb().petInventory.toArray()
}

export async function getPetInventoryItem(id: string): Promise<PetInventoryRow | undefined> {
  return getDb().petInventory.get(id)
}

/** Add `qty` of an item (creates the row when first acquired). */
export async function addPetInventory(
  id: string,
  qty: number,
  now = Date.now()
): Promise<PetInventoryRow> {
  const db = getDb()
  const cur = await db.petInventory.get(id)
  const next: PetInventoryRow = cur
    ? { ...cur, qty: cur.qty + qty, updatedAt: now }
    : { id, qty, acquiredAt: now, updatedAt: now }
  await db.petInventory.put(next)
  return next
}

/** Decrement `qty`; the row is deleted at 0. False when not owned in quantity. */
export async function decrementPetInventory(
  id: string,
  qty = 1,
  now = Date.now()
): Promise<boolean> {
  const db = getDb()
  const cur = await db.petInventory.get(id)
  if (!cur || cur.qty < qty) return false
  if (cur.qty === qty) {
    await db.petInventory.delete(id)
    // Using the last one removes the row, which the mirror only learns from
    // a tombstone; otherwise the phone keeps showing an item that is gone.
    await recordTombstones("petInventory", [id], now)
  } else {
    await db.petInventory.put({ ...cur, qty: cur.qty - qty, updatedAt: now })
  }
  return true
}

// ── Reset ────────────────────────────────────────────────────────────────────

/** Wipe all pet data (used by the settings "reset" action). */
export async function resetPet(): Promise<void> {
  const db = getDb()
  // Collected before the clear: `Table.clear()` fires no Dexie hooks, so
  // neither the tombstones nor the sync invalidation below would happen on
  // their own, and a paired phone would keep mirroring the old pet.
  const [achievementIds, inventoryIds, bindingIds] = await Promise.all([
    db.petAchievements.toCollection().primaryKeys(),
    db.petInventory.toCollection().primaryKeys(),
    db.petCharacterBindings.toCollection().primaryKeys(),
  ])
  await Promise.all([
    db.petProfile.clear(),
    db.petCharacterBindings.clear(),
    db.petActivityLog.clear(),
    db.petAchievements.clear(),
    db.petConversationV2.clear(),
    db.petInventory.clear(),
  ])
  const at = Date.now()
  await Promise.all([
    recordTombstones("petProfile", ["global"], at),
    recordTombstones("petAchievements", achievementIds.map(String), at),
    recordTombstones("petInventory", inventoryIds.map(String), at),
    recordTombstones("petCharacterBindings", bindingIds.map(String), at),
  ])
  // The activity log needs no tombstones: the phone drops its copy when the
  // profile tombstone (or a new profile generation) arrives.
  for (const table of [
    "petProfile",
    "petAchievements",
    "petInventory",
    "petCharacterBindings",
    "petActivityLog",
  ] as const) {
    publishSyncInvalidate(table)
  }
}
