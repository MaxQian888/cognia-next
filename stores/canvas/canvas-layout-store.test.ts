/**
 * Tests for Canvas Layout Store
 */

import { act, renderHook } from "@testing-library/react"
import {
  CANVAS_LAYOUT_DEFAULTS,
  CANVAS_LAYOUT_PERSIST_DEBOUNCE_MS,
  useCanvasLayoutStore,
  type CanvasRightTab,
} from "./canvas-layout-store"

const PERSIST_NAME = "cognia-canvas-layout"

function readPersisted() {
  const raw = window.localStorage.getItem(PERSIST_NAME)
  return raw ? (JSON.parse(raw) as { state: Record<string, unknown> }) : null
}

describe("useCanvasLayoutStore", () => {
  beforeEach(() => {
    window.localStorage.clear()
    const { result } = renderHook(() => useCanvasLayoutStore())
    act(() => {
      result.current.resetLayout()
    })
  })

  describe("defaults", () => {
    it("matches CANVAS_LAYOUT_DEFAULTS", () => {
      const { result } = renderHook(() => useCanvasLayoutStore())
      expect(result.current.leftSize).toBe(CANVAS_LAYOUT_DEFAULTS.leftSize)
      expect(result.current.centerSize).toBe(CANVAS_LAYOUT_DEFAULTS.centerSize)
      expect(result.current.rightSize).toBe(CANVAS_LAYOUT_DEFAULTS.rightSize)
      expect(result.current.leftCollapsed).toBe(false)
      expect(result.current.rightCollapsed).toBe(false)
      expect(result.current.activeRightTab).toBe("suggestions")
      expect(result.current.mobileLeftOpen).toBe(false)
      expect(result.current.mobileRightOpen).toBe(false)
    })
  })

  describe("setSizes", () => {
    it("applies new sizes immediately", () => {
      const { result } = renderHook(() => useCanvasLayoutStore())
      act(() => {
        result.current.setSizes([15, 60, 25])
      })
      expect(result.current.leftSize).toBe(15)
      expect(result.current.centerSize).toBe(60)
      expect(result.current.rightSize).toBe(25)
    })

    it("clamps each rail into its rail-specific range and renormalizes to sum 100", () => {
      // cognia-next applies per-rail minimums (left: [12,32], right: [16,36],
      // center derived as the remainder with a 38 floor) and then scales the
      // three sizes so they always sum to exactly 100. This is more
      // restrictive than a flat [0, 100] clamp.
      const { result } = renderHook(() => useCanvasLayoutStore())
      act(() => {
        result.current.setSizes([-5, 200, 50])
      })
      expect(result.current.leftSize).toBe(12) // clamped up to the left-rail floor
      expect(result.current.rightSize).toBe(36) // clamped down to the right-rail ceiling
      expect(result.current.centerSize).toBe(100 - 12 - 36)
      expect(
        Math.round(result.current.leftSize + result.current.centerSize + result.current.rightSize)
      ).toBe(100)
    })

    it("ignores malformed input", () => {
      const { result } = renderHook(() => useCanvasLayoutStore())
      act(() => {
        result.current.setSizes([] as unknown as number[])
      })
      expect(result.current.leftSize).toBe(CANVAS_LAYOUT_DEFAULTS.leftSize)
    })

    it("debounces persistence: 10 rapid drags result in one settled write", () => {
      jest.useFakeTimers()
      const { result } = renderHook(() => useCanvasLayoutStore())
      act(() => {
        for (let i = 0; i < 10; i++) {
          result.current.setSizes([10 + i, 60, 30 - i])
        }
      })
      // After all calls, the in-memory state reflects the last drag.
      expect(result.current.leftSize).toBe(19)
      // Fast-forward past the debounce window — the settled write fires.
      act(() => {
        jest.advanceTimersByTime(CANVAS_LAYOUT_PERSIST_DEBOUNCE_MS + 5)
      })
      const persisted = readPersisted()
      expect(persisted?.state.leftSize).toBe(19)
      expect(persisted?.state.rightSize).toBe(21)
      jest.useRealTimers()
    })
  })

  describe("collapse toggles", () => {
    it("toggleLeft flips the flag", () => {
      const { result } = renderHook(() => useCanvasLayoutStore())
      act(() => {
        result.current.toggleLeft()
      })
      expect(result.current.leftCollapsed).toBe(true)
      act(() => {
        result.current.toggleLeft()
      })
      expect(result.current.leftCollapsed).toBe(false)
    })

    it("toggleRight flips the flag", () => {
      const { result } = renderHook(() => useCanvasLayoutStore())
      act(() => {
        result.current.toggleRight()
      })
      expect(result.current.rightCollapsed).toBe(true)
    })

    it("setLeftCollapsed / setRightCollapsed accept explicit values", () => {
      const { result } = renderHook(() => useCanvasLayoutStore())
      act(() => {
        result.current.setLeftCollapsed(true)
        result.current.setRightCollapsed(true)
      })
      expect(result.current.leftCollapsed).toBe(true)
      expect(result.current.rightCollapsed).toBe(true)
    })
  })

  describe("activeRightTab", () => {
    it("accepts every CanvasRightTab value", () => {
      const tabs: CanvasRightTab[] = [
        "suggestions",
        "history",
        "comments",
        "collaboration",
        "execution",
      ]
      const { result } = renderHook(() => useCanvasLayoutStore())
      for (const tab of tabs) {
        act(() => {
          result.current.setActiveRightTab(tab)
        })
        expect(result.current.activeRightTab).toBe(tab)
      }
    })
  })

  describe("mobile sheet flags", () => {
    it("setMobileLeftOpen / setMobileRightOpen mutate runtime state", () => {
      const { result } = renderHook(() => useCanvasLayoutStore())
      act(() => {
        result.current.setMobileLeftOpen(true)
        result.current.setMobileRightOpen(true)
      })
      expect(result.current.mobileLeftOpen).toBe(true)
      expect(result.current.mobileRightOpen).toBe(true)
    })

    it("are excluded from the persisted snapshot", () => {
      jest.useFakeTimers()
      const { result } = renderHook(() => useCanvasLayoutStore())
      act(() => {
        result.current.setMobileLeftOpen(true)
        result.current.setMobileRightOpen(true)
        result.current.setSizes([20, 55, 25])
        jest.advanceTimersByTime(CANVAS_LAYOUT_PERSIST_DEBOUNCE_MS + 5)
      })
      const persisted = readPersisted()
      expect(persisted?.state).not.toHaveProperty("mobileLeftOpen")
      expect(persisted?.state).not.toHaveProperty("mobileRightOpen")
      jest.useRealTimers()
    })
  })

  describe("resetLayout", () => {
    it("returns the store to defaults", () => {
      const { result } = renderHook(() => useCanvasLayoutStore())
      act(() => {
        result.current.setSizes([10, 50, 40])
        result.current.toggleLeft()
        result.current.setActiveRightTab("execution")
        result.current.setMobileRightOpen(true)
      })
      act(() => {
        result.current.resetLayout()
      })
      expect(result.current.leftSize).toBe(CANVAS_LAYOUT_DEFAULTS.leftSize)
      expect(result.current.centerSize).toBe(CANVAS_LAYOUT_DEFAULTS.centerSize)
      expect(result.current.rightSize).toBe(CANVAS_LAYOUT_DEFAULTS.rightSize)
      expect(result.current.leftCollapsed).toBe(false)
      expect(result.current.activeRightTab).toBe("suggestions")
      expect(result.current.mobileRightOpen).toBe(false)
    })
  })
})
