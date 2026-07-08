/**
 * @jest-environment jsdom
 */

import React from "react"
import { render, screen } from "@testing-library/react"

jest.mock("recharts", () => ({
  ResponsiveContainer: ({
    children,
    height,
    initialDimension,
  }: {
    children?: React.ReactNode
    height?: number | string
    initialDimension?: { width: number; height: number }
  }) => (
    <div
      data-testid="rc"
      data-height={String(height)}
      data-initial-dimension={JSON.stringify(initialDimension)}
    >
      {children}
    </div>
  ),
  AreaChart: ({ children, data }: { children?: React.ReactNode; data?: unknown[] }) => (
    <div data-testid="area-chart" data-len={data?.length ?? 0}>
      {children}
    </div>
  ),
  Area: () => <div data-testid="area" />,
  CartesianGrid: () => null,
  YAxis: () => null,
  // Exercise the value/label formatters so their output is asserted rather
  // than left untested behind the real recharts Tooltip.
  Tooltip: ({
    formatter,
    labelFormatter,
  }: {
    formatter?: (v: number) => [string, string]
    labelFormatter?: (l: string) => string
  }) => (
    <div
      data-testid="tooltip"
      data-formatted={formatter ? JSON.stringify(formatter(42.345)) : ""}
      data-label={labelFormatter ? `[${labelFormatter("x")}]` : ""}
    />
  ),
  ReferenceLine: ({ y, stroke }: { y?: number; stroke?: string }) => (
    <div data-testid="ref-line" data-y={y} data-stroke={stroke} />
  ),
}))

jest.mock("@/lib/observability/chart-config", () => ({
  TOOLTIP_STYLE: { contentStyle: {}, labelStyle: {}, itemStyle: {} },
}))
jest.mock("@/hooks/logging/use-theme-colors", () => ({
  useThemeColors: () => ({ destructive: "#ef4444", "muted-foreground": "#888" }),
}))

import { PerfGraphCard, perfYDomain } from "./perf-graph-card"

describe("PerfGraphCard", () => {
  it("renders the title, current value, and the series", () => {
    render(
      <PerfGraphCard
        title="App CPU"
        current="42.3%"
        points={[1, 2, 3]}
        color="#fff"
        max={100}
        data-testid="card"
      />
    )
    expect(screen.getByText("App CPU")).toBeInTheDocument()
    expect(screen.getByTestId("perf-graph-value")).toHaveTextContent("42.3%")
    expect(screen.getByTestId("area-chart")).toHaveAttribute("data-len", "3")
    // Tooltip formats the value to one decimal and labels it with the title,
    // and blanks the (index-based) label.
    expect(screen.getByTestId("tooltip")).toHaveAttribute(
      "data-formatted",
      JSON.stringify(["42.3", "App CPU"])
    )
    expect(screen.getByTestId("tooltip")).toHaveAttribute("data-label", "[]")
    // Positive initialDimension pre-empts recharts' -1×-1 first-render warning.
    const dim = JSON.parse(screen.getByTestId("rc").getAttribute("data-initial-dimension")!) as {
      width: number
      height: number
    }
    expect(dim.width).toBeGreaterThan(0)
    expect(dim.height).toBe(220)
  })

  it("renders an optional subtitle", () => {
    render(
      <PerfGraphCard title="Mem" current="1 GB" points={[]} color="#fff" subtitle="peak 2 GB" />
    )
    expect(screen.getByTestId("perf-graph-subtitle")).toHaveTextContent("peak 2 GB")
  })

  it("omits the subtitle node when not provided", () => {
    render(<PerfGraphCard title="Mem" current="1 GB" points={[]} color="#fff" />)
    expect(screen.queryByTestId("perf-graph-subtitle")).not.toBeInTheDocument()
  })

  it("renders a threshold line when threshold is provided", () => {
    render(
      <PerfGraphCard
        title="CPU"
        current="50%"
        points={[30, 60, 90]}
        color="#fff"
        max={100}
        threshold={80}
      />
    )
    const refLine = screen.getByTestId("ref-line")
    expect(refLine).toHaveAttribute("data-y", "80")
    // Uses the resolved theme color, not the invalid `hsl(var(--destructive))`.
    expect(refLine).toHaveAttribute("data-stroke", "#ef4444")
  })

  it("omits the threshold line when threshold is undefined", () => {
    render(<PerfGraphCard title="Tasks" current="12" points={[10, 12]} color="#fff" />)
    expect(screen.queryByTestId("ref-line")).not.toBeInTheDocument()
  })

  it("uses a fixed pixel height by default", () => {
    render(<PerfGraphCard title="CPU" current="1%" points={[1]} color="#fff" height={200} />)
    expect(screen.getByTestId("rc")).toHaveAttribute("data-height", "200")
  })

  it("fills the card height (height='100%' with a min-height floor) in fill mode", () => {
    render(<PerfGraphCard title="CPU" current="1%" points={[1]} color="#fff" height={320} fill />)
    expect(screen.getByTestId("rc")).toHaveAttribute("data-height", "100%")
    // The wrapper enforces a minimum height so the chart never collapses when
    // the grid row is short (e.g. single-column mobile layout).
    const wrapper = screen.getByTestId("rc").parentElement
    expect(wrapper).toHaveStyle({ minHeight: "320px" })
  })
})

describe("perfYDomain", () => {
  it("pins the axis exactly when a fixed max is given", () => {
    expect(perfYDomain(100)).toEqual([0, 100])
  })

  it("returns a headroom function for an auto axis", () => {
    const [min, maxFn] = perfYDomain()
    expect(min).toBe(0)
    expect(typeof maxFn).toBe("function")
    const fn = maxFn as (dataMax: number) => number
    // ~10% headroom above the peak, rounded up.
    expect(fn(50)).toBe(55)
    expect(fn(10)).toBe(11)
    // Degenerate peaks (flat-zero / empty series) floor to 1 so the axis is valid.
    expect(fn(0)).toBe(1)
    expect(fn(-Infinity)).toBe(1)
  })
})
