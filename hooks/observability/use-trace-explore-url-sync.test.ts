/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"
import { useState } from "react"

const mockSearchParams = jest.fn<URLSearchParams | null, []>()
jest.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams(),
}))

import { EXPLORE_URL_WRITE_DELAY_MS, useTraceExploreUrlSync } from "./use-trace-explore-url-sync"
import { useObservabilityStore } from "@/stores/observability/observability-store"

/** Put `search` in the address bar AND make `useSearchParams` report it. */
function setUrl(search: string) {
  window.history.replaceState({}, "", `/logs${search}`)
  mockSearchParams.mockReturnValue(new URLSearchParams(search))
}

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search)
}

/**
 * The `/logs` shell owns errors-only and feeds it back as a prop; the harness
 * does the same, so a link's `terr` raised through the callback lands in the
 * next render exactly as it does in the app.
 */
function mount(initialErrorsOnly = false) {
  const onErrorsOnlyChange = jest.fn<void, [boolean]>()
  const view = renderHook(() => {
    const [errorsOnly, setErrorsOnly] = useState(initialErrorsOnly)
    useTraceExploreUrlSync({
      errorsOnly,
      onErrorsOnlyChange: (next) => {
        onErrorsOnlyChange(next)
        setErrorsOnly(next)
      },
    })
    return { errorsOnly, setErrorsOnly }
  })
  return { ...view, onErrorsOnlyChange }
}

let replaceSpy: jest.SpyInstance

beforeEach(() => {
  setUrl("")
  useObservabilityStore.setState({ exploreQuery: "", exploreSpanId: null })
  replaceSpy = jest.spyOn(window.history, "replaceState")
})

afterEach(() => {
  replaceSpy.mockRestore()
  jest.useRealTimers()
})

describe("useTraceExploreUrlSync", () => {
  it("exposes a short write debounce", () => {
    expect(EXPLORE_URL_WRITE_DELAY_MS).toBe(250)
  })

  describe("URL → state on mount", () => {
    it("hydrates span and search into the store and raises errors-only through the callback", () => {
      setUrl("?channel=traces&traceId=t1&tspan=s1&tq=bash&terr=1")
      const { result, onErrorsOnlyChange } = mount(false)
      expect(result.current.errorsOnly).toBe(true)
      const s = useObservabilityStore.getState()
      expect(s.exploreSpanId).toBe("s1")
      expect(s.exploreQuery).toBe("bash")
      expect(onErrorsOnlyChange).toHaveBeenCalledTimes(1)
      expect(onErrorsOnlyChange).toHaveBeenCalledWith(true)
      expect(params().get("terr")).toBe("1")
      expect(params().get("traceId")).toBe("t1")
    })

    it("lowers errors-only when the link says terr=0", () => {
      setUrl("?terr=0")
      const { onErrorsOnlyChange } = mount(true)
      expect(onErrorsOnlyChange).toHaveBeenCalledWith(false)
      expect(params().has("terr")).toBe(false)
    })

    it("does not call back when the link agrees with the current errors-only", () => {
      setUrl("?terr=1")
      const { onErrorsOnlyChange } = mount(true)
      expect(onErrorsOnlyChange).not.toHaveBeenCalled()
    })

    it("keeps the store's values for keys the link does not mention, and writes them", () => {
      useObservabilityStore.setState({ exploreQuery: "tool", exploreSpanId: "s2" })
      setUrl("?channel=traces")
      const { onErrorsOnlyChange } = mount(true)
      const s = useObservabilityStore.getState()
      expect(s.exploreQuery).toBe("tool")
      expect(s.exploreSpanId).toBe("s2")
      expect(onErrorsOnlyChange).not.toHaveBeenCalled()
      const p = params()
      expect(p.get("tspan")).toBe("s2")
      expect(p.get("tq")).toBe("tool")
      expect(p.get("terr")).toBe("1")
      expect(p.get("channel")).toBe("traces")
    })

    it("writes nothing for a pristine Explore view", () => {
      mount(false)
      expect(window.location.search).toBe("")
      expect(replaceSpy).not.toHaveBeenCalled()
    })

    it("works outside an App Router tree (useSearchParams → null)", () => {
      window.history.replaceState({}, "", "/logs?tspan=s7")
      mockSearchParams.mockReturnValue(null)
      mount()
      expect(useObservabilityStore.getState().exploreSpanId).toBe("s7")
    })
  })

  describe("state → URL", () => {
    it("writes the span immediately", () => {
      setUrl("?channel=traces&traceId=t1")
      mount()
      act(() => useObservabilityStore.getState().setExploreSpanId("s5"))
      const p = params()
      expect(p.get("tspan")).toBe("s5")
      expect(p.get("traceId")).toBe("t1")
      act(() => useObservabilityStore.getState().setExploreSpanId(null))
      expect(params().has("tspan")).toBe(false)
    })

    it("writes errors-only immediately when the prop changes", () => {
      const { result, onErrorsOnlyChange } = mount(false)
      // The toggle in the shell flips the prop.
      act(() => result.current.setErrorsOnly(true))
      expect(params().get("terr")).toBe("1")
      act(() => result.current.setErrorsOnly(false))
      expect(params().has("terr")).toBe(false)
      // The hook never echoes a prop change back up.
      expect(onErrorsOnlyChange).not.toHaveBeenCalled()
    })

    it("debounces search writes", () => {
      jest.useFakeTimers()
      mount()
      act(() => useObservabilityStore.getState().setExploreQuery("b"))
      act(() => useObservabilityStore.getState().setExploreQuery("ba"))
      act(() => jest.advanceTimersByTime(EXPLORE_URL_WRITE_DELAY_MS - 1))
      expect(params().has("tq")).toBe(false)
      act(() => useObservabilityStore.getState().setExploreQuery("bash"))
      act(() => jest.advanceTimersByTime(EXPLORE_URL_WRITE_DELAY_MS - 1))
      expect(params().has("tq")).toBe(false)
      act(() => jest.advanceTimersByTime(1))
      expect(params().get("tq")).toBe("bash")
    })

    it("drops a pending search write on unmount", () => {
      jest.useFakeTimers()
      const { unmount } = mount()
      act(() => useObservabilityStore.getState().setExploreQuery("late"))
      unmount()
      act(() => jest.advanceTimersByTime(EXPLORE_URL_WRITE_DELAY_MS * 2))
      expect(params().has("tq")).toBe(false)
    })

    it("never touches foreign params or the control keys", () => {
      setUrl("?channel=traces&traceId=t1&tview=explore&trange=6h&from=1")
      mount()
      act(() => useObservabilityStore.getState().setExploreSpanId("s1"))
      const p = params()
      expect(p.get("channel")).toBe("traces")
      expect(p.get("traceId")).toBe("t1")
      expect(p.get("tview")).toBe("explore")
      expect(p.get("trange")).toBe("6h")
      expect(p.get("from")).toBe("1")
    })
  })

  describe("navigation", () => {
    it("re-hydrates when the explore params change", () => {
      setUrl("?tspan=s1&tq=a")
      const { rerender, onErrorsOnlyChange } = mount(false)
      setUrl("?tspan=s2&tq=b&terr=1")
      rerender()
      const s = useObservabilityStore.getState()
      expect(s.exploreSpanId).toBe("s2")
      expect(s.exploreQuery).toBe("b")
      expect(onErrorsOnlyChange).toHaveBeenCalledWith(true)
    })

    it("clears keys a later navigation removed", () => {
      setUrl("?channel=traces&tspan=s1&tq=a&terr=1")
      const { rerender, onErrorsOnlyChange } = mount(true)
      expect(onErrorsOnlyChange).not.toHaveBeenCalled()

      setUrl("?channel=traces")
      rerender()
      const s = useObservabilityStore.getState()
      expect(s.exploreSpanId).toBeNull()
      expect(s.exploreQuery).toBe("")
      expect(onErrorsOnlyChange).toHaveBeenCalledTimes(1)
      expect(onErrorsOnlyChange).toHaveBeenCalledWith(false)
      expect(params().toString()).toBe("channel=traces")
    })

    it("ignores its own writes", () => {
      const { rerender, onErrorsOnlyChange } = mount(false)
      act(() => useObservabilityStore.getState().setExploreSpanId("s3"))
      replaceSpy.mockClear()
      // The router reports the replaceState we just did.
      mockSearchParams.mockReturnValue(new URLSearchParams(window.location.search))
      rerender()
      expect(replaceSpy).not.toHaveBeenCalled()
      expect(onErrorsOnlyChange).not.toHaveBeenCalled()
      expect(useObservabilityStore.getState().exploreSpanId).toBe("s3")
    })

    it("ignores foreign param changes", () => {
      setUrl("?tq=a")
      const { rerender, onErrorsOnlyChange } = mount(false)
      // A span opened since the link loaded; a foreign write must not revert it.
      act(() => useObservabilityStore.getState().setExploreSpanId("s4"))
      replaceSpy.mockClear()

      const next = params()
      next.set("traceId", "t2")
      next.set("trange", "24h")
      next.set("tview", "dashboard")
      setUrl(`?${next.toString()}`)
      replaceSpy.mockClear()
      rerender()

      expect(replaceSpy).not.toHaveBeenCalled()
      const s = useObservabilityStore.getState()
      expect(s.exploreSpanId).toBe("s4")
      expect(s.exploreQuery).toBe("a")
      expect(onErrorsOnlyChange).not.toHaveBeenCalled()
      expect(params().get("traceId")).toBe("t2")
    })
  })
})
