/**
 * @jest-environment jsdom
 */

import React from "react"
import { render, screen } from "@testing-library/react"

jest.mock("recharts", () => ({
  ResponsiveContainer: ({
    children,
    initialDimension,
  }: {
    children?: React.ReactNode
    initialDimension?: { width: number; height: number }
  }) => (
    <div data-testid="spark-rc" data-initial-dimension={JSON.stringify(initialDimension)}>
      {children}
    </div>
  ),
  AreaChart: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Area: (props: { stroke?: string; strokeWidth?: number; fillOpacity?: number }) => (
    <div
      data-testid="spark-area"
      data-stroke={props.stroke}
      data-stroke-width={props.strokeWidth}
      data-fill-opacity={props.fillOpacity}
    />
  ),
}))

import { PerfSparkline } from "./perf-sparkline"

describe("PerfSparkline", () => {
  it("renders an area for the series", () => {
    render(<PerfSparkline points={[1, 2, 3]} color="#abc" data-testid="sp" />)
    expect(screen.getByTestId("sp")).toBeInTheDocument()
    const area = screen.getByTestId("spark-area")
    expect(area).toHaveAttribute("data-stroke", "#abc")
  })

  it("applies default stroke width / fill opacity", () => {
    render(<PerfSparkline points={[1]} color="#abc" />)
    const area = screen.getByTestId("spark-area")
    expect(area).toHaveAttribute("data-stroke-width", "1.5")
    expect(area).toHaveAttribute("data-fill-opacity", "0.18")
  })

  it("honors overridden stroke width / fill opacity and sizing class", () => {
    const { container } = render(
      <PerfSparkline
        points={[]}
        color="#abc"
        strokeWidth={1}
        fillOpacity={0.15}
        className="h-4 w-14"
      />
    )
    const area = screen.getByTestId("spark-area")
    expect(area).toHaveAttribute("data-stroke-width", "1")
    expect(area).toHaveAttribute("data-fill-opacity", "0.15")
    expect(container.querySelector(".h-4.w-14")).toBeTruthy()
  })

  it("passes a positive initialDimension so recharts never renders at -1×-1", () => {
    // Without this, ResponsiveContainer's first render (before ResizeObserver
    // reports) warns "The width(-1) and height(-1) of chart should be greater
    // than 0" — seen live on the status-bar perf sparkline.
    render(<PerfSparkline points={[1, 2]} color="#abc" />)
    const dim = JSON.parse(
      screen.getByTestId("spark-rc").getAttribute("data-initial-dimension") ?? "null"
    ) as { width: number; height: number } | null
    expect(dim).not.toBeNull()
    expect(dim!.width).toBeGreaterThan(0)
    expect(dim!.height).toBeGreaterThan(0)
  })
})
