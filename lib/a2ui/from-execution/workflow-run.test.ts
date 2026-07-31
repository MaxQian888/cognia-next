import type { VisualWorkflow, WorkflowRunEventRow, WorkflowRunRow } from "@/types/workflow/visual"

import type { ExecutionPageLabels } from "./types"
import { buildWorkflowRunPage, formatDurationMs, stringifyOutput } from "./workflow-run"

const labels: ExecutionPageLabels = {
  status: "Status",
  trigger: "Trigger",
  duration: "Duration",
  tokens: "Tokens",
  cost: "Cost",
  steps: "Steps",
  succeeded: "Succeeded",
  failed: "Failed",
  stepBreakdown: "Step breakdown",
  stepDuration: "Step duration",
  tokenBurn: "Token burn",
  outputs: "Outputs",
  error: "Error",
  model: "Model",
  messages: "Messages",
  user: "User",
  assistant: "Assistant",
  toolCalls: "Tool calls",
  turns: "Turns",
  turn: "Turn",
  role: "Role",
  preview: "Preview",
  finalOutput: "Final output",
  summary: "Summary",
  insights: "Insights",
  untitled: "Untitled",
  unknown: "Unknown",
}

function node(id: string, type: string, label: string) {
  return { id, type, typeVersion: 1, position: { x: 0, y: 0 }, data: { label } }
}

function makeWorkflow(): VisualWorkflow {
  return {
    id: "wf1",
    schemaVersion: 2,
    name: "My Workflow",
    createdAt: 0,
    updatedAt: 0,
    nodes: [node("n1", "action.code", "Fetch"), node("n2", "action.ai", "Summarize")],
    edges: [],
    settings: {},
  } as unknown as VisualWorkflow
}

function makeRun(overrides: Partial<WorkflowRunRow> = {}): WorkflowRunRow {
  return {
    id: "run1",
    workflowId: "wf1",
    status: "succeeded",
    triggerKind: "trigger.manual",
    triggerPayload: {},
    startedAt: 1000,
    completedAt: 5000,
    workflowSnapshot: makeWorkflow(),
    title: "Nightly fetch",
    ...overrides,
  } as unknown as WorkflowRunRow
}

function makeEvents(): WorkflowRunEventRow[] {
  return [
    { id: "e1", runId: "run1", ts: 1000, type: "run_started" },
    { id: "e2", runId: "run1", ts: 1000, type: "step_started", stepId: "n1" },
    {
      id: "e3",
      runId: "run1",
      ts: 2000,
      type: "step_completed",
      stepId: "n1",
      payload: { output: { rows: 3 } },
    },
    { id: "e4", runId: "run1", ts: 2000, type: "step_started", stepId: "n2" },
    {
      id: "e5",
      runId: "run1",
      ts: 2500,
      type: "step_usage",
      stepId: "n2",
      payload: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.002 },
    },
    {
      id: "e6",
      runId: "run1",
      ts: 4000,
      type: "step_completed",
      stepId: "n2",
      payload: { output: "done" },
    },
    { id: "e7", runId: "run1", ts: 5000, type: "run_completed" },
  ] as unknown as WorkflowRunEventRow[]
}

describe("formatDurationMs", () => {
  it("formats ms / s / m+s and the empty case", () => {
    expect(formatDurationMs(undefined)).toBe("—")
    expect(formatDurationMs(-1)).toBe("—")
    expect(formatDurationMs(450)).toBe("450ms")
    expect(formatDurationMs(4200)).toBe("4.2s")
    expect(formatDurationMs(125000)).toBe("2m 5s")
  })
})

describe("stringifyOutput", () => {
  it("passes strings through and JSON-stringifies objects", () => {
    expect(stringifyOutput("hello")).toBe("hello")
    expect(stringifyOutput({ a: 1 })).toContain('"a": 1')
    expect(stringifyOutput(undefined)).toBe("")
  })
  it("truncates long output", () => {
    const long = "x".repeat(2000)
    const out = stringifyOutput(long, 100)
    expect(out.endsWith("…")).toBe(true)
    expect(out.length).toBe(101)
  })
})

describe("buildWorkflowRunPage", () => {
  it("derives id, title and description from the run", () => {
    const app = buildWorkflowRunPage(
      { kind: "workflow-run", run: makeRun(), events: makeEvents() },
      labels
    )
    expect(app.id).toBe("wfrun-page-run1")
    expect(app.name).toBe("Nightly fetch")
    expect(app.description).toContain("Steps: 2")
  })

  it("emits a single root and a valid createSurface message set", () => {
    const app = buildWorkflowRunPage(
      { kind: "workflow-run", run: makeRun(), events: makeEvents() },
      labels
    )
    expect(app.components.filter((c) => c.id === "root")).toHaveLength(1)
    expect(app.messages[0]).toMatchObject({ type: "createSurface", surfaceType: "inline" })
    expect(app.messages.some((m) => m.type === "surfaceReady")).toBe(true)
  })

  it("includes a status badge, KPI tiles, a step table and a duration chart", () => {
    const app = buildWorkflowRunPage(
      { kind: "workflow-run", run: makeRun(), events: makeEvents() },
      labels
    )
    const badge = app.components.find((c) => c.component === "Badge") as {
      text: string
      variant: string
    }
    expect(badge).toMatchObject({ text: "succeeded", variant: "default" })

    const table = app.components.find((c) => c.component === "Table") as {
      data: Record<string, unknown>[]
    }
    expect(table.data).toHaveLength(2)
    expect(table.data[0]).toMatchObject({ step: "Fetch" })

    const charts = app.components.filter((c) => c.component === "Chart") as Array<{
      chartType: string
    }>
    expect(charts.map((c) => c.chartType)).toEqual(expect.arrayContaining(["bar", "area"]))
  })

  it("renders per-step outputs and omits the token-burn chart when no tokens", () => {
    const events = makeEvents().filter((e) => e.type !== "step_usage")
    const app = buildWorkflowRunPage({ kind: "workflow-run", run: makeRun(), events }, labels)
    // step outputs become code-variant text cards
    const codeTexts = app.components.filter(
      (c) => c.component === "Text" && (c as { variant?: string }).variant === "code"
    )
    expect(codeTexts.length).toBeGreaterThanOrEqual(2)
    const areaChart = app.components.find(
      (c) => c.component === "Chart" && (c as { chartType: string }).chartType === "area"
    )
    expect(areaChart).toBeUndefined()
  })

  it("renders an error alert for failed runs", () => {
    const run = makeRun({ status: "failed", error: { message: "boom", code: "timeout" } })
    const app = buildWorkflowRunPage({ kind: "workflow-run", run, events: makeEvents() }, labels)
    const alert = app.components.find((c) => c.component === "Alert") as {
      message: string
      variant: string
    }
    expect(alert).toMatchObject({ variant: "error" })
    expect(alert.message).toBe("[timeout] boom")
  })

  it("falls back to the workflow snapshot name when title is blank", () => {
    const run = makeRun({ title: "   " })
    const app = buildWorkflowRunPage({ kind: "workflow-run", run, events: makeEvents() }, labels)
    expect(app.name).toBe("My Workflow")
  })

  it("derives the end time from events when completedAt is absent (running run)", () => {
    const run = makeRun({ status: "running", completedAt: undefined })
    const app = buildWorkflowRunPage({ kind: "workflow-run", run, events: makeEvents() }, labels)
    const badge = app.components.find((c) => c.component === "Badge") as { variant: string }
    expect(badge.variant).toBe("secondary")
    // duration meta is computed from latest event ts (5000) − startedAt (1000)
    const meta = app.components.find(
      (c) => c.component === "Text" && (c as { text: string }).text.includes("Duration")
    )
    expect((meta as { text: string }).text).toContain("4.0s")
  })

  it("skips step_completed events that carry no output", () => {
    const events = [
      { id: "e1", runId: "run1", ts: 1000, type: "step_started", stepId: "n1" },
      { id: "e2", runId: "run1", ts: 2000, type: "step_completed", stepId: "n1", payload: {} },
    ] as unknown as WorkflowRunEventRow[]
    const app = buildWorkflowRunPage({ kind: "workflow-run", run: makeRun(), events }, labels)
    const codeTexts = app.components.filter(
      (c) => c.component === "Text" && (c as { variant?: string }).variant === "code"
    )
    expect(codeTexts).toHaveLength(0)
  })

  it("prefers an explicit workflowName and renders an error without a code", () => {
    const run = makeRun({ title: "", status: "failed", error: { message: "plain" } })
    const app = buildWorkflowRunPage(
      { kind: "workflow-run", run, events: makeEvents(), workflowName: "Override" },
      labels
    )
    expect(app.name).toBe("Override")
    const alert = app.components.find((c) => c.component === "Alert") as { message: string }
    expect(alert.message).toBe("plain")
  })

  it("handles an output for a step missing from the snapshot (falls back to step id)", () => {
    const events = [
      {
        id: "e1",
        runId: "run1",
        ts: 1000,
        type: "step_completed",
        stepId: "ghost",
        payload: { output: "y" },
      },
    ] as unknown as WorkflowRunEventRow[]
    const app = buildWorkflowRunPage({ kind: "workflow-run", run: makeRun(), events }, labels)
    const card = app.components.find(
      (c) => c.component === "Card" && (c as { title?: string }).title === "ghost"
    )
    expect(card).toBeTruthy()
  })

  it("produces a dash duration when there is no completion nor events", () => {
    const run = makeRun({ completedAt: undefined })
    const app = buildWorkflowRunPage({ kind: "workflow-run", run, events: [] }, labels)
    const meta = app.components.find(
      (c) => c.component === "Text" && (c as { text: string }).text.includes("Duration")
    )
    expect((meta as { text: string }).text).toContain("—")
  })
})

describe("stringifyOutput edge cases", () => {
  it("falls back to String() when JSON.stringify throws (circular)", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(stringifyOutput(circular)).toBe("[object Object]")
  })
})
