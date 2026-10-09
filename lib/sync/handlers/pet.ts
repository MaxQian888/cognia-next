/**
 * Companion sync for the desktop pet (ADR-0219, remote pet care).
 *
 * The pet lives on the desktop. A paired phone mirrors five tables read-only
 * so its console can paint offline, and sends every action back as a `pet_*`
 * RPC (`lib/pet/remote/client.ts`), so the host's one controller awards it
 * once. Nothing here ever writes back.
 *
 * Both halves of the wire shape live in this file, so they cannot drift: the
 * host-side projections `lib/sync/desktop-sync-source.ts` calls, and the
 * client-side apply steps.
 *
 *   petProfile            singleton, cursored on its ISO `updatedAt`. Crosses
 *                         as a projection: `accountFingerprint` derives from
 *                         the provider account id and is replaced with a
 *                         sentinel; the host's generated bones ride along as
 *                         `mirroredBones` so the phone draws the same pet; the
 *                         proactive-speech counters are host bookkeeping and
 *                         are dropped. A reset tombstones it.
 *   petAchievements       cursored on `unlockedAt`, tombstoned on reset.
 *   petInventory          cursored on `updatedAt`; a row used up to zero, or
 *                         cleared by a reset, is tombstoned.
 *   petCharacterBindings  keyed by `characterId`; the wire carries it as `id`
 *                         for the generic handler and the apply step strips it.
 *   petActivityLog        auto-increment numeric key, so the wire id is
 *                         `String(id)` and the cursor is the id itself. The
 *                         host caps the ledger at 2000 rows and so does the
 *                         mirror, without tombstones. A reset clears the
 *                         host's ledger with no per-row delete to send, so the
 *                         mirror recognises it from the profile instead: a
 *                         profile whose `createdAt` differs from the local one
 *                         is a different pet, and every local ledger row older
 *                         than it belongs to the pet that is gone.
 */

import { getDb } from "@/lib/db/schema"
import { PET_ACTIVITY_CAP, prunePetActivity } from "@/lib/db/pet"
import { generateBones } from "@/lib/pet/bones/generate"
import type { Transport } from "@/lib/tauri/transport-types"
import type {
  PetAchievementRecord,
  PetActivityRow,
  PetBones,
  PetCharacterBinding,
  PetInventoryRow,
  PetProfile,
} from "@/types/pet"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

/**
 * What a mirrored profile carries in place of the account fingerprint. Not a
 * valid account id, so nothing can mistake it for one, and stable, so a
 * mirror that regenerated bones from it would at least draw the same wrong pet
 * every time rather than a new one per pull.
 */
export const PET_MIRROR_FINGERPRINT = "companion-mirror"

/** The profile as it crosses the wire. */
export type PetProfileSyncRow = Omit<PetProfile, "proactiveState" | "mirroredBones"> & {
  mirroredBones: PetBones
}

export type PetBindingSyncRow = PetCharacterBinding & { id: string }

export type PetActivitySyncRow = Omit<PetActivityRow, "id"> & { id: string }

/** Epoch ms of an ISO stamp, or 0 when it does not parse. */
export function isoMs(value: string | undefined): number {
  if (!value) return 0
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
}

// ── Host-side projections ────────────────────────────────────────────────────

export function projectPetProfileForSync(profile: PetProfile): PetProfileSyncRow {
  const { proactiveState: _proactive, mirroredBones, ...rest } = profile
  return {
    ...rest,
    accountFingerprint: PET_MIRROR_FINGERPRINT,
    // A host that is itself a mirror (a desktop driving another host) already
    // holds the true bones and a sentinel fingerprint; regenerating from the
    // sentinel would hand its own clients a different pet.
    mirroredBones: mirroredBones ?? generateBones(profile.accountFingerprint),
  }
}

export function projectPetBindingForSync(binding: PetCharacterBinding): PetBindingSyncRow {
  return { ...binding, id: binding.characterId }
}

/** Rows without a numeric key cannot be named on the wire, so they are skipped. */
export function projectPetActivityForSync(rows: PetActivityRow[]): PetActivitySyncRow[] {
  return rows
    .filter((row) => typeof row.id === "number" && Number.isSafeInteger(row.id))
    .map((row) => ({ ...row, id: String(row.id) }))
}

// ── Client-side apply ────────────────────────────────────────────────────────

/** Wire id → local auto-increment key; anything else is not a ledger row. */
function activityKey(id: string): number | null {
  if (!/^\d+$/.test(id)) return null
  const key = Number(id)
  return Number.isSafeInteger(key) ? key : null
}

export async function applyPetProfileRows(
  rows: PetProfileSyncRow[],
  assertCurrent: () => void = () => {}
): Promise<void> {
  const db = getDb()
  const incoming = rows.filter((row) => row.id === "global")
  if (incoming.length === 0) return
  const row = incoming[incoming.length - 1]!
  await db.transaction("rw", db.petProfile, db.petActivityLog, async () => {
    const local = await db.petProfile.get("global")
    assertCurrent()
    if (local && local.createdAt !== row.createdAt) {
      // A reset on the host: a new pet with a new birth time. Its ledger
      // starts empty there, and nothing deletes the old one here otherwise.
      const born = isoMs(row.createdAt)
      await db.petActivityLog.where("ts").below(born).delete()
    }
    await db.petProfile.put({
      ...(row as PetProfile),
      // Defensive: a mirror never holds a real fingerprint, whatever arrives.
      accountFingerprint: PET_MIRROR_FINGERPRINT,
    })
  })
}

/** A tombstoned profile is a reset pet; its ledger goes with it. */
export async function deletePetProfileRows(
  ids: string[],
  assertCurrent: () => void = () => {}
): Promise<void> {
  if (!ids.includes("global")) return
  const db = getDb()
  await db.transaction("rw", db.petProfile, db.petActivityLog, async () => {
    assertCurrent()
    await db.petProfile.delete("global")
    await db.petActivityLog.clear()
  })
}

export async function applyPetBindingRows(
  rows: PetBindingSyncRow[],
  assertCurrent: () => void = () => {}
): Promise<void> {
  assertCurrent()
  await getDb().petCharacterBindings.bulkPut(rows.map(({ id: _id, ...binding }) => binding))
}

export async function applyPetActivityRows(
  rows: PetActivitySyncRow[],
  assertCurrent: () => void = () => {}
): Promise<void> {
  const local: PetActivityRow[] = []
  for (const row of rows) {
    const key = activityKey(row.id)
    if (key !== null) local.push({ ...row, id: key })
  }
  assertCurrent()
  if (local.length > 0) await getDb().petActivityLog.bulkPut(local)
  // The host keeps the newest `PET_ACTIVITY_CAP`; the mirror ages out on the
  // same rule, so the two windows match without a delete crossing the wire.
  await prunePetActivity(PET_ACTIVITY_CAP)
}

export async function deletePetActivityRows(
  ids: string[],
  assertCurrent: () => void = () => {}
): Promise<void> {
  const keys = ids.map(activityKey).filter((key): key is number => key !== null)
  assertCurrent()
  if (keys.length > 0) await getDb().petActivityLog.bulkDelete(keys)
}

export function syncPetProfile(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<PetProfileSyncRow>(
    {
      table: "petProfile",
      getTable: () => getDb().petProfile as never,
      applyRows: applyPetProfileRows,
      applyDeletes: deletePetProfileRows,
    },
    transport,
    cursor
  )
}

export function syncPetAchievements(
  transport: Transport,
  cursor: SyncCursor
): Promise<SyncOutcome> {
  return runSyncHandler<PetAchievementRecord>(
    { table: "petAchievements", getTable: () => getDb().petAchievements as never },
    transport,
    cursor
  )
}

export function syncPetInventory(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<PetInventoryRow>(
    { table: "petInventory", getTable: () => getDb().petInventory },
    transport,
    cursor
  )
}

export function syncPetCharacterBindings(
  transport: Transport,
  cursor: SyncCursor
): Promise<SyncOutcome> {
  return runSyncHandler<PetBindingSyncRow>(
    {
      table: "petCharacterBindings",
      getTable: () => getDb().petCharacterBindings as never,
      applyRows: applyPetBindingRows,
    },
    transport,
    cursor
  )
}

export function syncPetActivityLog(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<PetActivitySyncRow>(
    {
      table: "petActivityLog",
      getTable: () => getDb().petActivityLog as never,
      applyRows: applyPetActivityRows,
      applyDeletes: deletePetActivityRows,
    },
    transport,
    cursor
  )
}
