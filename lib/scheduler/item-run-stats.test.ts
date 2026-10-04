import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

import { summarizeItemRuns } from "./item-run-stats"

function run(
  id: string,
  status: UnifiedExecutionRun["status"],
  startedAt: number,
  durationMs?: number
): UnifiedExecutionRun {
  return {
    unifiedId: `app:${id}`,
    kind: "app",
    itemUnifiedId: "app:t1",
    itemName: "Task",
    status,
    startedAt,
    durationMs,
    origin: { tableName: "taskExecutions", nativeId: id },
  }
}

describe("summarizeItemRuns", () => {
  it("counts the loaded runs when there is no app-table row", () => {
    const stats = summarizeItemRuns([
      run("a", "succeeded", 1_000, 200),
      run("b", "failed", 2_000, 400),
      run("c", "succeeded", 3_000),
      run("d", "running", 4_000),
      run("e", "cancelled", 500, 10_000),
    ])
    expect(stats).toMatchObject({
      total: 3,
      succeeded: 2,
      failed: 1,
      successRate: 67,
      running: 1,
      basis: "loaded-runs",
    })
    // Only settled runs that recorded a duration; cancelled runs never count.
    expect(stats.averageDurationMs).toBe(300)
    expect(stats.lastRun).toEqual({ status: "running", startedAt: 4_000, durationMs: undefined })
  })

  it("prefers the row's lifetime counters over one page of runs", () => {
    const stats = summarizeItemRuns([run("a", "succeeded", 1_000, 100)], {
      successCount: 40,
      failureCount: 10,
    })
    expect(stats).toMatchObject({
      total: 50,
      succeeded: 40,
      failed: 10,
      successRate: 80,
      basis: "lifetime",
    })
    expect(stats.averageDurationMs).toBe(100)
  })

  it("falls back to the runs when the row's counters are behind them", () => {
    const stats = summarizeItemRuns([run("a", "succeeded", 1_000), run("b", "succeeded", 2_000)], {
      successCount: 0,
      failureCount: 0,
    })
    expect(stats.basis).toBe("loaded-runs")
    expect(stats.total).toBe(2)
  })

  it("reports no rate and no duration before anything has settled", () => {
    const stats = summarizeItemRuns([])
    expect(stats.successRate).toBeNull()
    expect(stats.averageDurationMs).toBeNull()
    expect(stats.lastRun).toBeNull()
  })
})
