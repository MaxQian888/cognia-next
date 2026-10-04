/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

const mockSearchParams = jest.fn<URLSearchParams | null, []>()
jest.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams(),
}))

import { OBSERVABILITY_URL_PARAMS, useObservabilityUrlSync } from "./use-observability-url-sync"
import { useObservabilityStore } from "@/stores/observability/observability-store"

const opusFilter = encodeURIComponent(JSON.stringify({ model: ["opus"] }))

/** Put `search` in the address bar AND make `useSearchParams` report it. */
function setUrl(search: string) {
  window.history.replaceState({}, "", `/logs${search}`)
  mockSearchParams.mockReturnValue(new URLSearchParams(search))
}

/** What the App Router does after any URL change: re-render with the new params. */
function syncSearchParamsFromLocation() {
  mockSearchParams.mockReturnValue(new URLSearchParams(window.location.search))
}

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search)
}

function mount() {
  return renderHook(() => useObservabilityUrlSync())
}

let replaceSpy: jest.SpyInstance

beforeEach(() => {
  setUrl("")
  useObservabilityStore.setState({
    rangePreset: "1h",
    customSince: null,
    customUntil: null,
    filters: {},
  })
  replaceSpy = jest.spyOn(window.history, "replaceState")
})

afterEach(() => {
  replaceSpy.mockRestore()
})

describe("useObservabilityUrlSync", () => {
  it("re-exports the store's owned-param list", () => {
    expect([...OBSERVABILITY_URL_PARAMS]).toEqual([
      "trange",
      "tfrom",
      "tto",
      "tf",
      "tspan",
      "tq",
      "terr",
    ])
  })

  describe("URL → store on mount", () => {
    it("hydrates the store from a deep-link", () => {
      setUrl(`?channel=traces&trange=6h&tf=${opusFilter}`)
      mount()
      expect(useObservabilityStore.getState().rangePreset).toBe("6h")
      expect(useObservabilityStore.getState().filters).toEqual({ model: ["opus"] })
    })

    it("hydrates a custom range", () => {
      setUrl("?trange=custom&tfrom=100&tto=200")
      mount()
      const s = useObservabilityStore.getState()
      expect(s.rangePreset).toBe("custom")
      expect(s.customSince).toBe(100)
      expect(s.customUntil).toBe(200)
    })

    it("does not invent a window from a half-formed custom link", () => {
      useObservabilityStore.setState({ rangePreset: "24h" })
      setUrl("?trange=custom&tfrom=100")
      mount()
      const s = useObservabilityStore.getState()
      expect(s.rangePreset).toBe("1h")
      expect(s.customSince).toBeNull()
      // The canonical rewrite drops the dangling bound.
      expect(params().has("tfrom")).toBe(false)
    })

    it("leaves the store alone when there are no params", () => {
      mount()
      expect(useObservabilityStore.getState().rangePreset).toBe("1h")
      expect(window.location.search).toBe("")
      expect(replaceSpy).not.toHaveBeenCalled()
    })

    it("works outside an App Router tree (useSearchParams → null)", () => {
      window.history.replaceState({}, "", "/logs?trange=7d")
      mockSearchParams.mockReturnValue(null)
      mount()
      expect(useObservabilityStore.getState().rangePreset).toBe("7d")
    })
  })

  describe("legacy keys", () => {
    it("reads range/from/to/f on a channel=traces link, then migrates them to the new keys", () => {
      setUrl(`?channel=traces&traceId=t1&range=custom&from=100&to=200&f=${opusFilter}`)
      mount()
      const s = useObservabilityStore.getState()
      expect(s.rangePreset).toBe("custom")
      expect(s.customSince).toBe(100)
      expect(s.customUntil).toBe(200)
      expect(s.filters).toEqual({ model: ["opus"] })

      const p = params()
      expect(p.get("trange")).toBe("custom")
      expect(p.get("tfrom")).toBe("100")
      expect(p.get("tto")).toBe("200")
      expect(JSON.parse(p.get("tf") ?? "null")).toEqual({ model: ["opus"] })
      for (const legacy of ["range", "from", "to", "f"]) expect(p.has(legacy)).toBe(false)
      // Foreign params survive the migration.
      expect(p.get("channel")).toBe("traces")
      expect(p.get("traceId")).toBe("t1")
    })

    it("never reads or deletes from/to on a non-traces URL", () => {
      useObservabilityStore.setState({ rangePreset: "6h" })
      setUrl("?channel=logs&range=24h&from=100&to=200")
      mount()
      expect(useObservabilityStore.getState().rangePreset).toBe("6h")
      const p = params()
      expect(p.get("channel")).toBe("logs")
      expect(p.get("range")).toBe("24h")
      expect(p.get("from")).toBe("100")
      expect(p.get("to")).toBe("200")
      // The persisted view is still written under the owned key.
      expect(p.get("trange")).toBe("6h")
    })
  })

  describe("store → URL", () => {
    it("writes persisted state on first load", () => {
      useObservabilityStore.setState({
        rangePreset: "custom",
        customSince: 10,
        customUntil: 20,
        filters: { surface: ["chat"] },
      })
      setUrl("?channel=traces&traceId=t1")
      mount()
      const p = params()
      expect(p.get("trange")).toBe("custom")
      expect(p.get("tfrom")).toBe("10")
      expect(p.get("tto")).toBe("20")
      expect(JSON.parse(p.get("tf") ?? "null")).toEqual({ surface: ["chat"] })
      expect(p.get("channel")).toBe("traces")
      expect(p.get("traceId")).toBe("t1")
    })

    it("lets the link win over persisted state on first load", () => {
      useObservabilityStore.setState({ rangePreset: "24h" })
      setUrl("?trange=6h")
      mount()
      expect(useObservabilityStore.getState().rangePreset).toBe("6h")
      expect(params().get("trange")).toBe("6h")
    })

    it("mirrors later control changes into the URL", () => {
      mount()
      act(() => useObservabilityStore.getState().setRangePreset("24h"))
      expect(window.location.search).toBe("?trange=24h")
      act(() => useObservabilityStore.getState().setFilters({ surface: ["chat"] }))
      expect(JSON.parse(params().get("tf") ?? "null")).toEqual({ surface: ["chat"] })
    })

    it("clears the query when controls return to defaults", () => {
      mount()
      act(() => useObservabilityStore.getState().setRangePreset("24h"))
      expect(window.location.search).toBe("?trange=24h")
      act(() => useObservabilityStore.getState().setRangePreset("1h"))
      expect(window.location.search).toBe("")
      expect(window.location.pathname).toBe("/logs")
    })

    it("only rewrites owned keys, keeping foreign params intact", () => {
      setUrl("?channel=logs&from=100&to=200&view=table&traceId=t1")
      mount()
      act(() => useObservabilityStore.getState().setCustomRange(5, 6))
      const p = params()
      expect(p.get("tfrom")).toBe("5")
      expect(p.get("tto")).toBe("6")
      expect(p.get("from")).toBe("100")
      expect(p.get("to")).toBe("200")
      expect(p.get("view")).toBe("table")
      expect(p.get("channel")).toBe("logs")
      expect(p.get("traceId")).toBe("t1")
    })

    it("uses replaceState, never pushing history", () => {
      const pushSpy = jest.spyOn(window.history, "pushState")
      mount()
      act(() => useObservabilityStore.getState().setRangePreset("6h"))
      expect(pushSpy).not.toHaveBeenCalled()
      expect(replaceSpy).toHaveBeenCalled()
      pushSpy.mockRestore()
    })
  })

  describe("navigation", () => {
    it("re-hydrates when the owned params change underneath the channel", () => {
      setUrl("?channel=traces&trange=6h")
      const { rerender } = mount()
      expect(useObservabilityStore.getState().rangePreset).toBe("6h")

      setUrl(`?channel=traces&trange=7d&tf=${opusFilter}`)
      rerender()
      expect(useObservabilityStore.getState().rangePreset).toBe("7d")
      expect(useObservabilityStore.getState().filters).toEqual({ model: ["opus"] })
    })

    it("migrates legacy keys arriving through a later navigation", () => {
      const { rerender } = mount()
      setUrl("?channel=traces&range=24h")
      rerender()
      expect(useObservabilityStore.getState().rangePreset).toBe("24h")
      const p = params()
      expect(p.get("trange")).toBe("24h")
      expect(p.has("range")).toBe(false)
    })

    it("writes the on-screen view back when a navigation dropped the owned params", () => {
      setUrl("?channel=traces&trange=6h")
      const { rerender } = mount()
      setUrl("?channel=traces&traceId=t2")
      rerender()
      expect(useObservabilityStore.getState().rangePreset).toBe("6h")
      const p = params()
      expect(p.get("trange")).toBe("6h")
      expect(p.get("traceId")).toBe("t2")
    })

    it("ignores its own writes", () => {
      const { rerender } = mount()
      act(() => useObservabilityStore.getState().setRangePreset("24h"))
      const setFilters = jest.spyOn(useObservabilityStore.getState(), "setFilters")
      replaceSpy.mockClear()
      // The router reports the replaceState we just did.
      syncSearchParamsFromLocation()
      rerender()
      expect(replaceSpy).not.toHaveBeenCalled()
      expect(setFilters).not.toHaveBeenCalled()
      expect(useObservabilityStore.getState().rangePreset).toBe("24h")
      setFilters.mockRestore()
    })

    it("ignores foreign param changes", () => {
      setUrl("?channel=traces&trange=6h")
      const { rerender } = mount()
      // The user moves on in-app; the store is now ahead of nothing but itself.
      act(() => useObservabilityStore.getState().setFilters({ model: ["opus"] }))
      replaceSpy.mockClear()

      // The shell / Logs panel write their own keys.
      const next = params()
      next.set("traceId", "t9")
      next.set("from", "1")
      next.set("tview", "dashboard")
      setUrl(`?${next.toString()}`)
      replaceSpy.mockClear()
      rerender()

      expect(replaceSpy).not.toHaveBeenCalled()
      const s = useObservabilityStore.getState()
      expect(s.rangePreset).toBe("6h")
      expect(s.filters).toEqual({ model: ["opus"] })
      const p = params()
      expect(p.get("traceId")).toBe("t9")
      expect(p.get("from")).toBe("1")
      expect(p.get("tview")).toBe("dashboard")
    })
  })
})
