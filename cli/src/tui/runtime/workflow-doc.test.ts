import type { WorkflowRow, WorkflowRunRow } from "@/types/workflow/visual"

import {
  buildRunsDocument,
  buildWorkflowDocument,
  formatRunDuration,
  runStatusIcon,
} from "./workflow-doc"

const FIXED_TIME = (ms: number) => `T+${ms}`

function wf(overrides: Partial<WorkflowRow> = {}): WorkflowRow {
  return {
    id: "wf1",
    name: "Nightly digest",
    description: "Summarize the day",
    nodes: [
      { id: "n_start", type: "trigger.manual", data: { label: "Start", params: {} } },
      { id: "n_ai", type: "ai.prompt", data: { label: "Summarize", params: {} } },
    ],
    edges: [{ id: "e1", source: "n_start", target: "n_ai" }],
    settings: { errorPolicy: "stop", timeoutMs: 30000, maxConcurrency: 2 },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as unknown as WorkflowRow
}

function run(overrides: Partial<WorkflowRunRow> = {}): WorkflowRunRow {
  return {
    id: "run1",
    workflowId: "wf1",
    status: "succeeded",
    triggerKind: "trigger.manual",
    triggerPayload: {},
    startedAt: 1000,
    completedAt: 3300,
    workflowSnapshot: {} as never,
    ...overrides,
  } as WorkflowRunRow
}

describe("formatRunDuration", () => {
  it("renders sub-second, seconds, and minutes", () => {
    expect(formatRunDuration(850)).toBe("850ms")
    expect(formatRunDuration(2300)).toBe("2.3s")
    expect(formatRunDuration(65000)).toBe("1m 5s")
  })

  it("returns a dash when the run has not completed", () => {
    expect(formatRunDuration(undefined)).toBe("—")
  })
})

describe("runStatusIcon", () => {
  it("maps every status to a glyph", () => {
    for (const s of ["succeeded", "failed", "running", "cancelled", "paused"] as const) {
      expect(runStatusIcon(s).length).toBeGreaterThan(0)
    }
  })
})

describe("buildWorkflowDocument", () => {
  it("includes the name, description, node table, and settings", () => {
    const doc = buildWorkflowDocument(wf(), [], FIXED_TIME)
    expect(doc).toContain("# Nightly digest")
    expect(doc).toContain("Summarize the day")
    expect(doc).toContain("`n_ai`")
    expect(doc).toContain("ai.prompt")
    expect(doc).toContain("Summarize")
    expect(doc).toContain("stop") // error policy
    expect(doc).toContain("2") // max concurrency
  })

  it("says when there are no runs", () => {
    expect(buildWorkflowDocument(wf(), [], FIXED_TIME)).toContain("No runs yet")
  })

  it("summarizes recent runs with status + duration", () => {
    const doc = buildWorkflowDocument(wf(), [run()], FIXED_TIME)
    expect(doc).toContain("succeeded")
    expect(doc).toContain("2.3s")
    expect(doc).toContain("T+1000")
  })

  it("falls back gracefully when description is missing", () => {
    const doc = buildWorkflowDocument(wf({ description: undefined }), [], FIXED_TIME)
    expect(doc).toContain("_No description._")
  })
})

describe("buildRunsDocument", () => {
  it("lists each run with status, duration, and a failed node", () => {
    const runs = [
      run({ id: "r2", status: "failed", error: { message: "boom", nodeId: "n_ai" } }),
      run({ id: "r1", status: "succeeded" }),
    ]
    const doc = buildRunsDocument(wf(), runs, FIXED_TIME)
    expect(doc).toContain("# Runs · Nightly digest")
    expect(doc).toContain("failed")
    expect(doc).toContain("boom")
    expect(doc).toContain("n_ai")
    expect(doc).toContain("succeeded")
  })

  it("says when there are no runs", () => {
    expect(buildRunsDocument(wf(), [], FIXED_TIME)).toContain("No runs recorded yet")
  })
})
