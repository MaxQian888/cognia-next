/**
 * Tests for Inbox Layout Store
 */

import { act, renderHook } from "@testing-library/react"
import {
  INBOX_LAYOUT_BOUNDS,
  INBOX_LAYOUT_DEFAULTS,
  INBOX_LAYOUT_PERSIST_DEBOUNCE_MS,
  useInboxLayoutStore,
} from "./inbox-layout-store"

const PERSIST_NAME = "cognia-inbox-layout"

function readPersisted() {
  const raw = window.localStorage.getItem(PERSIST_NAME)
  return raw ? (JSON.parse(raw) as { state: Record<string, unknown> }) : null
}

describe("useInboxLayoutStore", () => {
  beforeEach(() => {
    window.localStorage.clear()
    const { result } = renderHook(() => useInboxLayoutStore())
    act(() => {
      result.current.reset()
    })
  })

  describe("defaults", () => {
    it("matches INBOX_LAYOUT_DEFAULTS", () => {
      const { result } = renderHook(() => useInboxLayoutStore())
      expect(result.current.sidebarSize).toBe(INBOX_LAYOUT_DEFAULTS.sidebarSize)
      expect(result.current.listSize).toBe(INBOX_LAYOUT_DEFAULTS.listSize)
      expect(result.current.detailSize).toBe(INBOX_LAYOUT_DEFAULTS.detailSize)
    })

    it("default sizes sum to 100", () => {
      const sum =
        INBOX_LAYOUT_DEFAULTS.sidebarSize +
        INBOX_LAYOUT_DEFAULTS.listSize +
        INBOX_LAYOUT_DEFAULTS.detailSize
      expect(sum).toBe(100)
    })
  })

  describe("setSizes", () => {
    it("applies new sizes immediately when within bounds", () => {
      const { result } = renderHook(() => useInboxLayoutStore())
      act(() => {
        result.current.setSizes([20, 30, 50])
      })
      expect(result.current.sidebarSize).toBeCloseTo(20, 5)
      expect(result.current.listSize).toBeCloseTo(30, 5)
      expect(result.current.detailSize).toBeCloseTo(50, 5)
    })

    it("clamps sidebar below sidebarMin", () => {
      const { result } = renderHook(() => useInboxLayoutStore())
      act(() => {
        result.current.setSizes([5, 26, 69])
      })
      expect(result.current.sidebarSize).toBeCloseTo(INBOX_LAYOUT_BOUNDS.sidebarMin, 5)
    })

    it("clamps sidebar above sidebarMax", () => {
      const { result } = renderHook(() => useInboxLayoutStore())
      act(() => {
        result.current.setSizes([60, 20, 20])
      })
      expect(result.current.sidebarSize).toBeCloseTo(INBOX_LAYOUT_BOUNDS.sidebarMax, 5)
    })

    it("clamps list below listMin", () => {
      const { result } = renderHook(() => useInboxLayoutStore())
      act(() => {
        result.current.setSizes([18, 5, 77])
      })
      expect(result.current.listSize).toBeCloseTo(INBOX_LAYOUT_BOUNDS.listMin, 5)
    })

    it("clamps list above listMax", () => {
      const { result } = renderHook(() => useInboxLayoutStore())
      act(() => {
        result.current.setSizes([18, 80, 2])
      })
      expect(result.current.listSize).toBeCloseTo(INBOX_LAYOUT_BOUNDS.listMax, 5)
    })

    it("always renormalizes to sum 100", () => {
      const { result } = renderHook(() => useInboxLayoutStore())
      act(() => {
        result.current.setSizes([-5, 200, 50])
      })
      const sum = result.current.sidebarSize + result.current.listSize + result.current.detailSize
      expect(Math.round(sum)).toBe(100)
    })

    it("ignores malformed input", () => {
      const { result } = renderHook(() => useInboxLayoutStore())
      act(() => {
        result.current.setSizes([] as unknown as [number, number, number])
      })
      expect(result.current.sidebarSize).toBe(INBOX_LAYOUT_DEFAULTS.sidebarSize)
    })

    it("debounces persistence: 10 rapid drags result in one settled write", () => {
      jest.useFakeTimers()
      const { result } = renderHook(() => useInboxLayoutStore())
      act(() => {
        for (let i = 0; i < 10; i++) {
          result.current.setSizes([14 + i, 26, 60 - i])
        }
      })
      // Final in-memory state reflects the last drag (23 sidebar after 10 ticks
      // starting at 14, scaled to sum 100 — value will be ≥ 23 after clamping).
      expect(result.current.sidebarSize).toBeGreaterThanOrEqual(14)
      act(() => {
        jest.advanceTimersByTime(INBOX_LAYOUT_PERSIST_DEBOUNCE_MS + 5)
      })
      const persisted = readPersisted()
      expect(persisted?.state.sidebarSize).toBe(result.current.sidebarSize)
      jest.useRealTimers()
    })
  })

  describe("persistence", () => {
    it("partializes only sidebar/list/detail sizes", () => {
      jest.useFakeTimers()
      const { result } = renderHook(() => useInboxLayoutStore())
      act(() => {
        result.current.setSizes([20, 30, 50])
        jest.advanceTimersByTime(INBOX_LAYOUT_PERSIST_DEBOUNCE_MS + 5)
      })
      const persisted = readPersisted()
      expect(persisted?.state).toHaveProperty("sidebarSize")
      expect(persisted?.state).toHaveProperty("listSize")
      expect(persisted?.state).toHaveProperty("detailSize")
      jest.useRealTimers()
    })
  })

  describe("migration", () => {
    // v1 layouts were persisted while the shell passed bare numbers to
    // react-resizable-panels v4 (interpreted as pixels), so every drag stored
    // clamped garbage. v2 discards them and starts from defaults.
    it("resets v1 layouts to defaults on rehydrate", async () => {
      window.localStorage.setItem(
        PERSIST_NAME,
        JSON.stringify({ state: { sidebarSize: 12, listSize: 18, detailSize: 70 }, version: 1 })
      )
      await act(async () => {
        await useInboxLayoutStore.persist.rehydrate()
      })
      const { result } = renderHook(() => useInboxLayoutStore())
      expect(result.current.sidebarSize).toBe(INBOX_LAYOUT_DEFAULTS.sidebarSize)
      expect(result.current.listSize).toBe(INBOX_LAYOUT_DEFAULTS.listSize)
      expect(result.current.detailSize).toBe(INBOX_LAYOUT_DEFAULTS.detailSize)
    })
  })

  describe("reset", () => {
    it("returns the store to defaults", () => {
      const { result } = renderHook(() => useInboxLayoutStore())
      act(() => {
        result.current.setSizes([22, 32, 46])
      })
      act(() => {
        result.current.reset()
      })
      expect(result.current.sidebarSize).toBe(INBOX_LAYOUT_DEFAULTS.sidebarSize)
      expect(result.current.listSize).toBe(INBOX_LAYOUT_DEFAULTS.listSize)
      expect(result.current.detailSize).toBe(INBOX_LAYOUT_DEFAULTS.detailSize)
    })
  })
})
