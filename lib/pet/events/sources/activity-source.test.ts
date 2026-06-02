import { wireActivitySource } from "./activity-source"
import type { PetEvent } from "@/types/pet"

function fakeStore(initialActive: boolean) {
  let active = initialActive
  const listeners = new Set<() => void>()
  return {
    setActive(v: boolean) {
      active = v
      listeners.forEach((l) => l())
    },
    subscribe: (l: () => void) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    isActiveNow: () => active,
  }
}

describe("wireActivitySource", () => {
  it("emits on rising and falling edges only", () => {
    const store = fakeStore(false)
    const events: PetEvent[] = []
    wireActivitySource({
      subscribe: store.subscribe,
      isActiveNow: store.isActiveNow,
      source: "terminal",
      activeKind: "thinking",
      xpOnComplete: 3,
      emit: (e) => events.push({ ...e, at: e.at ?? 0 }),
    })

    store.setActive(true) // rising
    store.setActive(true) // no change → no emit
    store.setActive(false) // falling
    expect(events.map((e) => e.kind)).toEqual(["thinking", "success"])
    expect(events[1].xp).toBe(3)
  })

  it("uses a custom idleKind and defaults xp to 0", () => {
    const store = fakeStore(true)
    const events: PetEvent[] = []
    wireActivitySource({
      subscribe: store.subscribe,
      isActiveNow: store.isActiveNow,
      source: "agent-team",
      activeKind: "teamRun",
      idleKind: "review",
      emit: (e) => events.push({ ...e, at: 0 }),
    })
    store.setActive(false)
    expect(events[0]).toMatchObject({ kind: "review", xp: 0 })
  })
})
