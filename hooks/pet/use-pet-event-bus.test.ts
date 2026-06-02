import { renderHook } from "@testing-library/react"

const offController = jest.fn()
const offSources = jest.fn()
const subscribe = jest.fn(() => offController)
const wirePetSources = jest.fn(() => offSources)

jest.mock("@/lib/pet/events/pet-event-bus", () => ({
  getPetEventBus: () => ({ subscribe }),
}))
jest.mock("@/lib/pet/events/wire-sources", () => ({ wirePetSources: () => wirePetSources() }))
jest.mock("@/lib/pet/runtime/pet-controller", () => ({ handlePetEvent: jest.fn() }))

import { usePetEventBus } from "./use-pet-event-bus"

beforeEach(() => {
  offController.mockClear()
  offSources.mockClear()
  subscribe.mockClear()
  wirePetSources.mockClear()
})

describe("usePetEventBus", () => {
  it("does nothing when disabled", () => {
    renderHook(() => usePetEventBus(false))
    expect(subscribe).not.toHaveBeenCalled()
    expect(wirePetSources).not.toHaveBeenCalled()
  })

  it("wires the controller + sources when enabled and tears down on unmount", () => {
    const { unmount } = renderHook(() => usePetEventBus(true))
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(wirePetSources).toHaveBeenCalledTimes(1)
    unmount()
    expect(offController).toHaveBeenCalledTimes(1)
    expect(offSources).toHaveBeenCalledTimes(1)
  })
})
