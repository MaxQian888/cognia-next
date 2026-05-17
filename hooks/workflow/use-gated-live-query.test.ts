/**
 * @jest-environment jsdom
 */

import { useEffect, useState } from "react"
import { renderHook, waitFor } from "@testing-library/react"
import { useGatedLiveQuery } from "./use-gated-live-query"

// Mock `useLiveQuery` with a realistic shape: pull the latest result from
// the querier (sync or Promise) and re-render when it resolves. This
// mirrors the Dexie hook's "default while pending, then update" behavior.
const liveQueryCalls: Array<{ deps: ReadonlyArray<unknown> }> = []
jest.mock("dexie-react-hooks", () => ({
  __esModule: true,
  useLiveQuery: <T>(
    fn: () => T | Promise<T>,
    deps: ReadonlyArray<unknown>,
    defaultResult: T
  ): T => {
    liveQueryCalls.push({ deps })
    const [value, setValue] = useState<T>(defaultResult)
    useEffect(() => {
      let cancelled = false
      try {
        const out = fn()
        if (out instanceof Promise) {
          out.then((v) => {
            if (!cancelled) setValue(v)
          })
        } else {
          setValue(out)
        }
      } catch {
        /* swallow — keep last value */
      }
      return () => {
        cancelled = true
      }
      // The mock matches the public signature: deps comes from the caller.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps)
    return value
  },
}))

beforeEach(() => {
  liveQueryCalls.length = 0
})

describe("useGatedLiveQuery", () => {
  it("runs the querier and returns the live value when enabled", async () => {
    const querier = jest.fn().mockReturnValue(42)
    const { result } = renderHook(() => useGatedLiveQuery(querier, ["k"], 0, true))
    expect(querier).toHaveBeenCalled()
    await waitFor(() => expect(result.current).toBe(42))
  })

  it("returns the last resolved value when disabled, without running the querier", async () => {
    let current = 10
    const querier = jest.fn(() => current)

    const { result, rerender } = renderHook(
      ({ enabled }) => useGatedLiveQuery(querier, ["k"], 0, enabled),
      { initialProps: { enabled: true } }
    )
    await waitFor(() => expect(result.current).toBe(10))
    expect(querier).toHaveBeenCalledTimes(1)

    // Underlying source changes, but we are about to disable the gate.
    current = 99
    querier.mockClear()
    rerender({ enabled: false })

    // After re-render with gate closed, the cached `10` is returned and the
    // user-provided querier is NEVER invoked.
    await waitFor(() => expect(result.current).toBe(10))
    expect(querier).not.toHaveBeenCalled()
  })

  it("re-fetches fresh data once enabled flips back to true", async () => {
    let current = 1
    const querier = jest.fn(() => current)

    const { result, rerender } = renderHook(
      ({ enabled }) => useGatedLiveQuery(querier, ["k"], 0, enabled),
      { initialProps: { enabled: true } }
    )
    await waitFor(() => expect(result.current).toBe(1))

    current = 2
    rerender({ enabled: false })
    await waitFor(() => expect(result.current).toBe(1)) // cached

    current = 3
    rerender({ enabled: true })
    await waitFor(() => expect(result.current).toBe(3)) // re-fetched, picks up latest
  })

  it("passes deps (with `enabled` prepended) to useLiveQuery", () => {
    renderHook(() => useGatedLiveQuery(() => "x", ["wf_42", "selected"], "", true))
    const last = liveQueryCalls[liveQueryCalls.length - 1]
    expect(last.deps[0]).toBe(true)
    expect(last.deps.slice(1)).toEqual(["wf_42", "selected"])
  })

  it("falls back to the cached value when useLiveQuery transiently returns undefined", () => {
    // The mock will hand back the default on the first render because the
    // querier returns a Promise. The hook should still surface the cached
    // default instead of undefined.
    const { result } = renderHook(() => useGatedLiveQuery(async () => 50, ["k"], 7, true))
    expect(result.current).toBe(7)
  })
})
