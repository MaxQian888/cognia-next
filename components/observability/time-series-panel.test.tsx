/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { TimeSeriesPanel, buildChartConfig } from "./time-series-panel"
import { panelById } from "./panel-registry"
import { useObservabilitySeries } from "@/hooks/observability/use-observability-series"
import { renderHook } from "@testing-library/react"
import { customRange } from "@/lib/observability/time-range"
import { makeSpan } from "@/lib/observability/fixtures"
import { DEFAULT_THEME_COLORS } from "@/hooks/logging/use-theme-colors"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

function makeSeries() {
  const range = customRange(0, 3000)
  const spans = [
    makeSpan({ startTime: 100, durationMs: 100, costUsdEstimate: 0.1, errorMessage: "x" }),
    makeSpan({
      startTime: 200,
      durationMs: 200,
      usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 1, cacheCreationTokens: 0 },
    }),
  ]
  return renderHook(() => useObservabilitySeries(spans, range)).result.current
}

describe("buildChartConfig", () => {
  const series = makeSeries()

  it("builds an area config for cost", () => {
    const cfg = buildChartConfig(panelById("ts-cost")!, series, DEFAULT_THEME_COLORS)
    expect(cfg.type).toBe("area")
    expect(cfg.series).toHaveLength(1)
    expect(cfg.valueFormat(2)).toBe("$2.00")
  })

  it("builds a 3-line config for latency", () => {
    const cfg = buildChartConfig(panelById("ts-latency")!, series, DEFAULT_THEME_COLORS)
    expect(cfg.type).toBe("line")
    expect(cfg.series.map((s) => s.key)).toEqual(["p50", "p95", "p99"])
  })

  it("builds a stacked token config", () => {
    const cfg = buildChartConfig(panelById("ts-tokens")!, series, DEFAULT_THEME_COLORS)
    expect(cfg.series.every((s) => s.stackId === "tok")).toBe(true)
  })

  it("formats error-rate as percent", () => {
    const cfg = buildChartConfig(panelById("ts-errors")!, series, DEFAULT_THEME_COLORS)
    expect(cfg.valueFormat(0.25)).toBe("25.0%")
  })
})

describe("TimeSeriesPanel", () => {
  it("renders the chart container and title", () => {
    const series = makeSeries()
    render(<TimeSeriesPanel panel={panelById("ts-cost")!} series={series} />)
    expect(screen.getByTestId("ts-chart-ts-cost")).toBeInTheDocument()
    expect(screen.getByText("panels.costOverTime")).toBeInTheDocument()
  })

  it("renders a line chart for latency", () => {
    const series = makeSeries()
    render(<TimeSeriesPanel panel={panelById("ts-latency")!} series={series} />)
    expect(screen.getByTestId("ts-chart-ts-latency")).toBeInTheDocument()
  })

  it("shows a clickable legend for multi-series panels and toggles visibility", () => {
    const series = makeSeries()
    render(<TimeSeriesPanel panel={panelById("ts-latency")!} series={series} />)
    const p95 = screen.getByTestId("ts-legend-ts-latency-p95")
    expect(p95).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(p95)
    expect(p95).toHaveAttribute("aria-pressed", "false")
  })

  it("omits the legend for single-series panels", () => {
    const series = makeSeries()
    render(<TimeSeriesPanel panel={panelById("ts-cost")!} series={series} />)
    expect(screen.queryByTestId("ts-legend-ts-cost")).not.toBeInTheDocument()
  })
})
