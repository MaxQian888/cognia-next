/**
 * @jest-environment jsdom
 */

import { createElement } from "react"
import { renderToString } from "react-dom/server"
import { act, renderHook } from "@testing-library/react"
import {
  awaitApproval,
  resolveApproval,
  __resetApprovalRegistryForTesting,
} from "@/lib/connectors/hitl/approval-registry"
import { usePendingApprovalCount } from "./use-pending-approval-count"

beforeEach(() => {
  __resetApprovalRegistryForTesting()
})

afterAll(() => {
  __resetApprovalRegistryForTesting()
})

describe("usePendingApprovalCount", () => {
  it("starts at 0 when nothing is pending", () => {
    const { result } = renderHook(() => usePendingApprovalCount("s1"))
    expect(result.current).toBe(0)
  })

  it("tracks registrations and resolutions for its session only", async () => {
    const { result } = renderHook(() => usePendingApprovalCount("s1"))

    act(() => {
      void awaitApproval("s1", "r1")
      void awaitApproval("s1", "r2")
      void awaitApproval("other", "r1")
    })
    expect(result.current).toBe(2)

    act(() => {
      resolveApproval("s1", "r1", { decision: "allow" })
    })
    expect(result.current).toBe(1)

    // Resolving another session's approval leaves this count untouched.
    act(() => {
      resolveApproval("other", "r1", { decision: "deny" })
    })
    expect(result.current).toBe(1)
  })

  it("re-reads the count when the session id changes", () => {
    act(() => {
      void awaitApproval("a", "r1")
      void awaitApproval("b", "r1")
      void awaitApproval("b", "r2")
    })
    const { result, rerender } = renderHook(({ id }) => usePendingApprovalCount(id), {
      initialProps: { id: "a" },
    })
    expect(result.current).toBe(1)
    rerender({ id: "b" })
    expect(result.current).toBe(2)
  })

  it("reports 0 in the server snapshot even when the registry has entries", () => {
    act(() => {
      void awaitApproval("s1", "r1")
    })
    function Probe() {
      return createElement("span", null, String(usePendingApprovalCount("s1")))
    }
    // Static export / SSR path: useSyncExternalStore reads getServerSnapshot.
    expect(renderToString(createElement(Probe))).toContain(">0<")
  })

  it("drops to 0 when the TTL auto-denies the last pending approval", async () => {
    jest.useFakeTimers()
    try {
      const { result } = renderHook(() => usePendingApprovalCount("s1"))
      let p: Promise<unknown> = Promise.resolve()
      act(() => {
        p = awaitApproval("s1", "r1", { ttlMs: 250 })
      })
      expect(result.current).toBe(1)
      await act(async () => {
        jest.advanceTimersByTime(250)
        await p
      })
      expect(result.current).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })
})
