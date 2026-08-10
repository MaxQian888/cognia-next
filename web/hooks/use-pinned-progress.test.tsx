/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"
import {
  PIN_MIN_WIDTH,
  indexFromScroll,
  scrollTopForIndex,
  usePinnedProgress,
} from "./use-pinned-progress"

describe("indexFromScroll", () => {
  const VIEWPORT = 800
  const HEIGHT = 800 * 6 // six steps, one screen each
  const STEPS = 6

  it("sits on the first step before the wrapper starts moving", () => {
    expect(indexFromScroll(0, HEIGHT, VIEWPORT, STEPS)).toBe(0)
  })

  it("reaches the last step at the end of the travel", () => {
    expect(indexFromScroll(-(HEIGHT - VIEWPORT), HEIGHT, VIEWPORT, STEPS)).toBe(STEPS - 1)
  })

  it("advances one step per equal share of the travel", () => {
    const travel = HEIGHT - VIEWPORT
    for (let step = 0; step < STEPS; step += 1) {
      const top = -(travel * (step / (STEPS - 1)))
      expect(indexFromScroll(top, HEIGHT, VIEWPORT, STEPS)).toBe(step)
    }
  })

  it("clamps past both ends rather than running off the array", () => {
    // Over-scroll (rubber banding on macOS) and scrolling back above the
    // section both produce out-of-range tops.
    expect(indexFromScroll(500, HEIGHT, VIEWPORT, STEPS)).toBe(0)
    expect(indexFromScroll(-99999, HEIGHT, VIEWPORT, STEPS)).toBe(STEPS - 1)
  })

  it("never returns a fractional or out-of-range index", () => {
    for (let top = 200; top > -HEIGHT; top -= 37) {
      const index = indexFromScroll(top, HEIGHT, VIEWPORT, STEPS)
      expect(Number.isInteger(index)).toBe(true)
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThanOrEqual(STEPS - 1)
    }
  })

  it("degenerates safely when there is nothing to scroll through", () => {
    // A wrapper shorter than the viewport has zero travel; dividing by it would
    // yield Infinity and then NaN.
    expect(indexFromScroll(-10, 400, VIEWPORT, STEPS)).toBe(0)
    expect(indexFromScroll(-10, HEIGHT, VIEWPORT, 1)).toBe(0)
    expect(indexFromScroll(-10, HEIGHT, VIEWPORT, 0)).toBe(0)
  })
})

describe("scrollTopForIndex", () => {
  const VIEWPORT = 800
  const HEIGHT = 800 * 6
  const STEPS = 6
  const DOC_TOP = 3200

  it("round-trips with indexFromScroll", () => {
    // The controls scroll rather than set state, so these two have to agree or
    // clicking step 4 would land the reader on step 3.
    for (let step = 0; step < STEPS; step += 1) {
      const scrollTop = scrollTopForIndex(DOC_TOP, HEIGHT, VIEWPORT, STEPS, step)
      const rectTop = DOC_TOP - scrollTop
      expect(indexFromScroll(rectTop, HEIGHT, VIEWPORT, STEPS)).toBe(step)
    }
  })

  it("puts the first step at the top of the wrapper", () => {
    expect(scrollTopForIndex(DOC_TOP, HEIGHT, VIEWPORT, STEPS, 0)).toBe(DOC_TOP)
  })

  it("clamps an out-of-range index", () => {
    expect(scrollTopForIndex(DOC_TOP, HEIGHT, VIEWPORT, STEPS, -5)).toBe(
      scrollTopForIndex(DOC_TOP, HEIGHT, VIEWPORT, STEPS, 0)
    )
    expect(scrollTopForIndex(DOC_TOP, HEIGHT, VIEWPORT, STEPS, 99)).toBe(
      scrollTopForIndex(DOC_TOP, HEIGHT, VIEWPORT, STEPS, STEPS - 1)
    )
  })

  it("degenerates safely with one step or a short wrapper", () => {
    expect(scrollTopForIndex(DOC_TOP, HEIGHT, VIEWPORT, 1, 0)).toBe(DOC_TOP)
    expect(scrollTopForIndex(DOC_TOP, 400, VIEWPORT, STEPS, 3)).toBe(DOC_TOP)
  })
})

describe("usePinnedProgress", () => {
  const originalMatchMedia = window.matchMedia

  function stubViewport(matches: boolean) {
    const listeners = new Set<() => void>()
    window.matchMedia = ((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
    return listeners
  }

  afterEach(() => {
    window.matchMedia = originalMatchMedia
  })

  it("never pins when disabled, whatever the viewport", () => {
    stubViewport(true)
    const { result } = renderHook(() => usePinnedProgress({ steps: 6, enabled: false }))
    // Spec §6.3: under reduced motion there is no pin, no scrub and no
    // autoplay — not a faster version of them.
    expect(result.current.pinned).toBe(false)
    expect(result.current.index).toBe(0)
  })

  it(`does not pin below ${PIN_MIN_WIDTH}px`, () => {
    stubViewport(false)
    const { result } = renderHook(() => usePinnedProgress({ steps: 6, enabled: true }))
    expect(result.current.pinned).toBe(false)
  })

  it("pins once the viewport is wide enough, regardless of its height", () => {
    stubViewport(true)
    const { result } = renderHook(() => usePinnedProgress({ steps: 6, enabled: true }))
    expect(result.current.pinned).toBe(true)
  })

  it("queries the adaptive desktop breakpoint without excluding tall screens", () => {
    const spy = jest.fn().mockReturnValue({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    })
    window.matchMedia = spy as unknown as typeof window.matchMedia
    renderHook(() => usePinnedProgress({ steps: 6, enabled: true }))
    expect(spy).toHaveBeenCalledWith(`(min-width: ${PIN_MIN_WIDTH}px) and (min-height: 640px)`)
  })

  it("unpins when the viewport narrows past the breakpoint", () => {
    let matches = true
    const listeners = new Set<() => void>()
    window.matchMedia = ((query: string) => ({
      get matches() {
        return matches
      },
      media: query,
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    })) as unknown as typeof window.matchMedia

    const { result } = renderHook(() => usePinnedProgress({ steps: 6, enabled: true }))
    expect(result.current.pinned).toBe(true)

    act(() => {
      matches = false
      for (const fn of listeners) fn()
    })
    expect(result.current.pinned).toBe(false)
    expect(result.current.index).toBe(0)
  })

  it("never intercepts the wheel or touch, so native scrolling keeps working", () => {
    stubViewport(true)
    const add = jest.spyOn(window, "addEventListener")
    renderHook(() => usePinnedProgress({ steps: 6, enabled: true }))
    const events = add.mock.calls.map(([type]) => type)
    expect(events).toContain("scroll")
    expect(events).not.toContain("wheel")
    expect(events).not.toContain("touchmove")
    add.mockRestore()
  })

  it("listens passively so scrolling is never blocked on the handler", () => {
    stubViewport(true)
    const add = jest.spyOn(window, "addEventListener")
    renderHook(() => usePinnedProgress({ steps: 6, enabled: true }))
    const scroll = add.mock.calls.find(([type]) => type === "scroll")
    expect(scroll?.[2]).toEqual({ passive: true })
    add.mockRestore()
  })

  it("unpins on a resize that never fires the media-query change event", () => {
    // Caught in the browser: viewport emulation resizes the page below the
    // breakpoint without dispatching `change`, and the component stayed pinned
    // — a tall travel wrapper and a 100dvh panel on a narrow screen. The
    // handlers must re-read `matches`, not trust the event.
    let matches = true
    const changeListeners = new Set<() => void>()
    window.matchMedia = ((query: string) => ({
      get matches() {
        return matches
      },
      media: query,
      addEventListener: (_: string, fn: () => void) => changeListeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => changeListeners.delete(fn),
    })) as unknown as typeof window.matchMedia

    const frames: FrameRequestCallback[] = []
    jest.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frames.push(cb)
      return frames.length
    })

    const { result } = renderHook(() => usePinnedProgress({ steps: 6, enabled: true }))
    expect(result.current.pinned).toBe(true)

    act(() => {
      matches = false
      // Deliberately do NOT call the change listeners.
      window.dispatchEvent(new Event("resize"))
      for (const frame of frames.splice(0)) frame(0)
    })

    expect(result.current.pinned).toBe(false)
    expect(changeListeners.size).toBeGreaterThan(0) // the event path is still wired
    jest.restoreAllMocks()
  })

  it("no-ops where matchMedia does not exist", () => {
    // Not hypothetical for a static export: the hook ships in a bundle that
    // also has to survive older embedded webviews, and throwing here would
    // take the whole section down rather than degrading it.
    // @ts-expect-error deliberately removing the API
    window.matchMedia = undefined
    const { result } = renderHook(() => usePinnedProgress({ steps: 6, enabled: true }))
    expect(result.current.pinned).toBe(false)
  })

  it("coalesces a burst of scroll events into one measurement", () => {
    stubViewport(true)
    let pending = 0
    jest.spyOn(window, "requestAnimationFrame").mockImplementation(() => {
      pending += 1
      return pending
    })
    renderHook(() => usePinnedProgress({ steps: 6, enabled: true }))
    const before = pending
    act(() => {
      window.dispatchEvent(new Event("scroll"))
      window.dispatchEvent(new Event("scroll"))
      window.dispatchEvent(new Event("scroll"))
    })
    // Three events, one frame: without the guard each event would force its own
    // layout via getBoundingClientRect.
    expect(pending - before).toBe(1)
    jest.restoreAllMocks()
  })

  it("cancels a frame still in flight at unmount", () => {
    stubViewport(true)
    jest.spyOn(window, "requestAnimationFrame").mockReturnValue(7)
    const cancel = jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {})
    const { unmount } = renderHook(() => usePinnedProgress({ steps: 6, enabled: true }))
    act(() => {
      window.dispatchEvent(new Event("scroll"))
    })
    unmount()
    expect(cancel).toHaveBeenCalledWith(7)
    jest.restoreAllMocks()
  })

  it("removes every listener on unmount", () => {
    stubViewport(true)
    const remove = jest.spyOn(window, "removeEventListener")
    const { unmount } = renderHook(() => usePinnedProgress({ steps: 6, enabled: true }))
    unmount()
    const events = remove.mock.calls.map(([type]) => type)
    expect(events).toContain("scroll")
    expect(events).toContain("resize")
    remove.mockRestore()
  })

  it("does nothing when there is no wrapper to measure", () => {
    stubViewport(true)
    const { result } = renderHook(() => usePinnedProgress({ steps: 6, enabled: true }))
    // `scrollToIndex` is wired to the controls, which exist before the ref is
    // attached on the very first paint.
    expect(() => result.current.scrollToIndex(3)).not.toThrow()
  })

  it("scrolls rather than setting state when a control asks for a step", () => {
    stubViewport(true)
    const scrollTo = jest.fn()
    Object.defineProperty(window, "scrollTo", { value: scrollTo, writable: true })

    const { result } = renderHook(() => usePinnedProgress({ steps: 6, enabled: true }))
    act(() => {
      const node = document.createElement("div")
      node.getBoundingClientRect = () => ({ top: 0, height: 4800 }) as DOMRect
      result.current.wrapperRef.current = node
    })
    result.current.scrollToIndex(2)

    // Scroll position stays the single source of truth: setting index directly
    // would desynchronise the rail from the page on the next scroll event.
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }))
  })
})
