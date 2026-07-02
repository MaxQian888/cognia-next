import "fake-indexeddb/auto"
import { handlePetEvent, whenPetEventsSettled } from "./pet-controller"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { getPetProfile, listPetAchievements, upsertPetProfile } from "@/lib/db/pet"
import { createDefaultProfile } from "@/lib/pet/defaults"
import { __resetPetEventBusForTesting, getPetEventBus } from "@/lib/pet/events/pet-event-bus"
import { usePetStore } from "@/stores/pet/pet-store"
import type { PetEvent } from "@/types/pet"

afterEach(() => {
  __resetPetEventBusForTesting()
})

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

  it("emits achievementUnlocked on the bus once per newly-unlocked id", async () => {
    await upsertPetProfile({
      ...createDefaultProfile("acct-1", 0),
      soul: { name: "Boba", personality: "x", hatchDate: "" },
      stage: "baby",
    })
    const seen: PetEvent[] = []
    getPetEventBus().subscribe((e) => {
      if (e.kind === "achievementUnlocked") seen.push(e)
    })

    await handlePetEvent(event("goalComplete")) // unlocks first-xp + hatched
    await whenPetEventsSettled()

    const ids = seen.map((e) => e.meta?.achievementId)
    expect(ids).toContain("first-xp")
    expect(ids).toContain("hatched")
    expect(seen.every((e) => e.source === "system" && e.at === 1000)).toBe(true)

    // Replaying the same event unlocks nothing new → no further emits.
    seen.length = 0
    await handlePetEvent(event("goalComplete"))
    await whenPetEventsSettled()
    expect(seen).toHaveLength(0)
  })

  it("grows stats from work and surfaces the grown keys in the store", async () => {
    await upsertPetProfile({
      ...createDefaultProfile("acct-1", 0),
      soul: { name: "Boba", personality: "x", hatchDate: "" },
      stage: "baby",
    })
    await handlePetEvent(event("goalComplete"))
    await whenPetEventsSettled()

    const profile = await getPetProfile()
    expect(profile?.statProgress?.patience).toBeGreaterThan(0)
    expect(usePetStore.getState().lastGrewStats).toEqual(
      expect.arrayContaining(["patience", "wisdom"])
    )
  })

  it("raises a care alert and stamps notifiedAt when the pet becomes unwell", async () => {
    const start = 2_000_000
    await upsertPetProfile({
      ...createDefaultProfile("acct-1", 0),
      soul: { name: "Pip", personality: "x", hatchDate: "" },
      stage: "baby",
      needs: { energy: 5, mood: 5, bond: 50, lastTickAt: new Date(start).toISOString() },
      care: {
        lowSince: start,
        condition: "well",
        notifiedAt: null,
        everUnwell: false,
        careQuality: 50,
      },
    })
    // An idle event 7h later crosses the sustain threshold.
    await handlePetEvent({ source: "system", kind: "idle", at: start + 7 * 3_600_000 })
    await whenPetEventsSettled()

    const profile = await getPetProfile()
    expect(profile?.care?.condition).toBe("unwell")
    expect(profile?.care?.notifiedAt).toBe(start + 7 * 3_600_000)
    expect(usePetStore.getState().careAlert).toEqual({
      at: start + 7 * 3_600_000,
      petName: "Pip",
    })
    expect(usePetStore.getState().visualState).toBe("unwell")
  })

  it("shows the expressive thinking/happy states for twin activity", async () => {
    await upsertPetProfile({
      ...createDefaultProfile("acct-2", 0),
      soul: { name: "Pip", personality: "x", hatchDate: "" },
      stage: "baby",
    })
    // twinBusy is expressive (not a PASSIVE_KIND) so it reaches the reducer.
    await handlePetEvent({ source: "twin", kind: "twinBusy", at: 1000 })
    await whenPetEventsSettled()
    expect(usePetStore.getState().visualState).toBe("thinking")

    await handlePetEvent({ source: "twin", kind: "twinMilestone", at: 1001 })
    await whenPetEventsSettled()
    expect(usePetStore.getState().visualState).toBe("happy")
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
