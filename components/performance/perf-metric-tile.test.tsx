/**
 * @jest-environment jsdom
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  AreaChart: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Area: () => <div data-testid="spark" />,
}))

import { PerfMetricTile } from "./perf-metric-tile"

describe("PerfMetricTile", () => {
  it("renders label + value and reflects active state", () => {
    render(
      <PerfMetricTile
        label="App CPU"
        value="42%"
        points={[1, 2]}
        color="#fff"
        active
        onSelect={() => {}}
        data-testid="tile"
      />
    )
    expect(screen.getByText("App CPU")).toBeInTheDocument()
    expect(screen.getByText("42%")).toBeInTheDocument()
    expect(screen.getByTestId("tile")).toHaveAttribute("aria-pressed", "true")
  })

  it("fires onSelect when clicked", () => {
    const onSelect = jest.fn()
    render(
      <PerfMetricTile
        label="Mem"
        value="1 GB"
        points={[]}
        color="#fff"
        active={false}
        onSelect={onSelect}
        data-testid="tile"
      />
    )
    fireEvent.click(screen.getByTestId("tile"))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("tile")).toHaveAttribute("aria-pressed", "false")
  })
})
