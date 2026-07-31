import { renderHook, act } from "@testing-library/react"
import type { PetVisualState } from "@/types/pet"
import { QUIESCE_MS, QUIESCE_MS_LOW_POWER } from "@/lib/pet/animation/idle-quiescence"
import { useIdleQuiescence } from "./use-idle-quiescence"

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

describe("useIdleQuiescence", () => {
  it("quiesces after the delay while idle", () => {
    const { result } = renderHook(() => useIdleQuiescence("idle", null, false))
    expect(result.current).toBe(false)
    act(() => jest.advanceTimersByTime(QUIESCE_MS + 10))
    expect(result.current).toBe(true)
  })

  it("never quiesces a non-idle state", () => {
    const { result } = renderHook(() => useIdleQuiescence("thinking", null, false))
    act(() => jest.advanceTimersByTime(QUIESCE_MS + 10))
    expect(result.current).toBe(false)
  })

  it("never quiesces while a one-shot plays", () => {
    const { result } = renderHook(() => useIdleQuiescence("idle", "wave", false))
    act(() => jest.advanceTimersByTime(QUIESCE_MS + 10))
    expect(result.current).toBe(false)
  })

  it("resets when the state changes after quiescing", () => {
    const { result, rerender } = renderHook(
      ({ s }: { s: PetVisualState }) => useIdleQuiescence(s, null, false),
      { initialProps: { s: "idle" as PetVisualState } }
    )
    act(() => jest.advanceTimersByTime(QUIESCE_MS + 10))
    expect(result.current).toBe(true)
    rerender({ s: "thinking" })
    expect(result.current).toBe(false)
  })

  it("uses the shorter low-power delay", () => {
    const { result } = renderHook(() => useIdleQuiescence("idle", null, true))
    act(() => jest.advanceTimersByTime(QUIESCE_MS_LOW_POWER + 10))
    expect(result.current).toBe(true)
  })
})
