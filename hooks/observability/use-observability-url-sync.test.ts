/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"
import { useObservabilityUrlSync } from "./use-observability-url-sync"
import { useObservabilityStore } from "@/stores/observability/observability-store"

function setUrl(search: string) {
  window.history.replaceState({}, "", `/observability${search}`)
}

beforeEach(() => {
  setUrl("")
  useObservabilityStore.setState({
    rangePreset: "1h",
    customSince: null,
    customUntil: null,
    filters: {},
  })
})

describe("useObservabilityUrlSync", () => {
  it("hydrates the store from a deep-link on mount", () => {
    setUrl("?range=6h&f=%7B%22model%22%3A%5B%22opus%22%5D%7D")
    renderHook(() => useObservabilityUrlSync())
    expect(useObservabilityStore.getState().rangePreset).toBe("6h")
    expect(useObservabilityStore.getState().filters).toEqual({ model: ["opus"] })
  })

  it("hydrates a custom range", () => {
    setUrl("?range=custom&from=100&to=200")
    renderHook(() => useObservabilityUrlSync())
    const s = useObservabilityStore.getState()
    expect(s.rangePreset).toBe("custom")
    expect(s.customSince).toBe(100)
    expect(s.customUntil).toBe(200)
  })

  it("leaves the store alone when there are no params", () => {
    renderHook(() => useObservabilityUrlSync())
    expect(useObservabilityStore.getState().rangePreset).toBe("1h")
  })

  it("mirrors later control changes into the URL", () => {
    renderHook(() => useObservabilityUrlSync())
    // First write is skipped → URL stays clean on a pristine mount.
    expect(window.location.search).toBe("")
    act(() => useObservabilityStore.getState().setRangePreset("24h"))
    expect(window.location.search).toBe("?range=24h")
    act(() => useObservabilityStore.getState().setFilters({ surface: ["chat"] }))
    expect(decodeURIComponent(window.location.search)).toContain('f={"surface":["chat"]}')
  })

  it("clears the query when controls return to defaults", () => {
    renderHook(() => useObservabilityUrlSync())
    act(() => useObservabilityStore.getState().setRangePreset("24h"))
    expect(window.location.search).toBe("?range=24h")
    act(() => useObservabilityStore.getState().setRangePreset("1h"))
    expect(window.location.search).toBe("")
  })
})
