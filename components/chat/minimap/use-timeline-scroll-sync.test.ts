import { renderHook, act } from "@testing-library/react"
import type { Virtualizer } from "@tanstack/react-virtual"
import {
  computeTimelineGeometry,
  computeTurnPositions,
  useTimelineScrollSync,
} from "./use-timeline-scroll-sync"
import type { TimelineTurn } from "./use-timeline-turns"

describe("computeTimelineGeometry", () => {
  // ADR-0127: the hook and this pure function share one implementation; the
  // hook passes its cached positions, callers without a cache omit them.
  it("computeTurnPositions clamps to 0..1 and zeroes on a non-positive total", () => {
    expect(computeTurnPositions([0, 250, 500, 1000, 1500], 1000)).toEqual([0, 0.25, 0.5, 1, 1])
    expect(computeTurnPositions([0, 10], 0)).toEqual([0, 0])
  })

  it("accepts precomputed positions and passes them through untouched", () => {
    const positions = [0.1, 0.9]
    const g = computeTimelineGeometry({
      scrollTop: 0,
      clientHeight: 100,
      total: 1000,
      starts: [100, 900],
      positions,
    })
    expect(g.positions).toBe(positions)
    expect(g.activeIndex).toBe(0)
  })

  it("maps starts to fractions of total", () => {
    const g = computeTimelineGeometry({
      scrollTop: 0,
      clientHeight: 100,
      total: 1000,
      starts: [0, 250, 500, 1000],
    })
    expect(g.positions).toEqual([0, 0.25, 0.5, 1])
  })

  it("computes the viewport window as fractions", () => {
    const g = computeTimelineGeometry({
      scrollTop: 200,
      clientHeight: 100,
      total: 1000,
      starts: [0],
    })
    expect(g.viewportTop).toBeCloseTo(0.2)
    expect(g.viewportHeight).toBeCloseTo(0.1)
  })

  it("marks the active turn as the last one at/above the probe", () => {
    // probe = scrollTop(400) + min(clientHeight*0.3=30,120) = 430
    const g = computeTimelineGeometry({
      scrollTop: 400,
      clientHeight: 100,
      total: 1000,
      starts: [0, 300, 420, 700],
    })
    expect(g.activeIndex).toBe(2)
  })

  it("clamps fractions into [0,1]", () => {
    const g = computeTimelineGeometry({
      scrollTop: -50,
      clientHeight: 2000,
      total: 1000,
      starts: [-100, 1500],
    })
    expect(g.positions).toEqual([0, 1])
    expect(g.viewportTop).toBe(0)
    expect(g.viewportHeight).toBe(1)
  })

  it("degrades gracefully when total is zero", () => {
    const g = computeTimelineGeometry({ scrollTop: 0, clientHeight: 0, total: 0, starts: [0, 0] })
    expect(g.positions).toEqual([0, 0])
    expect(g.activeIndex).toBe(0)
  })

  it("returns -1 active when there are no turns", () => {
    const g = computeTimelineGeometry({ scrollTop: 0, clientHeight: 100, total: 1000, starts: [] })
    expect(g.activeIndex).toBe(-1)
  })
})

function turn(id: string, index: number): TimelineTurn {
  return { id, index, label: id, preview: id, replyCount: 0, messageIds: [id] }
}

describe("useTimelineScrollSync — virtualized fallback divisor", () => {
  it("estimates an unmeasured row by index/itemCount, not index/turnCount", () => {
    // turn.index (4) indexes the full message list; the divisor must be the
    // item COUNT (10), giving 0.4 — dividing by turns.length (1) would overshoot
    // to >1 and clamp the marker to the bottom.
    const virtualizer = {
      getTotalSize: () => 1000,
      measurementsCache: [],
      getOffsetForIndex: () => undefined,
      options: { count: 10 },
    } as unknown as Virtualizer<HTMLDivElement, Element>
    const scrollRef = { current: document.createElement("div") }
    // Stable `turns` ref — the real component feeds a memoized array; a fresh
    // literal each render would churn the memoized callbacks into a loop.
    const turns = [turn("u1", 4)]
    const { result } = renderHook(() =>
      useTimelineScrollSync({ scrollRef, virtualizer, virtualize: true, turns })
    )
    expect(result.current.positions[0]).toBeCloseTo(0.4)
  })
})

describe("useTimelineScrollSync — virtualized scroll updates", () => {
  let rafQueue: FrameRequestCallback[]

  beforeEach(() => {
    rafQueue = []
    jest
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        rafQueue.push(callback)
        return rafQueue.length
      })
    jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {})
  })

  afterEach(() => jest.restoreAllMocks())

  it("reuses measured marker positions during plain scroll", () => {
    const container = document.createElement("div")
    Object.defineProperties(container, {
      clientHeight: { value: 100, configurable: true },
      scrollTop: { value: 0, writable: true, configurable: true },
    })
    const virtualizer = {
      getTotalSize: () => 1_000,
      measurementsCache: [{ start: 0 }, { start: 500 }],
      getOffsetForIndex: () => undefined,
      options: { count: 2 },
    } as unknown as Virtualizer<HTMLDivElement, Element>
    const turns = [turn("a", 0), turn("b", 1)]
    const scrollRef = { current: container }
    const { result } = renderHook(() =>
      useTimelineScrollSync({
        scrollRef,
        virtualizer,
        virtualize: true,
        turns,
      })
    )
    act(() => {
      const queued = rafQueue
      rafQueue = []
      queued.forEach((callback) => callback(0))
    })
    const initialPositions = result.current.positions

    act(() => {
      container.scrollTop = 500
      container.dispatchEvent(new Event("scroll"))
      const queued = rafQueue
      rafQueue = []
      queued.forEach((callback) => callback(0))
    })

    expect(result.current.positions).toBe(initialPositions)
    expect(result.current.viewportTop).toBeCloseTo(0.5)
    expect(result.current.activeIndex).toBe(1)
  })
})

describe("useTimelineScrollSync — the live tail counts toward the extent", () => {
  let rafQueue: FrameRequestCallback[]

  beforeEach(() => {
    rafQueue = []
    jest
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        rafQueue.push(callback)
        return rafQueue.length
      })
    jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {})
  })

  afterEach(() => jest.restoreAllMocks())

  function renderWithTail(getTailSize?: () => number) {
    const container = document.createElement("div")
    Object.defineProperties(container, {
      clientHeight: { value: 100, configurable: true },
      scrollTop: { value: 0, writable: true, configurable: true },
    })
    const virtualizer = {
      getTotalSize: () => 1_000,
      measurementsCache: [{ start: 0 }, { start: 500 }],
      getOffsetForIndex: () => undefined,
      options: { count: 2 },
    } as unknown as Virtualizer<HTMLDivElement, Element>
    // Hoisted, like every other case here: `turns` is an effect dependency, so
    // a literal inside the render callback re-runs the remeasure every commit
    // and spins the rAF loop until the worker dies.
    const turns = [turn("a", 0), turn("b", 1)]
    const scrollRef = { current: container }
    const rendered = renderHook(() =>
      useTimelineScrollSync({
        scrollRef,
        virtualizer,
        virtualize: true,
        turns,
        getTailSize,
      })
    )
    act(() => {
      const queued = rafQueue
      rafQueue = []
      queued.forEach((callback) => callback(0))
    })
    return rendered
  }

  it("normalises markers against the windowed rows plus the tail region", () => {
    // ADR-0138 — the streamed row and the thinking indicator render in document
    // flow BELOW the virtual container, so `getTotalSize()` alone under-reports
    // the scrollable extent for the whole of every turn and pushes every marker
    // toward the foot.
    const withoutTail = renderWithTail()
    const withTail = renderWithTail(() => 1_000)

    // Turn "b" starts at 500: half way through 1000, a quarter through 2000.
    expect(withoutTail.result.current.positions[1]).toBeCloseTo(0.5)
    expect(withTail.result.current.positions[1]).toBeCloseTo(0.25)
  })

  it("treats an absent getter as no tail", () => {
    const absent = renderWithTail()
    const zero = renderWithTail(() => 0)
    expect(absent.result.current.positions).toEqual(zero.result.current.positions)
  })
})

describe("useTimelineScrollSync — document-flow measurement caching", () => {
  let rafQueue: FrameRequestCallback[]
  beforeEach(() => {
    rafQueue = []
    jest
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb: FrameRequestCallback) => rafQueue.push(cb))
    jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {})
  })
  afterEach(() => jest.restoreAllMocks())
  const flushRaf = () =>
    act(() => {
      const q = rafQueue
      rafQueue = []
      q.forEach((cb) => cb(0))
    })

  function makeContainer() {
    const node = document.createElement("div")
    const container = document.createElement("div")
    const querySelector = jest.fn(() => node)
    Object.defineProperty(container, "querySelector", { value: querySelector })
    return { container, querySelector }
  }

  it("does not re-run getBoundingClientRect measurement on plain scroll", () => {
    const { container, querySelector } = makeContainer()
    const scrollRef = { current: container }
    const turns = [turn("a", 0), turn("b", 2)]
    renderHook(() =>
      useTimelineScrollSync({ scrollRef, virtualizer: null, virtualize: false, turns })
    )
    // Drain the mount's scheduled remeasure, then snapshot the baseline.
    flushRaf()
    const afterMount = querySelector.mock.calls.length
    expect(afterMount).toBeGreaterThan(0)
    // Plain scroll reuses the cached starts — no further DOM measurement.
    act(() => container.dispatchEvent(new Event("scroll")))
    flushRaf()
    expect(querySelector.mock.calls.length).toBe(afterMount)
  })

  it("remeasures when the turn set changes", () => {
    const { container, querySelector } = makeContainer()
    const scrollRef = { current: container }
    const { rerender } = renderHook(
      ({ turns }) =>
        useTimelineScrollSync({ scrollRef, virtualizer: null, virtualize: false, turns }),
      { initialProps: { turns: [turn("a", 0)] } }
    )
    const afterMount = querySelector.mock.calls.length
    rerender({ turns: [turn("a", 0), turn("b", 2)] })
    flushRaf()
    expect(querySelector.mock.calls.length).toBeGreaterThan(afterMount)
  })
})
