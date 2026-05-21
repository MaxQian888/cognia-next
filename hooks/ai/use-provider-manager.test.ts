/**
 * @jest-environment jsdom
 *
 * Tests for the provider-manager stub. The hook is intentionally inert in
 * cognia-next (the routing engine + circuit breaker + load balancer that
 * Cognia ships hasn't been ported), so the assertions here pin the
 * default shape so consumers don't accidentally depend on behavior that
 * doesn't exist yet.
 */

import { renderHook, act } from "@testing-library/react"
import { useProviderHealth, useProviderManager } from "./use-provider-manager"

describe("useProviderHealth", () => {
  it("returns the inert default health snapshot", () => {
    const { result } = renderHook(() => useProviderHealth("openai"))
    expect(result.current.isLoading).toBe(false)
    expect(result.current.health).toEqual({
      status: "unknown",
      latencyMs: 0,
      errorRate: 0,
      successRate: 0,
      totalRequests: 0,
    })
  })

  it("ignores the providerId arg (no per-provider memoisation)", () => {
    const a = renderHook(() => useProviderHealth("openai")).result.current.health
    const b = renderHook(() => useProviderHealth("anthropic")).result.current.health
    expect(a).toEqual(b)
  })

  it("exposes a refresh() that resolves with undefined and never throws", async () => {
    const { result } = renderHook(() => useProviderHealth("openai"))
    await expect(
      act(async () => {
        await result.current.refresh()
      })
    ).resolves.toBeUndefined()
  })
})

describe("useProviderManager", () => {
  it("starts with an empty providers map and isLoading=false", () => {
    const { result } = renderHook(() => useProviderManager())
    expect(result.current.providers).toEqual({})
    expect(result.current.isLoading).toBe(false)
  })

  it("exposes a refresh() that resolves with undefined", async () => {
    const { result } = renderHook(() => useProviderManager())
    await expect(
      act(async () => {
        await result.current.refresh()
      })
    ).resolves.toBeUndefined()
  })
})
