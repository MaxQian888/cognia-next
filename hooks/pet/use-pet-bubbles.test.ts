import { renderHook, act } from "@testing-library/react"
import { usePetBubbles } from "./use-pet-bubbles"
import {
  getPetEventBus,
  emitPetEvent,
  __resetPetEventBusForTesting,
} from "@/lib/pet/events/pet-event-bus"
import { __resetProactiveClaims, claimKinds } from "@/lib/pet/llm/proactive/claim-registry"
import { usePetStore } from "@/stores/pet/pet-store"

beforeEach(() => {
  jest.useFakeTimers()
  __resetPetEventBusForTesting()
  usePetStore.setState({ bubble: null })
})

afterEach(() => {
  jest.runOnlyPendingTimers()
  jest.useRealTimers()
  __resetProactiveClaims()
})

describe("usePetBubbles", () => {
  it("shows a bubble for a templated event then clears it", () => {
    renderHook(() => usePetBubbles(true))
    act(() => emitPetEvent({ source: "user", kind: "fed", at: 5 }))
    expect(usePetStore.getState().bubble).not.toBeNull()
    act(() => jest.advanceTimersByTime(4000))
    expect(usePetStore.getState().bubble).toBeNull()
  })

  it("ignores silent kinds", () => {
    renderHook(() => usePetBubbles(true))
    act(() => emitPetEvent({ source: "system", kind: "idle", at: 1 }))
    expect(usePetStore.getState().bubble).toBeNull()
  })

  it("does nothing when disabled", () => {
    renderHook(() => usePetBubbles(false))
    act(() => emitPetEvent({ source: "user", kind: "fed", at: 1 }))
    expect(usePetStore.getState().bubble).toBeNull()
    expect(getPetEventBus()).toBeDefined()
  })

  it("stays silent for kinds claimed by the proactive engine", () => {
    renderHook(() => usePetBubbles(true))
    claimKinds(["levelUp"])
    act(() => emitPetEvent({ source: "system", kind: "levelUp", at: 9 }))
    expect(usePetStore.getState().bubble).toBeNull()
    // Unclaimed kinds still bubble exactly as before.
    act(() => emitPetEvent({ source: "system", kind: "evolved", at: 9 }))
    expect(usePetStore.getState().bubble).not.toBeNull()
  })
})
