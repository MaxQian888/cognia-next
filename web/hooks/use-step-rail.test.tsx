import { act, renderHook } from "@testing-library/react"
import { useStepRail } from "./use-step-rail"

describe("useStepRail navigation", () => {
  it("starts at the first step", () => {
    const { result } = renderHook(() => useStepRail({ total: 6, reducedMotion: true }))
    expect(result.current.index).toBe(0)
    expect(result.current.atStart).toBe(true)
  })

  it("advances and rewinds", () => {
    const { result } = renderHook(() => useStepRail({ total: 6, reducedMotion: true }))
    act(() => result.current.next())
    expect(result.current.index).toBe(1)
    act(() => result.current.previous())
    expect(result.current.index).toBe(0)
  })

  it("clamps at both ends instead of wrapping", () => {
    const { result } = renderHook(() => useStepRail({ total: 3, reducedMotion: true }))
    act(() => result.current.previous())
    expect(result.current.index).toBe(0)
    act(() => result.current.goTo(99))
    expect(result.current.index).toBe(2)
    expect(result.current.atEnd).toBe(true)
  })

  it("jumps to a step directly, which is what the stepper controls do", () => {
    const { result } = renderHook(() => useStepRail({ total: 6, reducedMotion: true }))
    act(() => result.current.goTo(4))
    expect(result.current.index).toBe(4)
  })

  it("survives a degenerate single-step rail", () => {
    const { result } = renderHook(() => useStepRail({ total: 1, reducedMotion: true }))
    act(() => result.current.next())
    expect(result.current.index).toBe(0)
    expect(result.current.atEnd).toBe(true)
  })
})

describe("useStepRail autoplay", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it("advances on its own", () => {
    const { result } = renderHook(() => useStepRail({ total: 6, intervalMs: 1000 }))
    expect(result.current.playing).toBe(true)
    act(() => {
      jest.advanceTimersByTime(1000)
    })
    expect(result.current.index).toBe(1)
  })

  /**
   * Each tick schedules the next one from an effect, and effects only flush
   * when `act` exits — so a single long advance would move exactly one step.
   * Ticking one interval at a time is what actually exercises the loop.
   */
  function tick(times: number, intervalMs = 1000) {
    for (let i = 0; i < times; i += 1) {
      act(() => {
        jest.advanceTimersByTime(intervalMs)
      })
    }
  }

  it("halts at the approval step and stays there", () => {
    // The section exists to show that a human decision blocks the work; sliding
    // past that state would defeat it.
    const { result } = renderHook(() => useStepRail({ total: 6, stopAt: 3, intervalMs: 1000 }))
    tick(5)
    expect(result.current.index).toBe(3)
    expect(result.current.playing).toBe(false)
  })

  it("stops permanently once the reader takes over", () => {
    const { result } = renderHook(() => useStepRail({ total: 6, intervalMs: 1000 }))
    act(() => result.current.next())
    expect(result.current.playing).toBe(false)
    act(() => {
      jest.advanceTimersByTime(5000)
    })
    expect(result.current.index).toBe(1)
  })

  it("can be resumed from the play control", () => {
    const { result } = renderHook(() => useStepRail({ total: 6, intervalMs: 1000 }))
    act(() => result.current.next())
    act(() => result.current.toggle())
    expect(result.current.playing).toBe(true)
    act(() => {
      jest.advanceTimersByTime(1000)
    })
    expect(result.current.index).toBe(2)
  })

  it("never runs past the last step", () => {
    const { result } = renderHook(() => useStepRail({ total: 3, intervalMs: 1000 }))
    tick(8)
    expect(result.current.index).toBe(2)
  })

  it("does not autoplay under reduced motion", () => {
    const { result } = renderHook(() =>
      useStepRail({ total: 6, intervalMs: 1000, reducedMotion: true })
    )
    expect(result.current.playing).toBe(false)
    tick(8)
    expect(result.current.index).toBe(0)
  })

  it("stops playing if the reader turns reduced motion on mid-session", () => {
    const { result, rerender } = renderHook(
      ({ reduced }: { reduced: boolean }) =>
        useStepRail({ total: 6, intervalMs: 1000, reducedMotion: reduced }),
      { initialProps: { reduced: false } }
    )
    expect(result.current.playing).toBe(true)
    rerender({ reduced: true })
    expect(result.current.playing).toBe(false)
  })
})
