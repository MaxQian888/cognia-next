/** @jest-environment jsdom */
import "fake-indexeddb/auto"

jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: () => ({
    dispatchPetInteract: jest.fn().mockResolvedValue(undefined),
    dispatchPetLevelUp: jest.fn().mockResolvedValue(undefined),
    dispatchPetEvolved: jest.fn().mockResolvedValue(undefined),
    dispatchPetAchievementUnlocked: jest.fn().mockResolvedValue(undefined),
    dispatchPetUnwell: jest.fn().mockResolvedValue(undefined),
  }),
}))

import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { PET_ACTIVITY_CAP, getPetProfile, patchPetProfile, upsertPetProfile } from "@/lib/db/pet"
import { generateBones } from "@/lib/pet/bones/generate"
import { createDefaultProfile } from "@/lib/pet/defaults"
import { purchaseItem } from "@/lib/pet/economy/shop"
import { handlePetEvent, whenPetEventsSettled } from "@/lib/pet/runtime/pet-controller"
import { hatchPet } from "@/lib/pet/runtime/init-pet"
import { renamePet } from "@/lib/pet/runtime/rename-pet"
import type { Transport } from "@/lib/tauri/transport-types"
import type { PetProfile } from "@/types/pet"

import type { SyncDelta } from "../types"
import {
  PET_MIRROR_FINGERPRINT,
  applyPetActivityRows,
  applyPetBindingRows,
  applyPetProfileRows,
  deletePetActivityRows,
  deletePetProfileRows,
  isoMs,
  projectPetActivityForSync,
  projectPetBindingForSync,
  projectPetProfileForSync,
  syncPetAchievements,
  syncPetActivityLog,
  syncPetCharacterBindings,
  syncPetInventory,
  syncPetProfile,
  type PetProfileSyncRow,
} from "./pet"

function hatched(createdAtMs: number, overrides: Partial<PetProfile> = {}): PetProfile {
  return {
    ...createDefaultProfile("acct-1", createdAtMs),
    soul: { name: "Mochi", personality: "curious", hatchDate: new Date(createdAtMs).toISOString() },
    stage: "baby",
    coins: 50,
    ...overrides,
  } as PetProfile
}

function transportAnswering(delta: SyncDelta<unknown>): Transport {
  return {
    call: jest.fn(async () => delta) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  } as Transport
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
}, 30_000)

describe("host projections", () => {
  it("never puts the account fingerprint or the proactive counters on the wire", () => {
    const profile = hatched(1_000, {
      accountFingerprint: "provider-account-123",
      proactiveState: {
        lastSpokeAtMs: 1,
        dayKey: "2026-10-09",
        spokenToday: 2,
        greetedWindows: [],
      },
    })
    const row = projectPetProfileForSync(profile)
    expect(row.accountFingerprint).toBe(PET_MIRROR_FINGERPRINT)
    expect(JSON.stringify(row)).not.toContain("provider-account-123")
    expect("proactiveState" in row).toBe(false)
    expect(row.mirroredBones).toEqual(generateBones("provider-account-123"))
  })

  it("re-exports a mirror's bones rather than regenerating from its sentinel", () => {
    const bones = generateBones("upstream-host")
    const row = projectPetProfileForSync(
      hatched(1_000, { accountFingerprint: PET_MIRROR_FINGERPRINT, mirroredBones: bones })
    )
    expect(row.mirroredBones).toEqual(bones)
  })

  it("names bindings by characterId and ledger rows by their numeric key", () => {
    expect(projectPetBindingForSync({ characterId: "c1", updatedAt: "x" })).toEqual({
      characterId: "c1",
      updatedAt: "x",
      id: "c1",
    })
    expect(
      projectPetActivityForSync([
        { id: 7, kind: "fed", source: "user", xp: 3, ts: 1 },
        { kind: "fed", source: "user", xp: 3, ts: 2 },
      ])
    ).toEqual([{ id: "7", kind: "fed", source: "user", xp: 3, ts: 1 }])
  })

  it("reads an ISO stamp as epoch ms, and garbage as 0", () => {
    expect(isoMs(new Date(5_000).toISOString())).toBe(5_000)
    expect(isoMs("not a date")).toBe(0)
    expect(isoMs(undefined)).toBe(0)
  })
})

describe("client apply", () => {
  it("writes the mirrored profile, which then draws the host's pet", async () => {
    const row = projectPetProfileForSync(hatched(1_000))
    await applyPetProfileRows([row])
    const local = await getPetProfile()
    expect(local?.accountFingerprint).toBe(PET_MIRROR_FINGERPRINT)
    expect(local?.mirroredBones).toEqual(generateBones("acct-1"))
  })

  it("forces the sentinel even if a row arrives carrying a fingerprint", async () => {
    const row = { ...projectPetProfileForSync(hatched(1_000)), accountFingerprint: "leaked" }
    await applyPetProfileRows([row as PetProfileSyncRow])
    expect((await getPetProfile())?.accountFingerprint).toBe(PET_MIRROR_FINGERPRINT)
  })

  it("drops the old pet's ledger when a reset pet arrives (new createdAt)", async () => {
    await applyPetProfileRows([projectPetProfileForSync(hatched(1_000))])
    await getDb().petActivityLog.bulkPut([
      { id: 1, kind: "fed", source: "user", xp: 3, ts: 2_000 },
      { id: 2, kind: "fed", source: "user", xp: 3, ts: 9_000 },
    ])
    // Same pet: nothing is touched.
    await applyPetProfileRows([projectPetProfileForSync(hatched(1_000, { xp: 3 }))])
    expect(await getDb().petActivityLog.count()).toBe(2)
    // A reset on the host: a new pet born at 5_000.
    await applyPetProfileRows([projectPetProfileForSync(hatched(5_000))])
    expect((await getDb().petActivityLog.toArray()).map((row) => row.id)).toEqual([2])
  })

  it("treats a tombstoned profile as a reset: the ledger goes with it", async () => {
    await applyPetProfileRows([projectPetProfileForSync(hatched(1_000))])
    await getDb().petActivityLog.put({ id: 1, kind: "fed", source: "user", xp: 3, ts: 2_000 })
    await deletePetProfileRows(["something-else"])
    expect(await getPetProfile()).toBeDefined()
    await deletePetProfileRows(["global"])
    expect(await getPetProfile()).toBeUndefined()
    expect(await getDb().petActivityLog.count()).toBe(0)
  })

  it("strips the wire id from bindings", async () => {
    await applyPetBindingRows([{ id: "c1", characterId: "c1", species: "dragon", updatedAt: "x" }])
    expect(await getDb().petCharacterBindings.get("c1")).toEqual({
      characterId: "c1",
      species: "dragon",
      updatedAt: "x",
    })
  })

  it("maps ledger ids back to numbers, ignores foreign ids, and prunes to the cap", async () => {
    await applyPetActivityRows([
      { id: "3", kind: "fed", source: "user", xp: 3, ts: 3 },
      { id: "not-a-key", kind: "fed", source: "user", xp: 3, ts: 4 },
    ])
    expect(await getDb().petActivityLog.get(3)).toMatchObject({ id: 3, kind: "fed" })
    expect(await getDb().petActivityLog.count()).toBe(1)

    const overflow = Array.from({ length: PET_ACTIVITY_CAP + 5 }, (_, i) => ({
      id: String(100 + i),
      kind: "petted",
      source: "user",
      xp: 2,
      ts: 100 + i,
    }))
    await applyPetActivityRows(overflow)
    expect(await getDb().petActivityLog.count()).toBe(PET_ACTIVITY_CAP)
    await deletePetActivityRows(["104", "bogus"])
    expect(await getDb().petActivityLog.get(104)).toBeUndefined()
  }, 30_000)
})

describe("sync handlers", () => {
  it("pulls the profile, then deletes it on a tombstone", async () => {
    const row = projectPetProfileForSync(hatched(1_000))
    const pulled = await syncPetProfile(
      transportAnswering({ rows: [row], deleted_ids: [], next_since: 1_000 }),
      { since: 0 }
    )
    expect(pulled).toMatchObject({ ok: true, result: { table: "petProfile", nextSince: 1_000 } })
    expect((await getPetProfile())?.soul?.name).toBe("Mochi")
    await syncPetProfile(
      transportAnswering({ rows: [], deleted_ids: ["global"], next_since: 2_000 }),
      { since: 1_000 }
    )
    expect(await getPetProfile()).toBeUndefined()
  })

  it("deletes a binding by the characterId the wire names it by", async () => {
    await getDb().petCharacterBindings.put({ characterId: "c1", updatedAt: "x" })
    await syncPetCharacterBindings(
      transportAnswering({ rows: [], deleted_ids: ["c1"], next_since: 5 }),
      { since: 0 }
    )
    expect(await getDb().petCharacterBindings.get("c1")).toBeUndefined()
  })

  it("pulls unlocked achievements, then drops them when a reset tombstones them", async () => {
    const pulled = await syncPetAchievements(
      transportAnswering({
        rows: [
          { id: "first-feed", unlockedAt: 100 },
          { id: "level-5", unlockedAt: 200 },
        ],
        deleted_ids: [],
        next_since: 200,
      }),
      { since: 0 }
    )
    expect(pulled).toMatchObject({
      ok: true,
      result: { table: "petAchievements", nextSince: 200 },
    })
    expect(await getDb().petAchievements.get("level-5")).toEqual({
      id: "level-5",
      unlockedAt: 200,
    })

    await syncPetAchievements(
      transportAnswering({ rows: [], deleted_ids: ["first-feed", "level-5"], next_since: 300 }),
      { since: 200 }
    )
    expect(await getDb().petAchievements.count()).toBe(0)
  })

  it("mirrors inventory quantities, and deletes a row the host used up to zero", async () => {
    await syncPetInventory(
      transportAnswering({
        rows: [
          { id: "berry", qty: 2, acquiredAt: 10, updatedAt: 10 },
          { id: "beanie", qty: 1, acquiredAt: 11, updatedAt: 11 },
        ],
        deleted_ids: [],
        next_since: 11,
      }),
      { since: 0 }
    )
    expect(await getDb().petInventory.get("berry")).toMatchObject({ qty: 2 })

    // The host ate both berries: its row hit zero and was tombstoned, and the
    // same pull carries the beanie's bump. Leaving the berry row behind would
    // offer the phone an item the desktop no longer has.
    const outcome = await syncPetInventory(
      transportAnswering({
        rows: [{ id: "beanie", qty: 2, acquiredAt: 11, updatedAt: 20 }],
        deleted_ids: ["berry"],
        next_since: 20,
      }),
      { since: 11 }
    )
    expect(outcome).toMatchObject({ ok: true, result: { table: "petInventory", nextSince: 20 } })
    expect(await getDb().petInventory.get("berry")).toBeUndefined()
    expect(await getDb().petInventory.get("beanie")).toMatchObject({ qty: 2, updatedAt: 20 })
  })

  it("pulls ledger rows under their numeric key", async () => {
    await syncPetActivityLog(
      transportAnswering({
        rows: [{ id: "41", kind: "played", source: "user", xp: 4, ts: 10 }],
        deleted_ids: [],
        next_since: 41,
      }),
      { since: 0 }
    )
    expect(await getDb().petActivityLog.get(41)).toMatchObject({ kind: "played" })
  })
})

/**
 * The profile mirror cursors on `updatedAt`, so a writer that forgets to stamp
 * it is a change a paired phone never sees. Every writer of the singleton is
 * pinned here.
 */
describe("every petProfile writer advances updatedAt", () => {
  const BORN = Date.UTC(2026, 0, 1)

  async function seed(): Promise<number> {
    await upsertPetProfile(hatched(BORN))
    return isoMs((await getPetProfile())!.updatedAt)
  }

  it("patchPetProfile", async () => {
    const before = await seed()
    await patchPetProfile({ coins: 3 }, BORN + 10)
    expect(isoMs((await getPetProfile())!.updatedAt)).toBeGreaterThan(before)
  })

  it("renamePet", async () => {
    const before = await seed()
    await renamePet("Bao", BORN + 10)
    expect(isoMs((await getPetProfile())!.updatedAt)).toBeGreaterThan(before)
  })

  it("purchaseItem", async () => {
    const before = await seed()
    await purchaseItem("berry", 1)
    expect(isoMs((await getPetProfile())!.updatedAt)).toBeGreaterThan(before)
  })

  it("hatchPet", async () => {
    await upsertPetProfile({ ...hatched(BORN), soul: null })
    const before = isoMs((await getPetProfile())!.updatedAt)
    await hatchPet(null, BORN + 10)
    expect(isoMs((await getPetProfile())!.updatedAt)).toBeGreaterThan(before)
  })

  it("the controller applying an event", async () => {
    const before = await seed()
    await handlePetEvent({ source: "user", kind: "petted", at: BORN + 10 })
    await whenPetEventsSettled()
    expect(isoMs((await getPetProfile())!.updatedAt)).toBeGreaterThan(before)
  })
})
