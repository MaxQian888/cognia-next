import {
  getPetEventBus,
  emitPetEvent,
  PetEventBus,
  __resetPetEventBusForTesting,
} from "./pet-event-bus"
import type { PetEvent } from "@/types/pet"

afterEach(() => __resetPetEventBusForTesting())

describe("PetEventBus", () => {
  it("delivers events to subscribers and supports unsubscribe", () => {
    const bus = new PetEventBus()
    const got: PetEvent[] = []
    const off = bus.subscribe((e) => got.push(e))
    bus.emit({ source: "user", kind: "fed", at: 1 })
    off()
    bus.emit({ source: "user", kind: "played", at: 2 })
    expect(got.map((e) => e.kind)).toEqual(["fed"])
  })

  it("isolates a throwing listener from the others", () => {
    const bus = new PetEventBus()
    const got: string[] = []
    bus.subscribe(() => {
      throw new Error("bad")
    })
    bus.subscribe((e) => got.push(e.kind))
    expect(() => bus.emit({ source: "system", kind: "idle", at: 1 })).not.toThrow()
    expect(got).toEqual(["idle"])
  })

  it("clear() removes all listeners", () => {
    const bus = new PetEventBus()
    const fn = jest.fn()
    bus.subscribe(fn)
    bus.clear()
    bus.emit({ source: "system", kind: "idle", at: 1 })
    expect(fn).not.toHaveBeenCalled()
  })
})

describe("getPetEventBus / emitPetEvent", () => {
  it("returns a stable singleton", () => {
    expect(getPetEventBus()).toBe(getPetEventBus())
  })

  it("emitPetEvent stamps `at` when omitted", () => {
    const got: PetEvent[] = []
    getPetEventBus().subscribe((e) => got.push(e))
    emitPetEvent({ source: "user", kind: "petted" })
    expect(got).toHaveLength(1)
    expect(typeof got[0].at).toBe("number")
  })
})
