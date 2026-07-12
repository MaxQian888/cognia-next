import { wirePetSources, DEFAULT_PET_SOURCES, type PetSourceWire } from "./wire-sources"
import { wireHeartbeatSource } from "./sources/heartbeat-source"
import { wireSchedulerDueSource } from "./sources/scheduler-due-source"
import { wireBirthdaySource } from "./sources/birthday-source"

describe("wirePetSources", () => {
  it("wires every provided source and disposes them all", () => {
    const disposeA = jest.fn()
    const disposeB = jest.fn()
    const a: PetSourceWire = jest.fn(() => disposeA)
    const b: PetSourceWire = jest.fn(() => disposeB)
    const emit = jest.fn()

    const dispose = wirePetSources(emit, [a, b])
    expect(a).toHaveBeenCalledWith(emit)
    expect(b).toHaveBeenCalledWith(emit)

    dispose()
    expect(disposeA).toHaveBeenCalledTimes(1)
    expect(disposeB).toHaveBeenCalledTimes(1)
  })

  it("ships the full default source set", () => {
    expect(DEFAULT_PET_SOURCES).toHaveLength(10)
  })

  it("includes the birthday anniversary source", () => {
    expect(DEFAULT_PET_SOURCES).toContain(wireBirthdaySource)
  })

  it("includes the wall-clock heartbeat source", () => {
    expect(DEFAULT_PET_SOURCES).toContain(wireHeartbeatSource)
  })

  it("includes the native task-due reminder source", () => {
    expect(DEFAULT_PET_SOURCES).toContain(wireSchedulerDueSource)
  })
})
