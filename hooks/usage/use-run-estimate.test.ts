/**
 * @jest-environment jsdom
 */
import { renderHook, waitFor } from "@testing-library/react"

import type { RunSample } from "@/lib/usage/run-estimate/estimate"

jest.mock("@/lib/usage/run-estimate/load-samples", () => ({ loadRunEstimateContext: jest.fn() }))

import { loadRunEstimateContext } from "@/lib/usage/run-estimate/load-samples"

import { useRunEstimate } from "./use-run-estimate"

const loadMock = loadRunEstimateContext as jest.Mock

function sample(over: Partial<RunSample> = {}): RunSample {
  return {
    surface: "best-of-n",
    harness: "builtin",
    modelFamily: null,
    endedAt: Date.now() - 1000,
    durationMs: 60_000,
    tokens: null,
    frozenCostUsd: 1,
    stoppedEarly: false,
    ...over,
  }
}

const context = {
  samples: Array.from({ length: 6 }, () => sample()),
  resolvePreset: () => undefined,
}

beforeEach(() => {
  loadMock.mockReset()
})

describe("useRunEstimate", () => {
  it("stays idle and reads nothing for null or empty queries", () => {
    const { result, rerender } = renderHook(({ q }) => useRunEstimate(q), {
      initialProps: { q: null as Parameters<typeof useRunEstimate>[0] },
    })
    expect(result.current).toEqual({ status: "idle", estimate: null, dormant: false })
    rerender({ q: [] })
    expect(result.current.status).toBe("idle")
    expect(loadMock).not.toHaveBeenCalled()
  })

  it("loads history once and re-estimates when the query changes", async () => {
    loadMock.mockResolvedValue(context)
    const { result, rerender } = renderHook(
      ({ m }) => useRunEstimate([{ surface: "best-of-n", multiplier: m }]),
      {
        initialProps: { m: 1 },
      }
    )
    expect(result.current.status).toBe("loading")
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(result.current.estimate?.costUsd?.p50).toBeCloseTo(1)
    rerender({ m: 3 })
    expect(result.current.estimate?.costUsd?.p50).toBeCloseTo(3)
    expect(loadMock).toHaveBeenCalledTimes(1)
  })

  it("reports dormant for bot queries without reading history", () => {
    const { result } = renderHook(() => useRunEstimate([{ surface: "bot" }]))
    expect(result.current).toEqual({ status: "ready", estimate: null, dormant: true })
    expect(loadMock).not.toHaveBeenCalled()
  })

  it("reports an error when history cannot be read", async () => {
    loadMock.mockRejectedValue(new Error("db closed"))
    const { result } = renderHook(() => useRunEstimate([{ surface: "goal" }]))
    await waitFor(() => expect(result.current.status).toBe("error"))
    expect(result.current.estimate).toBeNull()
  })
})
