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

  it("shows memory utilization without inferring pressure", () => {
    render(<PerfMemoryPressure memory={{ totalBytes: 16_000_000_000, usedBytes: 8_000_000_000 }} />)
    const bar = screen.getByTestId("perf-mem-pressure-bar")
    expect(bar).toHaveAttribute("data-kind", "utilization")
    expect(bar).toHaveAttribute("aria-valuenow", "50")
  })

  it("reports exact utilization at 75%", () => {
    render(
      <PerfMemoryPressure memory={{ totalBytes: 16_000_000_000, usedBytes: 12_000_000_000 }} />
    )
    const bar = screen.getByTestId("perf-mem-pressure-bar")
    expect(bar).toHaveAttribute("aria-valuenow", "75")
  })

  it("reports exact utilization above 85% without a pressure label", () => {
    render(
      <PerfMemoryPressure memory={{ totalBytes: 16_000_000_000, usedBytes: 15_000_000_000 }} />
    )
    const bar = screen.getByTestId("perf-mem-pressure-bar")
    expect(bar).toHaveAttribute("aria-valuenow", "93.75")
  })

  it("caps bar width at 100%", () => {
    render(<PerfMemoryPressure memory={{ totalBytes: 8_000_000_000, usedBytes: 16_000_000_000 }} />)
    // 200% → capped to 100%
    const bar = screen.getByTestId("perf-mem-pressure-bar")
    expect(bar).toHaveAttribute("aria-valuenow", "100")
  })
})
