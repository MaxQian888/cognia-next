/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"

import type { SessionObservationSummary } from "@/types/agent/agent-trace"
import { TooltipProvider } from "@/components/ui/tooltip"

import { TraceHealthBadge, deriveTraceHealthScore } from "./trace-health-badge"

const wrap = (ui: React.ReactNode) => <TooltipProvider>{ui}</TooltipProvider>

function makeSummary(
  overrides: Partial<SessionObservationSummary> = {}
): SessionObservationSummary {
  return {
    sessionId: "session-1",
    errorCount: 0,
    toolCount: 0,
    toolCallCount: 0,
    ...overrides,
  }
}

describe("deriveTraceHealthScore", () => {
  it("returns A grade for a perfect summary with no signals", () => {
    const result = deriveTraceHealthScore(makeSummary())
    expect(result.grade).toBe("A")
    expect(result.score).toBeGreaterThanOrEqual(90)
    expect(result.breakdown.successRate).toBe("100%")
    expect(result.breakdown.errorDensity).toBe("0%")
  })

  it("falls to F when the run outcome is error", () => {
    const result = deriveTraceHealthScore(
      makeSummary({ outcome: "error", errorCount: 3, toolCallCount: 5 })
    )
    expect(result.grade).toBe("F")
  })

  it("penalises high error density and high latency", () => {
    const result = deriveTraceHealthScore(
      makeSummary({ errorCount: 4, toolCallCount: 6, latencyP50Ms: 20000, totalTokenCost: 3 })
    )
    expect(["D", "F"]).toContain(result.grade)
    expect(result.score).toBeLessThan(80)
  })

  it("uses fallback toolCount when toolCallCount is missing", () => {
    const result = deriveTraceHealthScore(
      makeSummary({ toolCount: 8, toolCallCount: undefined, errorCount: 1 })
    )
    expect(result.breakdown.successRate).toBe("88%")
  })

  it("clamps cost-efficiency across cost tiers", () => {
    expect(
      deriveTraceHealthScore(makeSummary({ totalTokenCost: 0.04 })).breakdown.costEfficiency
    ).toBe("90%")
    expect(
      deriveTraceHealthScore(makeSummary({ totalTokenCost: 0.4 })).breakdown.costEfficiency
    ).toBe("70%")
    expect(
      deriveTraceHealthScore(makeSummary({ totalTokenCost: 1.5 })).breakdown.costEfficiency
    ).toBe("50%")
    expect(
      deriveTraceHealthScore(makeSummary({ totalTokenCost: 5 })).breakdown.costEfficiency
    ).toBe("30%")
  })

  it("clamps latency tiers across thresholds", () => {
    expect(
      deriveTraceHealthScore(makeSummary({ latencyP50Ms: 1000 })).breakdown.latencyPercentile
    ).toBe("90%")
    expect(
      deriveTraceHealthScore(makeSummary({ latencyP50Ms: 4000 })).breakdown.latencyPercentile
    ).toBe("70%")
    expect(
      deriveTraceHealthScore(makeSummary({ latencyP50Ms: 10000 })).breakdown.latencyPercentile
    ).toBe("50%")
    expect(
      deriveTraceHealthScore(makeSummary({ latencyP50Ms: 30000 })).breakdown.latencyPercentile
    ).toBe("30%")
  })

  it("returns mid-tier grades for partial success", () => {
    const result = deriveTraceHealthScore(
      makeSummary({ errorCount: 1, toolCallCount: 9, latencyP50Ms: 4000, totalTokenCost: 0.4 })
    )
    expect(["B", "C"]).toContain(result.grade)
  })
})

describe("TraceHealthBadge", () => {
  it("renders the grade and score", () => {
    render(wrap(<TraceHealthBadge summary={makeSummary({ toolCallCount: 10 })} />))
    expect(screen.getByText("A")).toBeInTheDocument()
    expect(screen.getByText(/^\d+$/)).toBeInTheDocument()
  })

  it("renders a low-grade badge when the run errored out", () => {
    render(
      wrap(
        <TraceHealthBadge
          summary={makeSummary({ outcome: "error", errorCount: 5, toolCallCount: 6 })}
        />
      )
    )
    expect(screen.getByText("F")).toBeInTheDocument()
  })

  it("accepts an optional className", () => {
    const { container } = render(
      wrap(<TraceHealthBadge summary={makeSummary()} className="extra-class" />)
    )
    expect(container.querySelector(".extra-class")).not.toBeNull()
  })
})
