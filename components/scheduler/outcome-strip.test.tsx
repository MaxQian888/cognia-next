import { render, screen } from "@testing-library/react"

import { OutcomeStrip } from "./outcome-strip"
import { buildOutcomeCells } from "@/lib/scheduler/outcome-strip"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

const DAY = 24 * 60 * 60 * 1000

function run(startedAt: number, status: UnifiedExecutionRun["status"]): UnifiedExecutionRun {
  return {
    unifiedId: `app:${startedAt}:${status}`,
    kind: "app",
    itemUnifiedId: "app:x",
    itemName: "x",
    status,
    startedAt,
    origin: { tableName: "t", nativeId: String(startedAt) },
  }
}

describe("OutcomeStrip", () => {
  const now = new Date(2026, 8, 13, 12).getTime()

  it("renders one toned cell per day and the totals", () => {
    const cells = buildOutcomeCells(
      [
        run(now, "succeeded"),
        run(now - DAY, "failed"),
        run(now - 2 * DAY, "succeeded"),
        run(now - 2 * DAY, "failed"),
      ],
      { now, days: 4 }
    )
    render(<OutcomeStrip cells={cells} />)
    const items = screen.getAllByTestId("outcome-strip-cell")
    expect(items).toHaveLength(4)
    expect(items.map((cell) => cell.dataset.tone)).toEqual(["none", "mixed", "failure", "success"])
    expect(items[3]).toHaveAttribute("aria-label", expect.stringContaining("1 succeeded"))
    expect(screen.getByTestId("outcome-strip-succeeded")).toHaveTextContent("2 succeeded")
    expect(screen.getByTestId("outcome-strip-failed")).toHaveTextContent("2 failed")
    expect(screen.getByTestId("outcome-strip-rate")).toHaveTextContent("50% success")
  })

  it("says there are no finished runs rather than 0%", () => {
    render(
      <OutcomeStrip cells={buildOutcomeCells([run(now, "running")], { now, days: 2 })} testId="s" />
    )
    expect(screen.getByTestId("s-rate")).toHaveTextContent("No finished runs")
    expect(screen.getAllByTestId("s-cell")[1].dataset.tone).toBe("running")
  })
})
