// Coverage for the pet Dexie CRUD layer (v67).

import "fake-indexeddb/auto"
import {
  getPetProfile,
  upsertPetProfile,
  patchPetProfile,
  appendPetActivity,
  prunePetActivity,
  listPetActivity,
  getPetActivityCounters,
  getPetBinding,
  upsertPetBinding,
  deletePetBinding,
  listPetBindings,
  listPetAchievements,
  recordPetAchievement,
  listPetInventory,
  getPetInventoryItem,
  addPetInventory,
  decrementPetInventory,
  resetPet,
  PET_ACTIVITY_CAP,
} from "./pet"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"
import { createDefaultProfile } from "@/lib/pet/defaults"
import type { PetActivityRow, PetCharacterBinding } from "@/types/pet"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await Promise.all([
    getDb().petProfile.clear(),
    getDb().petCharacterBindings.clear(),
    getDb().petActivityLog.clear(),
    getDb().petAchievements.clear(),
  ])
})

function activity(partial: Partial<PetActivityRow> = {}): Omit<PetActivityRow, "id"> {
  return { kind: "fed", source: "user", xp: 5, ts: Date.now(), ...partial }
}

describe("profile", () => {
  it("upserts and reads the singleton", async () => {
    expect(await getPetProfile()).toBeUndefined()
    const p = createDefaultProfile("acct-1", 1000)
    await upsertPetProfile(p)
    expect(await getPetProfile()).toMatchObject({ id: "global", accountFingerprint: "acct-1" })
  })

  it("patches an existing profile and bumps updatedAt", async () => {
    await upsertPetProfile(createDefaultProfile("acct-1", 1000))
    const next = await patchPetProfile({ xp: 42, level: 3 }, 5000)
    expect(next).toMatchObject({ xp: 42, level: 3 })
    expect(next?.updatedAt).toBe(new Date(5000).toISOString())
  })

  it("returns undefined when patching a missing profile", async () => {
    expect(await patchPetProfile({ xp: 1 })).toBeUndefined()
  })
})

describe("activity ledger", () => {
  it("appends and lists newest-first", async () => {
    await appendPetActivity(activity({ kind: "fed", ts: 1 }))
    await appendPetActivity(activity({ kind: "played", ts: 2 }))
    const rows = await listPetActivity()
    expect(rows.map((r) => r.kind)).toEqual(["played", "fed"])
  })

  it("prunes the oldest rows beyond the cap", async () => {
    // Insert cap + 3 rows directly for speed, then prune.
    const rows: PetActivityRow[] = Array.from({ length: PET_ACTIVITY_CAP + 3 }, (_, i) => ({
      kind: "fed",
      source: "user",
      xp: 1,
      ts: i + 1,
    }))
    await getDb().petActivityLog.bulkAdd(rows)
    const removed = await prunePetActivity()
    expect(removed).toBe(3)
    expect(await getDb().petActivityLog.count()).toBe(PET_ACTIVITY_CAP)
    // The three oldest (ts 1,2,3) are gone.
    const remaining = await getDb().petActivityLog.orderBy("ts").first()
    expect(remaining?.ts).toBe(4)
  })

  it("tallies counters by kind", async () => {
    await appendPetActivity(activity({ kind: "fed", ts: 1 }))
    await appendPetActivity(activity({ kind: "fed", ts: 2 }))
    await appendPetActivity(activity({ kind: "played", ts: 3 }))
    expect(await getPetActivityCounters()).toEqual({ fed: 2, played: 1 })
  })
})

describe("bindings", () => {
  function binding(characterId: string, partial: Partial<PetCharacterBinding> = {}) {
    return { characterId, updatedAt: new Date(1000).toISOString(), ...partial }
  }

  it("upserts, reads, lists newest-first, and deletes", async () => {
    await upsertPetBinding(binding("c1", { updatedAt: new Date(1).toISOString(), species: "cat" }))
    await upsertPetBinding(binding("c2", { updatedAt: new Date(2).toISOString(), species: "owl" }))
    expect(await getPetBinding("c1")).toMatchObject({ species: "cat" })
    expect((await listPetBindings()).map((b) => b.characterId)).toEqual(["c2", "c1"])
    await deletePetBinding("c1")
    expect(await getPetBinding("c1")).toBeUndefined()
  })
})

describe("achievements", () => {
  it("records an unlock once (idempotent) and lists them", async () => {
    expect(await recordPetAchievement("first-feed", 100)).toBe(true)
    expect(await recordPetAchievement("first-feed", 200)).toBe(false)
    const list = await listPetAchievements()
    expect(list).toEqual([{ id: "first-feed", unlockedAt: 100 }])
  })
})

describe("inventory (v94)", () => {
  it("adds quantity, creating the row on first acquisition", async () => {
    const first = await addPetInventory("berry", 2, 100)
    expect(first).toEqual({ id: "berry", qty: 2, acquiredAt: 100, updatedAt: 100 })
    const second = await addPetInventory("berry", 3, 200)
    expect(second).toEqual({ id: "berry", qty: 5, acquiredAt: 100, updatedAt: 200 })
    expect(await getPetInventoryItem("berry")).toEqual(second)
    expect(await listPetInventory()).toHaveLength(1)
  })

  it("decrements and deletes the row at zero", async () => {
    await addPetInventory("berry", 2, 100)
    expect(await decrementPetInventory("berry", 1, 300)).toBe(true)
    expect((await getPetInventoryItem("berry"))?.qty).toBe(1)
    expect(await decrementPetInventory("berry")).toBe(true)
    expect(await getPetInventoryItem("berry")).toBeUndefined()
  })

  it("refuses to decrement below the owned quantity", async () => {
    expect(await decrementPetInventory("berry")).toBe(false)
    await addPetInventory("berry", 1, 100)
    expect(await decrementPetInventory("berry", 2)).toBe(false)
    expect((await getPetInventoryItem("berry"))?.qty).toBe(1)
  })
})

describe("resetPet", () => {
  it("clears every pet table", async () => {
    await upsertPetProfile(createDefaultProfile("acct-1"))
    await appendPetActivity(activity())
    await recordPetAchievement("a")
    await upsertPetBinding({ characterId: "c1", updatedAt: new Date().toISOString() })
    await addPetInventory("berry", 2)
    await resetPet()
    expect(await getPetProfile()).toBeUndefined()
    expect(await listPetActivity()).toEqual([])
    expect(await listPetAchievements()).toEqual([])
    expect(await listPetBindings()).toEqual([])
    expect(await listPetInventory()).toEqual([])
  })
})
