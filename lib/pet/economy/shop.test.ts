/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { canAfford, consumeItem, purchaseItem } from "./shop"
import { getPetItem } from "./item-catalog"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { getPetInventoryItem, getPetProfile, upsertPetProfile } from "@/lib/db/pet"
import { createDefaultProfile } from "@/lib/pet/defaults"
import { __resetPetEventBusForTesting, getPetEventBus } from "@/lib/pet/events/pet-event-bus"
import { handlePetEvent, whenPetEventsSettled } from "@/lib/pet/runtime/pet-controller"
import type { PetEvent, PetProfile } from "@/types/pet"

afterEach(() => {
  __resetPetEventBusForTesting()
})

// Cold fake-indexeddb open of the full schema can exceed jest's 5s default
// under parallel suite load — same allowance as the other Dexie-cold suites.
beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await Promise.all([
    getDb().petProfile.clear(),
    getDb().petActivityLog.clear(),
    getDb().petAchievements.clear(),
    getDb().petInventory.clear(),
  ])
}, 30_000)

async function seedProfile(coins: number): Promise<PetProfile> {
  const profile: PetProfile = {
    ...createDefaultProfile("acct-1", 0),
    soul: { name: "Boba", personality: "x", hatchDate: "" },
    stage: "baby",
    coins,
  }
  await upsertPetProfile(profile)
  return profile
}

describe("canAfford", () => {
  const berry = getPetItem("berry")! // price 5
  it("compares the normalized balance against price × qty", () => {
    expect(canAfford(5, berry)).toBe(true)
    expect(canAfford(4, berry)).toBe(false)
    expect(canAfford(10, berry, 2)).toBe(true)
    expect(canAfford(9, berry, 2)).toBe(false)
    expect(canAfford(Number.NaN, berry)).toBe(false)
  })
})

describe("purchaseItem", () => {
  it("deducts coins and adds the item to the inventory", async () => {
    await seedProfile(20)
    const result = await purchaseItem("berry")
    expect(result).toEqual({ ok: true, coins: 15 })
    expect((await getPetProfile())?.coins).toBe(15)
    expect((await getPetInventoryItem("berry"))?.qty).toBe(1)
  })

  it("accumulates quantity across purchases", async () => {
    await seedProfile(20)
    await purchaseItem("berry")
    await purchaseItem("berry", 2)
    expect((await getPetInventoryItem("berry"))?.qty).toBe(3)
    expect((await getPetProfile())?.coins).toBe(5)
  })

  it("rejects an insufficient balance without any writes", async () => {
    await seedProfile(3)
    const result = await purchaseItem("berry")
    expect(result).toEqual({ ok: false, error: "insufficient-coins" })
    expect((await getPetProfile())?.coins).toBe(3)
    expect(await getPetInventoryItem("berry")).toBeUndefined()
  })

  it("rejects unknown items and a missing profile", async () => {
    expect(await purchaseItem("nope")).toEqual({ ok: false, error: "unknown-item" })
    expect(await purchaseItem("berry")).toEqual({ ok: false, error: "no-profile" })
  })

  it("survives a concurrent interaction event (serialized RMW)", async () => {
    await seedProfile(20)
    // Fire an XP/coin-earning event and a purchase back-to-back WITHOUT
    // awaiting in between — the purchase must not be overwritten by the
    // event's upsert, nor vice versa.
    const eventDone = handlePetEvent({ source: "user", kind: "fed", at: Date.now() } as PetEvent)
    const purchaseDone = purchaseItem("berry")
    await Promise.all([eventDone, purchaseDone])
    await whenPetEventsSettled()

    const profile = await getPetProfile()
    // 20 (seed) + 2 (fed award) − 5 (berry) = 17.
    expect(profile?.coins).toBe(17)
    expect((await getPetInventoryItem("berry"))?.qty).toBe(1)
  })
})

describe("consumeItem", () => {
  it("decrements a consumable and emits its interaction event with the item id", async () => {
    await seedProfile(20)
    await purchaseItem("berry", 2)
    const seen: PetEvent[] = []
    getPetEventBus().subscribe((e) => seen.push(e))

    const result = await consumeItem("berry")
    expect(result).toEqual({ ok: true })
    expect((await getPetInventoryItem("berry"))?.qty).toBe(1)
    expect(seen).toContainEqual(
      expect.objectContaining({ source: "user", kind: "fed", meta: { itemId: "berry" } })
    )
  })

  it("deletes the row when the last unit is consumed", async () => {
    await seedProfile(20)
    await purchaseItem("berry")
    await consumeItem("berry")
    expect(await getPetInventoryItem("berry")).toBeUndefined()
  })

  it("refuses to consume an item that is not owned", async () => {
    await seedProfile(20)
    const result = await consumeItem("berry")
    expect(result).toEqual({ ok: false, error: "not-owned" })
  })

  it("applies decor cosmetics without consuming the item", async () => {
    await seedProfile(50)
    await purchaseItem("star-charm")
    const result = await consumeItem("star-charm")
    expect(result).toEqual({ ok: true })
    expect((await getPetInventoryItem("star-charm"))?.qty).toBe(1)
    expect((await getPetProfile())?.cosmetic).toEqual({ hat: "crown" })
  })

  it("rejects unknown items", async () => {
    expect(await consumeItem("nope")).toEqual({ ok: false, error: "unknown-item" })
  })
})
