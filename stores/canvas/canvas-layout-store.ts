/**
 * Canvas Layout Store — persisted shell sizing for the Canvas guild.
 *
 * Owns: panel sizes (percent), per-rail collapsed flags, the active
 * right-rail tab, and runtime-only mobile sheet open flags. The
 * `<CanvasShell />` component calls `setSizes` on every drag tick;
 * persistence is debounced internally so localStorage isn't thrashed.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"

export type CanvasRightTab = "suggestions" | "history" | "comments" | "collaboration" | "execution"

export interface CanvasLayoutState {
  leftSize: number
  centerSize: number
  rightSize: number
  leftCollapsed: boolean
  rightCollapsed: boolean
  activeRightTab: CanvasRightTab
  mobileLeftOpen: boolean
  mobileRightOpen: boolean

  setSizes: (sizes: number[]) => void
  toggleLeft: () => void
  toggleRight: () => void
  setLeftCollapsed: (collapsed: boolean) => void
  setRightCollapsed: (collapsed: boolean) => void
  setActiveRightTab: (tab: CanvasRightTab) => void
  setMobileLeftOpen: (open: boolean) => void
  setMobileRightOpen: (open: boolean) => void
  resetLayout: () => void
}

export const CANVAS_LAYOUT_DEFAULTS = {
  leftSize: 18,
  centerSize: 60,
  rightSize: 22,
  leftCollapsed: false,
  rightCollapsed: false,
  activeRightTab: "suggestions" as CanvasRightTab,
}

export const CANVAS_LAYOUT_PERSIST_DEBOUNCE_MS = 150

// Module-level debounce token shared across calls. Each `setSizes` invocation
// applies the new state immediately (so the UI tracks the drag) and schedules
// a single delayed `setState` that nudges Zustand's persist middleware to
// flush. Without this the persist layer writes localStorage on every animation
// frame while the user drags a divider.
let pendingFlush: ReturnType<typeof setTimeout> | null = null

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 100) return 100
  return value
}

export const useCanvasLayoutStore = create<CanvasLayoutState>()(
  persist(
    (set, get) => ({
      ...CANVAS_LAYOUT_DEFAULTS,
      mobileLeftOpen: false,
      mobileRightOpen: false,

      setSizes: (sizes) => {
        const [left, center, right] = sizes
        if (typeof left !== "number" || typeof center !== "number" || typeof right !== "number") {
          return
        }
        // Clamp each rail to its allowed range, derive center from remainder,
        // then scale so all three always sum to exactly 100.
        const clampedLeft = clamp(Math.max(12, Math.min(32, left)))
        const clampedRight = clamp(Math.max(16, Math.min(36, right)))
        const clampedCenter = clamp(Math.max(38, 100 - clampedLeft - clampedRight))
        const total = clampedLeft + clampedCenter + clampedRight
        const scale = total > 0 ? 100 / total : 1
        set({
          leftSize: clampedLeft * scale,
          centerSize: clampedCenter * scale,
          rightSize: clampedRight * scale,
        })
        if (pendingFlush) clearTimeout(pendingFlush)
        pendingFlush = setTimeout(() => {
          pendingFlush = null
          // Touching state again forces the persist middleware to write the
          // settled values exactly once after the drag stops.
          set({ leftSize: get().leftSize })
        }, CANVAS_LAYOUT_PERSIST_DEBOUNCE_MS)
      },

      toggleLeft: () => set((state) => ({ leftCollapsed: !state.leftCollapsed })),
      toggleRight: () => set((state) => ({ rightCollapsed: !state.rightCollapsed })),
      setLeftCollapsed: (collapsed) => set({ leftCollapsed: collapsed }),
      setRightCollapsed: (collapsed) => set({ rightCollapsed: collapsed }),
      setActiveRightTab: (tab) => set({ activeRightTab: tab }),
      setMobileLeftOpen: (open) => set({ mobileLeftOpen: open }),
      setMobileRightOpen: (open) => set({ mobileRightOpen: open }),
      resetLayout: () =>
        set({
          ...CANVAS_LAYOUT_DEFAULTS,
          mobileLeftOpen: false,
          mobileRightOpen: false,
        }),
    }),
    {
      name: "cognia-canvas-layout",
      version: 3,
      migrate: (_oldState: unknown, _oldVersion: number) => ({
        ...CANVAS_LAYOUT_DEFAULTS,
        mobileLeftOpen: false,
        mobileRightOpen: false,
      }),
      partialize: (state) => ({
        leftSize: state.leftSize,
        centerSize: state.centerSize,
        rightSize: state.rightSize,
        leftCollapsed: state.leftCollapsed,
        rightCollapsed: state.rightCollapsed,
        activeRightTab: state.activeRightTab,
      }),
    }
  )
)

export default useCanvasLayoutStore
