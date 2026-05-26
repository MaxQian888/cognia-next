/**
 * @jest-environment jsdom
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { PerfHotspotsTable } from "./perf-hotspots-table"
import type { SpanSnapshot } from "@/lib/perf/backend/types"

function span(name: string, totalMs: number, errors = 0, buckets?: number[]): SpanSnapshot {
  return {
    name,
    count: 10,
    errorCount: errors,
    totalMs,
    avgMs: totalMs / 10,
    minMs: 1,
    maxMs: totalMs,
    p50Ms: totalMs / 20,
    p95Ms: totalMs / 12,
    lastTsMs: 0,
    buckets: buckets ?? new Array(25).fill(0),
  }
}

describe("PerfHotspotsTable", () => {
  it("shows empty state + hint when there are no spans", () => {
    render(<PerfHotspotsTable spans={[]} />)
    expect(screen.getByTestId("perf-hot-empty")).toBeInTheDocument()
  })

  it("renders a row per span and an error badge only when errors > 0", () => {
    render(<PerfHotspotsTable spans={[span("ocr.extract", 100, 2), span("vector.query", 50, 0)]} />)
    expect(screen.getByTestId("perf-hot-row-ocr.extract")).toBeInTheDocument()
    expect(screen.getByTestId("perf-hot-row-vector.query")).toBeInTheDocument()
    // error badge "2" present for the first, "0" plain text for the second.
    expect(screen.getByText("2")).toBeInTheDocument()
  })

  it("draws a full-width bar for the heaviest span", () => {
    render(<PerfHotspotsTable spans={[span("a", 100), span("b", 25)]} />)
    expect(screen.getByTestId("perf-hot-bar-a")).toHaveStyle({ width: "100%" })
    expect(screen.getByTestId("perf-hot-bar-b")).toHaveStyle({ width: "25%" })
  })

  it("defaults to total-desc and toggles to ascending on click", () => {
    render(<PerfHotspotsTable spans={[span("a", 100), span("b", 25)]} />)
    let rows = screen.getAllByTestId(/perf-hot-row-/)
    expect(rows[0]).toHaveAttribute("data-testid", "perf-hot-row-a")
    fireEvent.click(screen.getByTestId("perf-hot-th-totalMs"))
    rows = screen.getAllByTestId(/perf-hot-row-/)
    expect(rows[0]).toHaveAttribute("data-testid", "perf-hot-row-b")
  })

  it("renders a latency-distribution sparkbar per span", () => {
    const buckets = new Array(25).fill(0)
    buckets[9] = 8
    buckets[19] = 2
    render(<PerfHotspotsTable spans={[span("a", 100, 0, buckets)]} />)
    const dist = screen.getByTestId("perf-hot-dist-a")
    // 25 bucket bars are rendered inside the strip.
    expect(dist.children).toHaveLength(25)
  })

  it("sorts by name when requested", () => {
    render(<PerfHotspotsTable spans={[span("zeta", 100), span("alpha", 25)]} />)
    fireEvent.click(screen.getByTestId("perf-hot-th-name"))
    const rows = screen.getAllByTestId(/perf-hot-row-/)
    expect(rows[0]).toHaveAttribute("data-testid", "perf-hot-row-alpha")
  })
})
