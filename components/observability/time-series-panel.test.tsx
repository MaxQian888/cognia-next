/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import {
  NEUTRAL_CHART_FORMATTERS,
  TimeSeriesPanel,
  buildChartConfig,
  clickedBucket,
  seriesSpanMs,
} from "./time-series-panel"
import { panelById } from "./panel-registry"
import { useObservabilitySeries } from "@/hooks/observability/use-observability-series"
import { renderHook } from "@testing-library/react"
import { customRange } from "@/lib/observability/time-range"
import { makeSpan } from "@/lib/observability/fixtures"
import { DEFAULT_THEME_COLORS } from "@/hooks/logging/use-theme-colors"

jest.mock("next-intl", () => {
  // Key-echo translator (with `has`, which the enum-label hook asks before
  // translating) plus an Intl-backed formatter — what next-intl's
  // `useFormatter` does, in "en"/UTC (next-intl itself is ESM-only and cannot
  // be `requireActual`-ed here) — so units and currency render as in the app.
  const translator = () => (key: string) => key
  return {
    useTranslations: () => Object.assign(translator(), { has: () => false }),
    useFormatter: () => ({
      number: (value: number, options?: Intl.NumberFormatOptions) =>
        new Intl.NumberFormat("en", options).format(value),
      dateTime: (value: number | Date, options?: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat("en", { timeZone: "UTC", ...options }).format(value),
    }),
  }
})

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

describe("buildChartConfig formatters", () => {
  const series = makeSeries()

  it("routes every value through the given formatter set", () => {
    const fmt = { ...NEUTRAL_CHART_FORMATTERS, perSecond: (v: number) => `${v} per s` }
    const cfg = buildChartConfig(panelById("ts-rate")!, series, DEFAULT_THEME_COLORS, fmt)
    expect(cfg.valueFormat(1.5)).toBe("1.5 per s")
    const tokens = buildChartConfig(panelById("ts-tokens")!, series, DEFAULT_THEME_COLORS, {
      ...NEUTRAL_CHART_FORMATTERS,
      compact: () => "1.2K",
    })
    expect(tokens.valueFormat(1234)).toBe("1.2K")
  })
})

describe("chart drill helpers", () => {
  const data = [{ t: 1_000 }, { t: 2_000 }, { t: 3_000 }]

  it("measures a series from first bucket start to last bucket end", () => {
    expect(seriesSpanMs(data, 1_000)).toBe(3_000)
    expect(seriesSpanMs([], 1_000)).toBe(0)
  })

  it("resolves the clicked bucket from the index, then the label", () => {
    expect(clickedBucket({ activeIndex: 1 }, data)).toBe(2_000)
    expect(clickedBucket({ activeIndex: "2" }, data)).toBe(3_000)
    expect(clickedBucket({ activeLabel: 4_000 }, data)).toBe(4_000)
    expect(clickedBucket({}, data)).toBeNull()
    expect(clickedBucket(null, data)).toBeNull()
  })
})

describe("TimeSeriesPanel drill and axis", () => {
  it("marks the chart drillable only when a handler is given and not editing", () => {
    const series = makeSeries()
    const { rerender } = render(
      <TimeSeriesPanel panel={panelById("ts-cost")!} series={series} onDrillWindow={jest.fn()} />
    )
    expect(screen.getByTestId("ts-chart-ts-cost")).toHaveAttribute("data-drillable", "true")
    expect(screen.getByTestId("ts-chart-ts-cost")).toHaveAttribute("title", "drill.pointHint")
    rerender(
      <TimeSeriesPanel
        panel={panelById("ts-cost")!}
        series={series}
        onDrillWindow={jest.fn()}
        editMode
      />
    )
    expect(screen.getByTestId("ts-chart-ts-cost")).not.toHaveAttribute("data-drillable")
  })
})
