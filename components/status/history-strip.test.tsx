import { act, fireEvent, render, screen } from "@testing-library/react"

import { createStatusFixture } from "@/lib/status/fixtures"
import { summarizeAvailability, type HistoryBucket } from "@/lib/status/public-status"

import { HistoryLegend, HistoryRangeSelector, HistoryStrip } from "./history-strip"

function bucket(
  overrides: Partial<HistoryBucket>,
  counts = { pass: 58, fail: 1, expected: 60, excluded: 0 }
): HistoryBucket {
  return {
    start: "2026-10-02T08:00:00.000Z",
    end: "2026-10-02T09:00:00.000Z",
    partial: false,
    status: "degraded",
    availability: summarizeAvailability({
      passCount: counts.pass,
      failCount: counts.fail,
      expectedSlots: counts.expected,
      excludedSlots: counts.excluded,
      excludedPassCount: 0,
      excludedFailCount: 0,
    }),
    ...overrides,
  }
}

describe("HistoryStrip", () => {
  it("renders one cell per bucket of the range", () => {
    const snapshot = createStatusFixture("operational", "90d")
    render(
      <HistoryStrip buckets={snapshot.components[0]!.history} range="90d" name="Signaling HTTP" />
    )
    expect(screen.getAllByTestId("history-cell")).toHaveLength(90)
    expect(
      screen.getByRole("group", { name: "Signaling HTTP history, 90 days" })
    ).toBeInTheDocument()
  })

  it("describes each cell's counts, coverage, availability and maintenance exclusions", () => {
    render(
      <HistoryStrip
        buckets={[bucket({}, { pass: 50, fail: 2, expected: 60, excluded: 5 })]}
        range="24h"
        name="Relay data lane"
      />
    )
    const cell = screen.getByTestId("history-cell")
    const label = cell.getAttribute("aria-label")!
    expect(label).toContain("Oct 2, 2026 08:00–09:00 UTC: Degraded.")
    expect(label).toContain("50 passed, 2 failed, 8 without a result, of 60 expected checks.")
    expect(label).toContain("Availability 96.15%, coverage 86.66%.")
    expect(label).toContain("5 minutes excluded for maintenance.")
    expect(cell).toHaveAttribute("title", label)
  })

  it("keeps no-data cells visibly distinct and never reports 100 for them", () => {
    render(
      <HistoryStrip
        buckets={[bucket({ status: "no_data" }, { pass: 0, fail: 0, expected: 0, excluded: 0 })]}
        range="7d"
        name="Signaling HTTP"
      />
    )
    const cell = screen.getByTestId("history-cell")
    expect(cell).toHaveAttribute("data-status", "no_data")
    expect(cell.className).toMatch(/border-dashed/)
    expect(cell.getAttribute("aria-label")).toContain("Availability No data, coverage No data.")
  })

  it("marks incomplete periods", () => {
    render(<HistoryStrip buckets={[bucket({ partial: true })]} range="24h" name="X" />)
    const cell = screen.getByTestId("history-cell")
    expect(cell).toHaveAttribute("data-partial", "true")
    expect(cell.getAttribute("aria-label")).toContain("Period incomplete.")
  })

  it("is one tab stop with arrow-key navigation and writes the focused period out", () => {
    const buckets = [
      bucket({
        start: "2026-10-02T07:00:00.000Z",
        end: "2026-10-02T08:00:00.000Z",
        status: "operational",
      }),
      bucket({ start: "2026-10-02T08:00:00.000Z", end: "2026-10-02T09:00:00.000Z" }),
    ]
    render(<HistoryStrip buckets={buckets} range="24h" name="X" />)
    const cells = screen.getAllByTestId("history-cell")
    expect(cells.map((cell) => cell.tabIndex)).toEqual([-1, 0])
    expect(screen.getByTestId("history-detail")).toHaveTextContent("24 hours ago")

    act(() => cells[1]!.focus())
    expect(screen.getByTestId("history-detail")).toHaveTextContent("08:00–09:00")
    fireEvent.keyDown(screen.getByRole("group"), { key: "ArrowLeft" })
    expect(document.activeElement).toBe(cells[0])
    expect(screen.getByTestId("history-detail")).toHaveTextContent("07:00–08:00 UTC: Operational")
    fireEvent.keyDown(screen.getByRole("group"), { key: "End" })
    expect(document.activeElement).toBe(cells[1])
  })

  it("renders nothing for an empty history", () => {
    const { container } = render(<HistoryStrip buckets={[]} range="24h" name="X" />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe("HistoryRangeSelector", () => {
  it("offers each advertised range and reports the choice", () => {
    const onChange = jest.fn()
    render(
      <HistoryRangeSelector
        value="90d"
        ranges={["24h", "7d", "30d", "90d"]}
        onChange={onChange}
        pending={false}
      />
    )
    const group = screen.getByRole("radiogroup", { name: "History range" })
    expect(group).toBeInTheDocument()
    fireEvent.click(screen.getByRole("radio", { name: "24 hours" }))
    expect(onChange).toHaveBeenCalledWith("24h")
    expect(screen.getByRole("radio", { name: "90 days" })).toHaveAttribute("aria-checked", "true")
  })
})

describe("HistoryLegend", () => {
  it("lists every cell style including unknown, no data and incomplete", () => {
    render(<HistoryLegend />)
    const legend = screen.getByRole("list", { name: "History legend" })
    expect(legend).toHaveTextContent("Unknown")
    expect(legend).toHaveTextContent("No data")
    expect(legend).toHaveTextContent("Incomplete period")
  })
})
