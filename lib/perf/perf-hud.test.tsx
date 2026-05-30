import { act, render, screen } from "@testing-library/react"
import { detectNativePlatform } from "@/lib/capacitor/_shared"
import { PERF_NAMESPACE } from "./perf-marker"
import { PerfHud, __test__ } from "./perf-hud"

jest.mock("@/lib/capacitor/_shared", () => ({
  // Keep the real module's other exports (makeDefaultLoader, withPlugin, …)
  // intact — companion-storage.ts calls makeDefaultLoader at module init via
  // the transitive lib/utils → lib/tauri import chain, so dropping it here
  // makes the whole suite fail to load. Only detectNativePlatform is stubbed.
  ...jest.requireActual("@/lib/capacitor/_shared"),
  detectNativePlatform: jest.fn(() => "web"),
}))

const mockDetectNativePlatform = detectNativePlatform as jest.Mock

// Default every test to the web runtime; mobile-gate tests opt in explicitly.
beforeEach(() => {
  mockDetectNativePlatform.mockReturnValue("web")
})

const {
  isHudEnabledForRuntime,
  aggregate,
  percentile,
  drainEntries,
  peek,
  MAX_ENTRIES_PER_NAME,
  HUD_LOCALSTORAGE_KEY,
  reset,
  ingest,
} = __test__

function makeEntry(name: string, duration: number) {
  return { name, duration, startTime: 0 }
}

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

  describe("drainEntries", () => {
    beforeEach(() => {
      reset()
    })

    it("copies namespaced entry durations into the bounded store", () => {
      const name = `${PERF_NAMESPACE}react:chat:message`
      const mutated = drainEntries([makeEntry(name, 4), makeEntry(name, 6)])
      expect(mutated).toBe(true)
      expect(peek(name).map((e) => e.duration)).toEqual([4, 6])
    })

    it("ignores entries outside the workflow-ai namespace", () => {
      const mutated = drainEntries([makeEntry("paint", 9), makeEntry("layout-shift", 3)])
      expect(mutated).toBe(false)
      expect(peek("paint")).toEqual([])
    })

    it("caps each name at MAX_ENTRIES_PER_NAME, keeping the newest", () => {
      const name = `${PERF_NAMESPACE}react:chat:list`
      const overflow = MAX_ENTRIES_PER_NAME + 5
      drainEntries(Array.from({ length: overflow }, (_, i) => makeEntry(name, i)))
      const kept = peek(name)
      expect(kept).toHaveLength(MAX_ENTRIES_PER_NAME)
      // The oldest 5 fell off the front; the newest entry is the last pushed.
      expect(kept[0].duration).toBe(5)
      expect(kept[kept.length - 1].duration).toBe(overflow - 1)
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

    it("returns false on the Capacitor mobile shell even in dev", () => {
      mockDetectNativePlatform.mockReturnValue("mobile")
      expect(isHudEnabledForRuntime()).toBe(false)
    })

    it("returns false on the mobile shell even when the production flag is set", () => {
      mockDetectNativePlatform.mockReturnValue("mobile")
      window.localStorage.setItem(HUD_LOCALSTORAGE_KEY, "1")
      withNodeEnv("production", () => {
        expect(isHudEnabledForRuntime()).toBe(false)
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

  it("returns null inside the Capacitor mobile shell", () => {
    mockDetectNativePlatform.mockReturnValue("mobile")
    const { container } = render(<PerfHud />)
    expect(container.querySelector("[data-testid='perf-hud']")).toBeNull()
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

  it("disable button hides the panel in-place without reloading", () => {
    // Guard against a regression to the old `window.location.reload()` close
    // behavior: if `disable()` ever calls reload again, this spy trips.
    const reload = jest.fn()
    let reloadStubbed = false
    try {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: { ...window.location, reload },
      })
      reloadStubbed = true
    } catch {
      // Some jsdom builds keep `location` non-configurable; the reload
      // assertion is skipped in that case, the unmount assertion still runs.
    }

    render(<PerfHud />)
    expect(screen.getByTestId("perf-hud")).toBeInTheDocument()

    act(() => {
      screen.getByTestId("perf-hud-disable").click()
    })

    // Panel unmounts reactively, the choice is persisted, and the page is
    // never reloaded.
    expect(screen.queryByTestId("perf-hud")).toBeNull()
    expect(window.localStorage.getItem(HUD_LOCALSTORAGE_KEY)).toBe("0")
    if (reloadStubbed) expect(reload).not.toHaveBeenCalled()
  })

  // The `try / catch` around `localStorage.setItem` inside `disable()` is
  // defensive — jsdom's Storage prototype doesn't expose its methods to
  // jest.spyOn, so the catch branch is exercised via production smoke
  // testing rather than a unit test.
})
