import { act, render, screen } from "@testing-library/react"
import { PERF_NAMESPACE } from "./perf-marker"
import { PerfHud, __test__ } from "./perf-hud"

const { isHudEnabledForRuntime, aggregate, percentile, HUD_LOCALSTORAGE_KEY, reset, ingest } =
  __test__

// jsdom's PerformanceObserver is non-standard; the HUD's observer is started
// lazily and the in-memory store is the source of truth for the table. Tests
// drive the store directly via the test-only `ingest()` hook.

function withNodeEnv(value: string, fn: () => void): void {
  const proc = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process
  const previous = proc?.env?.NODE_ENV
  if (proc?.env) proc.env.NODE_ENV = value
  try {
    fn()
  } finally {
    if (proc?.env) proc.env.NODE_ENV = previous
  }
}

describe("PerfHud helpers", () => {
  describe("percentile", () => {
    it("returns 0 for empty input", () => {
      expect(percentile([], 0.5)).toBe(0)
    })
    it("returns p50 for an ordered list", () => {
      expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3)
    })
    it("returns p95 for an ordered list", () => {
      expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10)
    })
  })

  describe("aggregate", () => {
    it("strips the workflow-ai: namespace from display names", () => {
      const map = new Map<string, Array<{ duration: number; startTime: number }>>()
      map.set(`${PERF_NAMESPACE}react:chat:list`, [
        { duration: 1, startTime: 0 },
        { duration: 5, startTime: 0 },
      ])
      const stats = aggregate(map)
      expect(stats).toHaveLength(1)
      expect(stats[0].displayName).toBe("react:chat:list")
      expect(stats[0].count).toBe(2)
    })

    it("sorts rows by display name", () => {
      const map = new Map<string, Array<{ duration: number; startTime: number }>>()
      map.set(`${PERF_NAMESPACE}b`, [{ duration: 1, startTime: 0 }])
      map.set(`${PERF_NAMESPACE}a`, [{ duration: 1, startTime: 0 }])
      const stats = aggregate(map)
      expect(stats.map((s) => s.displayName)).toEqual(["a", "b"])
    })

    it("ignores empty entry slots", () => {
      const map = new Map<string, Array<{ duration: number; startTime: number }>>()
      map.set(`${PERF_NAMESPACE}empty`, [])
      const stats = aggregate(map)
      expect(stats).toHaveLength(0)
    })
  })

  describe("isHudEnabledForRuntime", () => {
    afterEach(() => {
      try {
        window.localStorage.removeItem(HUD_LOCALSTORAGE_KEY)
      } catch {
        // ignore
      }
    })

    it("returns true outside production", () => {
      expect(isHudEnabledForRuntime()).toBe(true)
    })

    it("returns false in production when the flag is missing", () => {
      withNodeEnv("production", () => {
        expect(isHudEnabledForRuntime()).toBe(false)
      })
    })

    it("returns true in production when localStorage flag is '1'", () => {
      window.localStorage.setItem(HUD_LOCALSTORAGE_KEY, "1")
      withNodeEnv("production", () => {
        expect(isHudEnabledForRuntime()).toBe(true)
      })
    })

    // The `try / catch` around `localStorage.getItem` is defensive — jsdom's
    // Storage prototype doesn't expose its methods to jest.spyOn, so the
    // catch branch is exercised via production smoke testing rather than a
    // unit test. The other branches in `isHudEnabledForRuntime` are covered
    // above.
  })
})

describe("<PerfHud>", () => {
  beforeEach(() => {
    reset()
  })

  afterEach(() => {
    try {
      window.localStorage.removeItem(HUD_LOCALSTORAGE_KEY)
    } catch {
      // ignore
    }
  })

  it("returns null when the HUD is disabled (production + no flag)", () => {
    withNodeEnv("production", () => {
      const { container } = render(<PerfHud />)
      expect(container.querySelector("[data-testid='perf-hud']")).toBeNull()
    })
  })

  it("renders the panel in dev / test", () => {
    render(<PerfHud />)
    expect(screen.getByTestId("perf-hud")).toBeInTheDocument()
    expect(screen.getByTestId("perf-hud-empty")).toBeInTheDocument()
  })

  it("renders ingested entries as aggregated rows", () => {
    render(<PerfHud />)
    act(() => {
      ingest(`${PERF_NAMESPACE}react:chat:list`, 5)
      ingest(`${PERF_NAMESPACE}react:chat:list`, 25)
    })
    const row = screen.getByTestId("perf-hud-row-react:chat:list")
    expect(row).toBeInTheDocument()
    expect(row.textContent).toContain("react:chat:list")
  })

  it("clear button empties the entry table", () => {
    render(<PerfHud />)
    act(() => {
      ingest(`${PERF_NAMESPACE}react:chat:list`, 5)
    })
    expect(screen.queryByTestId("perf-hud-row-react:chat:list")).not.toBeNull()
    act(() => {
      screen.getByTestId("perf-hud-clear").click()
    })
    expect(screen.queryByTestId("perf-hud-row-react:chat:list")).toBeNull()
    expect(screen.getByTestId("perf-hud-empty")).toBeInTheDocument()
  })

  // jsdom marks `window.location.reload` non-configurable, so the disable-
  // button click can't be asserted on `reload`-call mocks. We assert the
  // observable side effect — `localStorage.setItem("cogniaPerfHud", "0")` —
  // and trust that `window.location.reload()` runs in the real browser
  // environment.
  it("disable button writes '0' to localStorage", () => {
    render(<PerfHud />)
    // Stub reload so clicking doesn't crash the jsdom Location.
    try {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: { ...window.location, reload: jest.fn() },
      })
    } catch {
      // Some jsdom builds keep `location` itself non-configurable; the
      // subsequent click will throw a navigation error, which we swallow
      // because the assertion below is on the localStorage side effect.
    }
    try {
      act(() => {
        screen.getByTestId("perf-hud-disable").click()
      })
    } catch {
      // ignore jsdom navigation noise
    }
    expect(window.localStorage.getItem(HUD_LOCALSTORAGE_KEY)).toBe("0")
  })

  // The `try / catch` around `localStorage.setItem` inside `disable()` is
  // defensive — jsdom's Storage prototype doesn't expose its methods to
  // jest.spyOn, so the catch branch is exercised via production smoke
  // testing rather than a unit test.
})
