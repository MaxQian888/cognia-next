/**
 * @jest-environment jsdom
 *
 * Provider-manager hooks project the live routing telemetry store into the
 * compact shape consumed by provider UI components.
 */

import { renderHook, act } from "@testing-library/react"
import { useProviderHealth, useProviderManager } from "./use-provider-manager"

const metricsState = {
  metrics: {} as Record<
    string,
    {
      providerId: string
      totalRequests: number
      totalSuccesses: number
      totalErrors: number
      successRate: number
      latencyP95: number
    }
  >,
  getMetrics: jest.fn(),
  getDashboardData: jest.fn(),
}

jest.mock("@/stores/settings/health-metrics-store", () => ({
  useHealthMetricsStore: <T>(selector: (state: typeof metricsState) => T): T =>
    selector(metricsState),
}))

describe("useProviderHealth", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    metricsState.metrics = {}
    metricsState.getMetrics.mockImplementation((providerId: string) => ({
      providerId,
      totalRequests: 0,
      totalSuccesses: 0,
      totalErrors: 0,
      successRate: 1,
      latencyP95: 0,
    }))
  })

  it("returns an unknown snapshot before the provider has telemetry", () => {
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

  it("projects provider-specific latency and reliability metrics", () => {
    metricsState.metrics.openai = {
      providerId: "openai",
      totalRequests: 10,
      totalSuccesses: 8,
      totalErrors: 2,
      successRate: 0.8,
      latencyP95: 420,
    }
    metricsState.getMetrics.mockReturnValue(metricsState.metrics.openai)

    const { result } = renderHook(() => useProviderHealth("openai"))

    expect(result.current.health).toEqual({
      status: "degraded",
      latencyMs: 420,
      errorRate: 0.2,
      successRate: 0.8,
      totalRequests: 10,
    })
  })

  it("refresh reads the current synchronous telemetry snapshot", async () => {
    const { result } = renderHook(() => useProviderHealth("openai"))
    await expect(
      act(async () => {
        await result.current.refresh()
      })
    ).resolves.toBeUndefined()
  })
})

describe("useProviderManager", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    metricsState.metrics = {}
  })

  it("projects every provider currently present in the metrics store", () => {
    metricsState.metrics = {
      openai: {
        providerId: "openai",
        totalRequests: 4,
        totalSuccesses: 4,
        totalErrors: 0,
        successRate: 1,
        latencyP95: 120,
      },
    }
    const { result } = renderHook(() => useProviderManager())
    expect(result.current.providers.openai).toEqual({
      status: "healthy",
      latencyMs: 120,
      errorRate: 0,
      successRate: 1,
      totalRequests: 4,
    })
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
