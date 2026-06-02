import { wirePetSources, DEFAULT_PET_SOURCES, type PetSourceWire } from "./wire-sources"

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
    expect(DEFAULT_PET_SOURCES).toHaveLength(6)
  })
})
