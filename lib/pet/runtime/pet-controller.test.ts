import "fake-indexeddb/auto"
import { handlePetEvent, whenPetEventsSettled } from "./pet-controller"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { getPetProfile, listPetAchievements, upsertPetProfile } from "@/lib/db/pet"
import { createDefaultProfile } from "@/lib/pet/defaults"
import { usePetStore } from "@/stores/pet/pet-store"
import type { PetEvent } from "@/types/pet"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await Promise.all([
    getDb().petProfile.clear(),
    getDb().petActivityLog.clear(),
    getDb().petAchievements.clear(),
  ])
  usePetStore.setState({ visualState: "idle", oneShotQueue: [] })
})

function event(kind: PetEvent["kind"], xp?: number): PetEvent {
  return { source: "user", kind, xp, at: 1000 }
}

describe("handlePetEvent", () => {
  it("is a no-op when no profile exists yet", async () => {
    await handlePetEvent(event("fed"))
    await whenPetEventsSettled()
    expect(await getPetProfile()).toBeUndefined()
  })

  it("awards XP, persists, drives the store, and logs the activity", async () => {
    await upsertPetProfile({
      ...createDefaultProfile("acct-1", 0),
      soul: { name: "Boba", personality: "x", hatchDate: "" },
      stage: "baby",
    })
    await handlePetEvent(event("goalComplete"))
    await whenPetEventsSettled()

    const profile = await getPetProfile()
    expect(profile?.xp).toBe(25)
    expect(usePetStore.getState().visualState).toBe("happy")
    expect(usePetStore.getState().oneShotQueue).toContain("happy")
    expect((await getDb().petActivityLog.toArray()).map((r) => r.kind)).toContain("goalComplete")
  })

  it("does not log zero-XP radar events", async () => {
    await upsertPetProfile(createDefaultProfile("acct-1", 0))
    await handlePetEvent(event("thinking"))
    await whenPetEventsSettled()
    expect(await getDb().petActivityLog.count()).toBe(0)
    expect(usePetStore.getState().visualState).toBe("thinking")
  })

  it("records newly-unlocked achievements", async () => {
    await upsertPetProfile({
      ...createDefaultProfile("acct-1", 0),
      soul: { name: "Boba", personality: "x", hatchDate: "" },
      stage: "baby",
    })
    await handlePetEvent(event("goalComplete")) // gives XP → first-xp unlocks
    await whenPetEventsSettled()
    const ids = (await listPetAchievements()).map((a) => a.id)
    expect(ids).toContain("first-xp")
    expect(ids).toContain("hatched")
  })

  it("serializes concurrent events without losing XP", async () => {
    await upsertPetProfile({
      ...createDefaultProfile("acct-1", 0),
      soul: { name: "Boba", personality: "x", hatchDate: "" },
      stage: "baby",
    })
    await Promise.all([
      handlePetEvent(event("goalProgress")),
      handlePetEvent(event("goalProgress")),
      handlePetEvent(event("goalProgress")),
    ])
    await whenPetEventsSettled()
    expect((await getPetProfile())?.xp).toBe(15) // 3 × 5, none lost to a race
  })
})
