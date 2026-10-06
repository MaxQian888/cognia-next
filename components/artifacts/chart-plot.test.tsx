/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { parseChartPayload } from "@/lib/artifacts"
import type { ChatDiagramPalette } from "@/lib/chat/diagram-palette"
import { CHART_PLOT_TOOLTIP_STYLE, ChartPlot, legendRank, seriesColor } from "./chart-plot"

// Recharts paints nothing under jsdom, so each primitive renders a marker
// carrying the props this module decides: which key, which colour.
jest.mock("recharts", () => {
  const box = (name: string) =>
    function RechartsMarker({
      children,
      ...props
    }: { children?: ReactNode } & Record<string, unknown>) {
      return (
        <div
          data-testid={name}
          data-key={String(props.dataKey ?? "")}
          data-fill={String(props.fill ?? "")}
          data-stroke={String(props.stroke ?? "")}
          data-name={String(props.name ?? "")}
        >
          {children}
        </div>
      )
    }
  return {
    ResponsiveContainer: box("container"),
    BarChart: box("bar-chart"),
    LineChart: box("line-chart"),
    AreaChart: box("area-chart"),
    PieChart: box("pie-chart"),
    ScatterChart: box("scatter-chart"),
    RadarChart: box("radar-chart"),
    Bar: box("bar"),
    Line: box("line"),
    Area: box("area"),
    Pie: box("pie"),
    Cell: box("cell"),
    Scatter: box("scatter"),
    Radar: box("radar"),
    CartesianGrid: box("grid"),
    PolarGrid: box("polar-grid"),
    PolarAngleAxis: box("polar-angle"),
    PolarRadiusAxis: box("polar-radius"),
    XAxis: box("x-axis"),
    YAxis: box("y-axis"),
    Tooltip: box("tooltip"),
    Legend: box("legend"),
  }
})

const palette: ChatDiagramPalette = {
  key: "test",
  dark: false,
  fontFamily: "Inter",
  colors: {
    background: "#ffffff",
    foreground: "#111111",
    card: "#ffffff",
    muted: "#eeeeee",
    mutedForeground: "#777777",
    border: "#dddddd",
    primary: "#222222",
    accent: "#eeeeee",
    warning: "#ffaa00",
    chart: ["#c1", "#c2", "#c3", "#c4", "#c5"].map((c) => c.replace("#c", "#00000")),
  },
}

const draw = (payload: object) =>
  render(
    <ChartPlot
      contract={parseChartPayload(JSON.stringify(payload))}
      palette={palette}
      scatterSeriesName="Series"
    />
  )

describe("ChartPlot", () => {
  it("colours series from the palette in order and themes the grid", () => {
    draw({ type: "bar", data: [{ name: "a", x: 1, y: 2 }] })
    const bars = screen.getAllByTestId("bar")
    expect(bars.map((bar) => bar.dataset.key)).toEqual(["x", "y"])
    expect(bars.map((bar) => bar.dataset.fill)).toEqual([
      palette.colors.chart[0],
      palette.colors.chart[1],
    ])
    expect(screen.getByTestId("grid")).toHaveAttribute("data-stroke", palette.colors.border)
    // Two series ⇒ a legend.
    expect(screen.getByTestId("legend")).toBeInTheDocument()
  })

  it("skips the legend for a single cartesian series", () => {
    draw({ type: "line", data: [{ name: "a", v: 1 }] })
    expect(screen.getByTestId("line")).toHaveAttribute("data-stroke", palette.colors.chart[0])
    expect(screen.queryByTestId("legend")).not.toBeInTheDocument()
  })

  it("slices pies by the contract's value key with one palette colour per slice", () => {
    draw({
      type: "doughnut",
      data: [
        { name: "a", share: 1 },
        { name: "b", share: 2 },
      ],
    })
    expect(screen.getByTestId("pie")).toHaveAttribute("data-key", "share")
    expect(screen.getByTestId("pie")).toHaveAttribute("data-stroke", palette.colors.background)
    expect(screen.getAllByTestId("cell").map((cell) => cell.dataset.fill)).toEqual([
      palette.colors.chart[0],
      palette.colors.chart[1],
    ])
  })

  it.each([
    [{ type: "area", data: [{ name: "a", v: 1 }] }, "area"],
    [{ type: "radar", data: [{ name: "a", v: 1 }] }, "radar"],
    [{ type: "scatter", data: [{ x: 1, y: 2 }] }, "scatter"],
  ])("draws %#", (payload, mark) => {
    draw(payload)
    expect(screen.getByTestId(mark)).toBeInTheDocument()
  })

  it("names the scatter series and wraps rotation through the palette", () => {
    draw({ type: "scatter", data: [{ x: 1, y: 2 }] })
    expect(screen.getByTestId("scatter")).toHaveAttribute("data-name", "Series")
    expect(seriesColor(palette, 6)).toBe(palette.colors.chart[1])
  })

  it("styles the tooltip with the popover tokens", () => {
    expect(CHART_PLOT_TOOLTIP_STYLE.backgroundColor).toBe("var(--popover)")
    expect(CHART_PLOT_TOOLTIP_STYLE.color).toBe("var(--popover-foreground)")
  })

  it("ranks legend items in payload order, not alphabetically", () => {
    // "before" precedes "after" in the payload and takes the first colour, so
    // the legend must list it first even though recharts would sort it second.
    const bar = parseChartPayload(
      JSON.stringify({ type: "bar", data: [{ name: "a", before: 1, after: 2 }] })
    )
    expect(legendRank(bar, { dataKey: "before" })).toBe(0)
    expect(legendRank(bar, { dataKey: "after" })).toBe(1)
    expect(legendRank(bar, { dataKey: "missing" })).toBe(Number.MAX_SAFE_INTEGER)

    const pie = parseChartPayload(
      JSON.stringify({
        type: "pie",
        data: [
          { name: "zeta", v: 1 },
          { name: "alpha", v: 2 },
        ],
      })
    )
    expect(legendRank(pie, { value: "zeta" })).toBe(0)
    expect(legendRank(pie, { value: "alpha" })).toBe(1)
  })
})
