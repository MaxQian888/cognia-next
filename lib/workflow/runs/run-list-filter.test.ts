import {
  DEFAULT_RUN_FILTERS,
  distinctTriggerKinds,
  filterRuns,
  isRunFilterActive,
  summarizeRuns,
  type RunListFilters,
} from "./run-list-filter"
import { DEFAULT_WORKFLOW_SETTINGS, type WorkflowRunRow } from "@/types/workflow/visual"

function run(patch: Partial<WorkflowRunRow> & Pick<WorkflowRunRow, "id">): WorkflowRunRow {
  return {
    workflowId: "wf",
    status: "succeeded",
    triggerKind: "trigger.manual",
    triggerPayload: {},
    startedAt: 1000,
    workflowSnapshot: {
      id: "wf",
      schemaVersion: 2,
      name: "wf",
      createdAt: 0,
      updatedAt: 0,
      nodes: [],
      edges: [],
      settings: DEFAULT_WORKFLOW_SETTINGS,
    },
    ...patch,
  }
}

const NOW = 10_000_000

describe("isRunFilterActive", () => {
  it("is false for the default filters", () => {
    expect(isRunFilterActive(DEFAULT_RUN_FILTERS)).toBe(false)
  })
  it.each<[Partial<RunListFilters>, boolean]>([
    [{ status: "failed" }, true],
    [{ triggerKind: "trigger.cron" }, true],
    [{ window: "24h" }, true],
    [{ query: "abc" }, true],
    [{ query: "   " }, false], // whitespace-only is NOT active
  ])("reflects %p as %p", (patch, expected) => {
    expect(isRunFilterActive({ ...DEFAULT_RUN_FILTERS, ...patch })).toBe(expected)
  })
})

describe("filterRuns", () => {
  const runs = [
    run({ id: "r1", status: "succeeded", triggerKind: "trigger.manual", startedAt: NOW - 1000 }),
    run({
      id: "r2",
      status: "failed",
      triggerKind: "trigger.cron",
      startedAt: NOW - 2 * 24 * 60 * 60 * 1000,
    }),
    run({
      id: "r3",
      status: "running",
      triggerKind: "trigger.cron",
      startedAt: NOW - 10 * 24 * 60 * 60 * 1000,
    }),
  ]

  it("returns all runs with default filters", () => {
    expect(filterRuns(runs, DEFAULT_RUN_FILTERS, NOW)).toHaveLength(3)
  })
  it("filters by status", () => {
    expect(
      filterRuns(runs, { ...DEFAULT_RUN_FILTERS, status: "failed" }, NOW).map((r) => r.id)
    ).toEqual(["r2"])
  })
  it("filters by trigger kind", () => {
    expect(
      filterRuns(runs, { ...DEFAULT_RUN_FILTERS, triggerKind: "trigger.cron" }, NOW).map(
        (r) => r.id
      )
    ).toEqual(["r2", "r3"])
  })
  it("filters by time window", () => {
    expect(
      filterRuns(runs, { ...DEFAULT_RUN_FILTERS, window: "24h" }, NOW).map((r) => r.id)
    ).toEqual(["r1"])
    expect(
      filterRuns(runs, { ...DEFAULT_RUN_FILTERS, window: "7d" }, NOW).map((r) => r.id)
    ).toEqual(["r1", "r2"])
    expect(
      filterRuns(runs, { ...DEFAULT_RUN_FILTERS, window: "30d" }, NOW).map((r) => r.id)
    ).toEqual(["r1", "r2", "r3"])
  })
  it("filters by text against id and trigger kind", () => {
    expect(filterRuns(runs, { ...DEFAULT_RUN_FILTERS, query: "r3" }, NOW).map((r) => r.id)).toEqual(
      ["r3"]
    )
    expect(
      filterRuns(runs, { ...DEFAULT_RUN_FILTERS, query: "CRON" }, NOW).map((r) => r.id)
    ).toEqual(["r2", "r3"])
  })
  it("combines facets", () => {
    const filters = {
      status: "failed" as const,
      triggerKind: "trigger.cron",
      window: "7d" as const,
      query: "",
    }
    expect(filterRuns(runs, filters, NOW).map((r) => r.id)).toEqual(["r2"])
  })
})

describe("distinctTriggerKinds", () => {
  it("returns sorted unique kinds", () => {
    const runs = [
      run({ id: "a", triggerKind: "trigger.cron" }),
      run({ id: "b", triggerKind: "trigger.manual" }),
      run({ id: "c", triggerKind: "trigger.cron" }),
    ]
    expect(distinctTriggerKinds(runs)).toEqual(["trigger.cron", "trigger.manual"])
  })
})

describe("summarizeRuns", () => {
  it("rolls up counts, success rate, and average duration", () => {
    const runs = [
      run({ id: "r1", status: "succeeded", startedAt: 0, completedAt: 100 }),
      run({ id: "r2", status: "succeeded", startedAt: 0, completedAt: 300 }),
      run({ id: "r3", status: "failed", startedAt: 0, completedAt: 200 }),
      run({ id: "r4", status: "running", startedAt: 0 }),
    ]
    const s = summarizeRuns(runs)
    expect(s).toEqual({
      total: 4,
      succeeded: 2,
      failed: 1,
      running: 1,
      successRate: 0.5,
      avgDurationMs: 200, // (100+300+200)/3
    })
  })
  it("returns null rates for an empty set", () => {
    expect(summarizeRuns([])).toEqual({
      total: 0,
      succeeded: 0,
      failed: 0,
      running: 0,
      successRate: null,
      avgDurationMs: null,
    })
  })
})
