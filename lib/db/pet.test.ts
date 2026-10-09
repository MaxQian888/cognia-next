/** @jest-environment jsdom */
// Coverage for the pet Dexie CRUD layer (v67).

import "fake-indexeddb/auto"
import {
  getPetProfile,
  upsertPetProfile,
  patchPetProfile,
  appendPetActivity,
  prunePetActivity,
  listPetActivity,
  listPetActivityPage,
  listPetActivitySince,
  getPetActivityCounters,
  getPetBinding,
  upsertPetBinding,
  deletePetBinding,
  listPetBindings,
  listPetBindingsWithCharacters,
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
import { readTombstonesSince } from "@/lib/sync/tombstones"
import {
  __resetHostInvalidateForTests,
  __setHostInvalidateDepsForTests,
  flushPendingSyncInvalidates,
} from "@/lib/sync/host-invalidate"
import type { PetActivityRow, PetCharacterBinding } from "@/types/pet"
import type { Character } from "@cognia/agent-config-types"

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

  it("pages newest-first by append order, strictly below the cursor", async () => {
    for (let i = 1; i <= 5; i++) await appendPetActivity(activity({ kind: `k${i}`, ts: i }))
    const head = await listPetActivityPage(undefined, 2)
    expect(head.map((r) => r.kind)).toEqual(["k5", "k4"])
    const next = await listPetActivityPage(head[head.length - 1]!.id, 2)
    expect(next.map((r) => r.kind)).toEqual(["k3", "k2"])
    const last = await listPetActivityPage(next[next.length - 1]!.id, 2)
    expect(last.map((r) => r.kind)).toEqual(["k1"])
    expect(await listPetActivityPage(last[0]!.id, 2)).toEqual([])
  })

  it("keeps an older page stable while new rows arrive at the head", async () => {
    for (let i = 1; i <= 3; i++) await appendPetActivity(activity({ kind: `k${i}`, ts: i }))
    const head = await listPetActivityPage(undefined, 1)
    await appendPetActivity(activity({ kind: "k4", ts: 4 }))
    const older = await listPetActivityPage(head[0]!.id, 10)
    expect(older.map((r) => r.kind)).toEqual(["k2", "k1"])
  })

  it("lists every row from an id up, newest first", async () => {
    const ids: number[] = []
    for (let i = 1; i <= 4; i++)
      ids.push(await appendPetActivity(activity({ kind: `k${i}`, ts: i })))
    expect((await listPetActivitySince(ids[1]!)).map((r) => r.kind)).toEqual(["k4", "k3", "k2"])
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
    expect((await readTombstonesSince("petCharacterBindings", 0)).ids).toEqual(["c1"])
  })
})

describe("bindings with characters", () => {
  it("returns the bindable characters alongside every binding", async () => {
    const character = {
      id: "char-pet-test",
      name: "Pet Test Character",
      createdAt: 1,
      updatedAt: 1,
    } as unknown as Character
    await getDb().characters.put(character)
    await upsertPetBinding({
      characterId: "char-pet-test",
      updatedAt: new Date(1).toISOString(),
      species: "cat",
    })
    const { characters, bindings } = await listPetBindingsWithCharacters()
    expect(characters.map((c) => c.id)).toContain("char-pet-test")
    expect(bindings).toEqual([expect.objectContaining({ characterId: "char-pet-test" })])
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
    expect((await readTombstonesSince("petInventory", 0)).ids).toEqual([])
    expect(await decrementPetInventory("berry", 1, 400)).toBe(true)
    expect(await getPetInventoryItem("berry")).toBeUndefined()
    expect(await readTombstonesSince("petInventory", 0)).toEqual({
      ids: ["berry"],
      maxDeletedAt: 400,
    })
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

  it("tombstones the mirrored tables and announces the clear to paired phones", async () => {
    const published: string[] = []
    const restore = __setHostInvalidateDepsForTests({
      publish: (_topic, payload) => {
        published.push(payload.table)
      },
      isRemoteHostActiveFn: () => false,
    })
    try {
      await upsertPetProfile(createDefaultProfile("acct-1"))
      await recordPetAchievement("a")
      await upsertPetBinding({ characterId: "c1", updatedAt: new Date().toISOString() })
      await addPetInventory("berry", 2)
      __resetHostInvalidateForTests()
      published.length = 0
      await resetPet()
      expect((await readTombstonesSince("petProfile", 0)).ids).toEqual(["global"])
      expect((await readTombstonesSince("petAchievements", 0)).ids).toEqual(["a"])
      expect((await readTombstonesSince("petInventory", 0)).ids).toEqual(["berry"])
      expect((await readTombstonesSince("petCharacterBindings", 0)).ids).toEqual(["c1"])
      flushPendingSyncInvalidates()
      expect(new Set(published)).toEqual(
        new Set([
          "petProfile",
          "petAchievements",
          "petInventory",
          "petCharacterBindings",
          "petActivityLog",
        ])
      )
    } finally {
      __resetHostInvalidateForTests()
      restore()
    }
  })
})
