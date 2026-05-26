/**
 * @jest-environment jsdom
 */

import React from "react"
import { render, screen } from "@testing-library/react"

jest.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="rc">{children}</div>
  ),
  AreaChart: ({ children, data }: { children?: React.ReactNode; data?: unknown[] }) => (
    <div data-testid="area-chart" data-len={data?.length ?? 0}>
      {children}
    </div>
  ),
  Area: () => <div data-testid="area" />,
  CartesianGrid: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  ReferenceLine: ({ y, stroke }: { y?: number; stroke?: string }) => (
    <div data-testid="ref-line" data-y={y} data-stroke={stroke} />
  ),
}))

jest.mock("@/lib/observability/chart-config", () => ({
  TOOLTIP_STYLE: { contentStyle: {} },
}))
jest.mock("@/hooks/logging/use-theme-colors", () => ({
  useThemeColors: () => ({ destructive: "#ef4444" }),
}))

import { PerfGraphCard } from "./perf-graph-card"

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
})
