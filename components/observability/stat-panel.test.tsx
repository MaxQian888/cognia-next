/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import { StatPanel, resolveStat, statLevel } from "./stat-panel"
import { panelById } from "./panel-registry"
import type { WindowKpis } from "@/lib/observability/aggregate-series"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

function kpis(over: Partial<WindowKpis> = {}): WindowKpis {
  return {
    totalCost: 0,
    totalSpans: 0,
    errorRate: 0,
    cacheHitRate: 0,
    p95LatencyMs: 0,
    reqPerMin: 0,
    ...over,
  }
}

describe("resolveStat", () => {
  it("formats each metric", () => {
    expect(resolveStat(panelById("kpi-cost")!, kpis({ totalCost: 3.5 })).display).toBe("$3.50")
    expect(resolveStat(panelById("kpi-spans")!, kpis({ totalSpans: 1500 })).display).toBe("1.5k")
    expect(resolveStat(panelById("kpi-errors")!, kpis({ errorRate: 0.123 })).display).toBe("12.3%")
    expect(resolveStat(panelById("kpi-latency")!, kpis({ p95LatencyMs: 1500 })).display).toBe(
      "1.50s"
    )
  })
})

describe("statLevel", () => {
  it("returns undefined without a threshold", () => {
    expect(statLevel(panelById("kpi-spans")!, 999)).toBeUndefined()
  })
  it("flags a critical error rate", () => {
    expect(statLevel(panelById("kpi-errors")!, 0.5)).toBe("crit")
  })
  it("treats a low cache hit rate as critical (below direction)", () => {
    expect(statLevel(panelById("kpi-cache")!, 0.1)).toBe("crit")
  })
})

describe("StatPanel", () => {
  it("renders the value and title", () => {
    render(<StatPanel panel={panelById("kpi-cost")!} kpis={kpis({ totalCost: 2 })} />)
    expect(screen.getByTestId("stat-value-kpi-cost")).toHaveTextContent("$2.00")
    expect(screen.getByText("panels.totalCost")).toBeInTheDocument()
  })

  it("shows a threshold dot when over the limit", () => {
    render(<StatPanel panel={panelById("kpi-errors")!} kpis={kpis({ errorRate: 0.5 })} />)
    expect(screen.getByTestId("panel-threshold-dot")).toHaveAttribute("data-level", "crit")
  })
})
