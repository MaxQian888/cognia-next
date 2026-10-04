/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { UsageEfficiencyPanel } from "./usage-efficiency-panel"

const stats = (p50: number, p90: number, max: number, count = 10) => ({
  p50,
  p90,
  p99: max,
  max,
  count,
})

describe("UsageEfficiencyPanel", () => {
  it("shows the estimated cache saving and the per-turn percentiles", () => {
    render(
      <UsageEfficiencyPanel
        savings={{ savedUsd: 12.5, pricedReadTokens: 1, unpricedReadTokens: 0, savingsRate: 0.42 }}
        distribution={{
          costPerTurn: stats(0.02, 0.15, 1.2),
          latencyMs: stats(1500, 8000, 30_000),
          outputTokensPerSec: null,
        }}
      />
    )
    expect(screen.getByTestId("usage-efficiency-cache-value")).toHaveTextContent("≈ $12.50")
    expect(screen.getByText(/42% cheaper/)).toBeInTheDocument()
    expect(screen.getByTestId("usage-efficiency-row-cost")).toHaveTextContent("$0.02")
    expect(screen.getByTestId("usage-efficiency-row-cost")).toHaveTextContent("$1.20")
    expect(screen.getByTestId("usage-efficiency-row-latency")).toHaveTextContent("1.5s")
    expect(screen.queryByTestId("usage-efficiency-row-throughput")).toBeNull()
  })

  it("explains an empty cache and an empty distribution", () => {
    render(
      <UsageEfficiencyPanel
        testid="x"
        savings={{ savedUsd: 0, pricedReadTokens: 0, unpricedReadTokens: 2000, savingsRate: null }}
        distribution={{ costPerTurn: null, latencyMs: null, outputTokensPerSec: null }}
      />
    )
    expect(screen.getByTestId("x-cache-none")).toBeInTheDocument()
    expect(screen.getByText(/2.0K cached tokens/)).toBeInTheDocument()
    expect(screen.getByTestId("x-distribution-empty")).toBeInTheDocument()
  })
})
