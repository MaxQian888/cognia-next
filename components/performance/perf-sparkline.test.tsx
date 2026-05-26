/**
 * @jest-environment jsdom
 */

import React from "react"
import { render, screen } from "@testing-library/react"

jest.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
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
})
