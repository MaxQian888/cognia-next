import { act, renderHook } from "@testing-library/react"
import { usePetAnimationState } from "./use-pet-animation-state"
import { usePetStore } from "@/stores/pet/pet-store"

function resetStore() {
  usePetStore.setState({ visualState: "idle", oneShotQueue: [], bubble: null })
}

beforeEach(() => {
  jest.useFakeTimers()
  resetStore()
})

afterEach(() => {
  jest.runOnlyPendingTimers()
  jest.useRealTimers()
})

describe("usePetAnimationState", () => {
  it("returns the resting visual state from the store", () => {
    act(() => usePetStore.setState({ visualState: "thinking" }))
    const { result } = renderHook(() => usePetAnimationState(false))
    expect(result.current.state).toBe("thinking")
    expect(result.current.oneShot).toBeNull()
  })

  it("plays a queued one-shot then returns to rest", () => {
    const { result } = renderHook(() => usePetAnimationState(false))
    act(() => usePetStore.getState().enqueueOneShot("wave"))
    expect(result.current.oneShot).toBe("wave")
    // wave lasts 0.9s
    act(() => jest.advanceTimersByTime(1000))
    expect(result.current.oneShot).toBeNull()
  })

  it("plays queued one-shots one at a time", () => {
    const { result } = renderHook(() => usePetAnimationState(false))
    act(() => {
      usePetStore.getState().enqueueOneShot("wave")
      usePetStore.getState().enqueueOneShot("happy")
    })
    expect(result.current.oneShot).toBe("wave")
    act(() => jest.advanceTimersByTime(1000))
    expect(result.current.oneShot).toBe("happy")
    act(() => jest.advanceTimersByTime(1000))
    expect(result.current.oneShot).toBeNull()
  })

  it("drains the queue without playing under reduced motion", () => {
    const { result } = renderHook(() => usePetAnimationState(true))
    act(() => {
      usePetStore.getState().enqueueOneShot("wave")
      usePetStore.getState().enqueueOneShot("happy")
    })
    expect(result.current.oneShot).toBeNull()
    expect(usePetStore.getState().oneShotQueue).toEqual([])
  })
})
