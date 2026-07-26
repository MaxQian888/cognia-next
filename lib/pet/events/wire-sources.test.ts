import { wirePetSources, DEFAULT_PET_SOURCES, type PetSourceWire } from "./wire-sources"
import { wireHeartbeatSource } from "./sources/heartbeat-source"
import { wireSchedulerDueSource } from "./sources/scheduler-due-source"
import { wireBirthdaySource } from "./sources/birthday-source"
import { wireAttentionSource } from "./sources/attention-source"
import { wireGitSource } from "./sources/git-source"
import { wireBackgroundTaskSource } from "./sources/background-task-source"
import { wireCaptureSource } from "./sources/capture-source"

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
    expect(DEFAULT_PET_SOURCES).toHaveLength(14)
  })

  it("includes the unified attention source", () => {
    expect(DEFAULT_PET_SOURCES).toContain(wireAttentionSource)
  })

  it("includes source-control, background-task, and capture linkages", () => {
    expect(DEFAULT_PET_SOURCES).toContain(wireGitSource)
    expect(DEFAULT_PET_SOURCES).toContain(wireBackgroundTaskSource)
    expect(DEFAULT_PET_SOURCES).toContain(wireCaptureSource)
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
