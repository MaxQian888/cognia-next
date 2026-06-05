// Dexie CRUD for the pet subsystem (v67). Dexie is the source of truth for the
// profile, per-character bindings, the activity ledger, and achievement unlocks;
// the React layer reads these reactively via `useLiveQuery`. Modeled on the
// small data-module pattern in `lib/db/shared-links.ts`.
//
// Needs decay is NOT applied here — this module stores/returns raw rows. Lazy
// decay is a pure function (`lib/pet/needs/decay.ts`) applied at the read site so
// storage stays a faithful record of the last settled values.

import { getDb } from "./schema"
import type {
  PetAchievementRecord,
  PetActivityRow,
  PetCharacterBinding,
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
}

export async function listPetBindings(): Promise<PetCharacterBinding[]> {
  return getDb().petCharacterBindings.orderBy("updatedAt").reverse().toArray()
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

// ── Reset ────────────────────────────────────────────────────────────────────

/** Wipe all pet data (used by the settings "reset" action). */
export async function resetPet(): Promise<void> {
  const db = getDb()
  await Promise.all([
    db.petProfile.clear(),
    db.petCharacterBindings.clear(),
    db.petActivityLog.clear(),
    db.petAchievements.clear(),
    db.petConversation.clear(),
  ])
}
