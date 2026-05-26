/**
 * @jest-environment jsdom
 */

import React from "react"
import { render, screen } from "@testing-library/react"
import { PerfMemoryPressure } from "./perf-memory-pressure"

describe("PerfMemoryPressure", () => {
  it("renders em-dashes when memory is null", () => {
    render(<PerfMemoryPressure memory={null} />)
    expect(screen.getByTestId("perf-memory-pressure")).toBeInTheDocument()
    // Both used and total show "—" when memory is null.
    const dashes = screen.getAllByText("—")
    expect(dashes.length).toBeGreaterThanOrEqual(1)
  })

  it("shows low pressure for <70% usage", () => {
    render(<PerfMemoryPressure memory={{ totalBytes: 16_000_000_000, usedBytes: 8_000_000_000 }} />)
    // 50% → low (green)
    const bar = screen.getByTestId("perf-mem-pressure-bar")
    expect(bar.className).toContain("bg-green")
  })

  it("shows moderate pressure for 70-85% usage", () => {
    render(
      <PerfMemoryPressure memory={{ totalBytes: 16_000_000_000, usedBytes: 12_000_000_000 }} />
    )
    // 75% → moderate (yellow)
    const bar = screen.getByTestId("perf-mem-pressure-bar")
    expect(bar.className).toContain("bg-yellow")
  })

  it("shows high pressure for >=85% usage", () => {
    render(
      <PerfMemoryPressure memory={{ totalBytes: 16_000_000_000, usedBytes: 15_000_000_000 }} />
    )
    // ~94% → high (red)
    const bar = screen.getByTestId("perf-mem-pressure-bar")
    expect(bar.className).toContain("bg-red")
  })

  it("caps bar width at 100%", () => {
    render(<PerfMemoryPressure memory={{ totalBytes: 8_000_000_000, usedBytes: 16_000_000_000 }} />)
    // 200% → capped to 100%
    const bar = screen.getByTestId("perf-mem-pressure-bar")
    expect(bar).toHaveStyle({ width: "100%" })
  })
})
