import { buildOutcomeCells, summarizeOutcomeCells } from "./outcome-strip"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

const DAY = 24 * 60 * 60 * 1000

function run(startedAt: number, status: UnifiedExecutionRun["status"]): UnifiedExecutionRun {
  return {
    unifiedId: `app:${startedAt}`,
    kind: "app",
    itemUnifiedId: "app:x",
    itemName: "x",
    status,
    startedAt,
    origin: { tableName: "t", nativeId: String(startedAt) },
  }
}

describe("buildOutcomeCells", () => {
  const now = new Date(2026, 8, 13, 15, 30).getTime()

  it("builds one cell per day ending today, oldest first", () => {
    const cells = buildOutcomeCells([], { now, days: 3 })
    expect(cells.map((c) => c.key)).toEqual(["2026-09-11", "2026-09-12", "2026-09-13"])
    expect(cells.every((c) => c.tone === "none")).toBe(true)
  })

  it("tones each day by its outcomes", () => {
    const cells = buildOutcomeCells(
      [
        run(now - 2 * DAY, "succeeded"),
        run(now - DAY, "succeeded"),
        run(now - DAY, "failed"),
        run(now - 3 * DAY, "failed"),
        run(now, "running"),
        run(now - 4 * DAY, "cancelled"),
        run(now - 40 * DAY, "failed"),
      ],
      { now, days: 5 }
    )
    expect(cells.map((c) => c.tone)).toEqual(["none", "failure", "success", "mixed", "running"])
    expect(cells[0].other).toBe(1)
  })

  it("defaults to fourteen days", () => {
    expect(buildOutcomeCells([], { now })).toHaveLength(14)
  })
})

describe("summarizeOutcomeCells", () => {
  it("totals and rates, with null when nothing finished", () => {
    const now = Date.now()
    expect(summarizeOutcomeCells(buildOutcomeCells([], { now }))).toEqual({
      succeeded: 0,
      failed: 0,
      successRate: null,
    })
    const cells = buildOutcomeCells(
      [run(now, "succeeded"), run(now, "succeeded"), run(now, "failed"), run(now, "running")],
      { now }
    )
    expect(summarizeOutcomeCells(cells)).toEqual({ succeeded: 2, failed: 1, successRate: 67 })
  })
})
