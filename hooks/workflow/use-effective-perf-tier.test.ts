/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { act, renderHook, waitFor } from "@testing-library/react"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { createEditorStore } from "@/lib/workflow/editor/store"
import type { VisualWorkflow } from "@/types/workflow/visual"
import { savePerformanceTierPref } from "@/lib/workflow/editor/performance-tier-prefs"
import { useEffectivePerfTier } from "./use-effective-perf-tier"

function emptyWorkflow(): VisualWorkflow {
  return {
    id: "wf_test",
    schemaVersion: 1,
    name: "Empty",
    createdAt: 1,
    updatedAt: 1,
    nodes: [],
    edges: [],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 3, backoff: "exponential", baseMs: 1000 },
    },
    viewport: { x: 0, y: 0, zoom: 1 },
  }
}

interface MediaState {
  matches: boolean
  listeners: Set<() => void>
}

function installMatchMedia(initial = false): MediaState {
  const state: MediaState = { matches: initial, listeners: new Set() }
  window.matchMedia = ((query: string) => ({
    matches: query === "(prefers-reduced-motion: reduce)" ? state.matches : false,
    media: query,
    addEventListener: (_evt: string, cb: () => void) => {
      state.listeners.add(cb)
    },
    removeEventListener: (_evt: string, cb: () => void) => {
      state.listeners.delete(cb)
    },
    addListener: (cb: () => void) => state.listeners.add(cb),
    removeListener: (cb: () => void) => state.listeners.delete(cb),
    dispatchEvent: () => true,
    onchange: null,
  })) as unknown as typeof window.matchMedia
  return state
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("useEffectivePerfTier", () => {
  it("starts with auto → high on a small graph without reduce-motion", async () => {
    installMatchMedia(false)
    const store = createEditorStore(emptyWorkflow())
    const { result } = renderHook(() => useEffectivePerfTier(store))
    expect(result.current.userChoice).toBe("auto")
    expect(result.current.effective).toBe("high")
    expect(result.current.flags.showMinimap).toBe(true)
    // Allow the Dexie hydration microtask to settle without crashing.
    await waitFor(() => {
      expect(result.current.userChoice).toBe("auto")
    })
  })

  it("hydrates from Dexie on mount when a previous tier was saved", async () => {
    installMatchMedia(false)
    await savePerformanceTierPref("balanced")

    const store = createEditorStore(emptyWorkflow())
    const { result } = renderHook(() => useEffectivePerfTier(store))

    await waitFor(() => expect(result.current.userChoice).toBe("balanced"))
    expect(result.current.effective).toBe("balanced")
    expect(result.current.flags.edgeAnimations).toBe(false)
  })

  it("resolves to reduced when OS prefers-reduced-motion is on (auto tier)", () => {
    installMatchMedia(true)
    const store = createEditorStore(emptyWorkflow())
    const { result } = renderHook(() => useEffectivePerfTier(store))
    expect(result.current.effective).toBe("reduced")
    expect(result.current.flags.showMinimap).toBe(false)
  })

  it("honours explicit userChoice over reduce-motion", async () => {
    installMatchMedia(true)
    const store = createEditorStore(emptyWorkflow())
    const { result } = renderHook(() => useEffectivePerfTier(store))
    act(() => result.current.setUserChoice("high"))
    expect(result.current.userChoice).toBe("high")
    expect(result.current.effective).toBe("high")
    await waitFor(async () => {
      const row = await getDb().settings.get("singleton")
      expect(row?.workflowEditorPerformanceTier).toBe("high")
    })
  })

  it("re-renders when prefers-reduced-motion flips", () => {
    const media = installMatchMedia(false)
    const store = createEditorStore(emptyWorkflow())
    const { result } = renderHook(() => useEffectivePerfTier(store))
    expect(result.current.effective).toBe("high")

    act(() => {
      media.matches = true
      media.listeners.forEach((cb) => cb())
    })
    expect(result.current.effective).toBe("reduced")
  })

  it("unsubscribes the matchMedia listener on unmount", () => {
    const media = installMatchMedia(false)
    const store = createEditorStore(emptyWorkflow())
    const { unmount } = renderHook(() => useEffectivePerfTier(store))
    expect(media.listeners.size).toBeGreaterThan(0)
    unmount()
    expect(media.listeners.size).toBe(0)
  })
})
