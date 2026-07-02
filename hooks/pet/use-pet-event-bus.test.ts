import { renderHook } from "@testing-library/react"

const offController = jest.fn()
const offSources = jest.fn()
const subscribe = jest.fn(() => offController)
const wirePetSources = jest.fn<unknown, [unknown, unknown]>(() => offSources)
const twinSourceWire = jest.fn(() => () => {})
const wireTwinActivitySource = jest.fn((_twinId: string) => twinSourceWire)

// `jest.mock` factories are hoisted above every other statement in this file
// (including the transpiled import of the module under test), so a factory
// can only reference literals — any outer `const` it closes over would still
// be in its temporal dead zone at invocation time. Duplicate the literal
// below for assertions instead of sharing a reference with the factory.
const DEFAULT_PET_SOURCES_LITERAL: unknown[] = ["chat-source", "goal-source"]

jest.mock("@/lib/pet/events/pet-event-bus", () => ({
  getPetEventBus: () => ({ subscribe }),
}))
jest.mock("@/lib/pet/events/wire-sources", () => ({
  wirePetSources: (emit: unknown, sources: unknown) => wirePetSources(emit, sources),
  DEFAULT_PET_SOURCES: ["chat-source", "goal-source"],
}))
jest.mock("@/lib/pet/events/sources/twin-activity-source", () => ({
  wireTwinActivitySource: (twinId: string) => wireTwinActivitySource(twinId),
}))
jest.mock("@/lib/pet/runtime/pet-controller", () => ({ handlePetEvent: jest.fn() }))

import { usePetEventBus } from "./use-pet-event-bus"

beforeEach(() => {
  offController.mockClear()
  offSources.mockClear()
  subscribe.mockClear()
  wirePetSources.mockClear()
  wireTwinActivitySource.mockClear()
})

describe("usePetEventBus", () => {
  it("does nothing when disabled", () => {
    renderHook(() => usePetEventBus(false))
    expect(subscribe).not.toHaveBeenCalled()
    expect(wirePetSources).not.toHaveBeenCalled()
  })

  it("wires the controller + default sources when enabled and tears down on unmount", () => {
    const { unmount } = renderHook(() => usePetEventBus(true))
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(wirePetSources).toHaveBeenCalledWith(undefined, undefined)
    expect(wireTwinActivitySource).not.toHaveBeenCalled()
    unmount()
    expect(offController).toHaveBeenCalledTimes(1)
    expect(offSources).toHaveBeenCalledTimes(1)
  })

  it("appends the twin-activity source when twinAwareness is enabled with a twinId", () => {
    renderHook(() => usePetEventBus(true, { enabled: true, twinId: "tw_1" }))
    expect(wireTwinActivitySource).toHaveBeenCalledWith("tw_1")
    expect(wirePetSources).toHaveBeenCalledWith(undefined, [
      ...DEFAULT_PET_SOURCES_LITERAL,
      twinSourceWire,
    ])
  })

  it("ignores twinAwareness when disabled or missing a twinId", () => {
    renderHook(() => usePetEventBus(true, { enabled: false, twinId: "tw_1" }))
    expect(wireTwinActivitySource).not.toHaveBeenCalled()
    expect(wirePetSources).toHaveBeenCalledWith(undefined, undefined)

    wirePetSources.mockClear()
    renderHook(() => usePetEventBus(true, { enabled: true, twinId: null }))
    expect(wireTwinActivitySource).not.toHaveBeenCalled()
    expect(wirePetSources).toHaveBeenCalledWith(undefined, undefined)
  })

  it("rewires the sources when the watched twinId changes", () => {
    const { rerender } = renderHook(
      ({ twinId }) => usePetEventBus(true, { enabled: true, twinId }),
      { initialProps: { twinId: "tw_1" } }
    )
    expect(wirePetSources).toHaveBeenCalledTimes(1)
    rerender({ twinId: "tw_2" })
    expect(offSources).toHaveBeenCalledTimes(1) // old wiring torn down
    expect(wirePetSources).toHaveBeenCalledTimes(2)
    expect(wireTwinActivitySource).toHaveBeenLastCalledWith("tw_2")
  })
})
