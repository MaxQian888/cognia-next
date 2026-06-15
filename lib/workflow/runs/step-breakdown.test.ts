import { computeStepBreakdown } from "./step-breakdown"
import {
  DEFAULT_WORKFLOW_SETTINGS,
  type VisualWorkflow,
  type WorkflowRunEventRow,
} from "@/types/workflow/visual"

function node(id: string, type: string, label: string): VisualWorkflow["nodes"][number] {
  return {
    id,
    type: type as never,
    typeVersion: 1,
    position: { x: 0, y: 0 },
    data: { label, params: {} },
  }
}

const workflow: VisualWorkflow = {
  id: "wf",
  schemaVersion: 2,
  name: "wf",
  createdAt: 0,
  updatedAt: 0,
  nodes: [node("s1", "trigger.manual", "Start"), node("s2", "action.agent.turn", "Think")],
  edges: [],
  settings: DEFAULT_WORKFLOW_SETTINGS,
}

function ev(
  ts: number,
  type: WorkflowRunEventRow["type"],
  stepId: string,
  payload?: unknown
): WorkflowRunEventRow {
  return { id: `${type}-${stepId}-${ts}`, runId: "run", ts, type, stepId, payload }
}

describe("computeStepBreakdown", () => {
  it("joins durations, attempts, and usage; flags the slowest step", () => {
    const events: WorkflowRunEventRow[] = [
      ev(0, "step_started", "s1"),
      ev(100, "step_completed", "s1"),
      ev(100, "step_started", "s2"),
      ev(700, "step_completed", "s2"),
      ev(700, "step_usage", "s2", { inputTokens: 10, outputTokens: 5, costUsd: 0.002 }),
    ]
    const bd = computeStepBreakdown(workflow, events, 700, 0)
    expect(bd.rows.map((r) => r.stepId)).toEqual(["s1", "s2"])
    const s1 = bd.rows[0]
    const s2 = bd.rows[1]
    expect(s1.label).toBe("Start")
    expect(s1.durationMs).toBe(100)
    expect(s1.status).toBe("succeeded")
    expect(s1.attempts).toBe(1)
    expect(s1.usage).toBeUndefined()
    expect(s2.label).toBe("Think")
    expect(s2.category).toBe("action")
    expect(s2.durationMs).toBe(600)
    expect(s2.usage?.totalTokens).toBe(15)
    expect(bd.slowestStepId).toBe("s2")
    expect(bd.totalDurationMs).toBe(700)
  })

  it("counts retries as attempts via repeated step_started", () => {
    const events: WorkflowRunEventRow[] = [
      ev(0, "step_started", "s1"),
      ev(50, "step_started", "s1"), // retry
      ev(120, "step_completed", "s1"),
    ]
    const bd = computeStepBreakdown(workflow, events, 120, 0)
    expect(bd.rows[0].attempts).toBe(2)
  })

  it("uses the latest event ts when completedAt is absent (running)", () => {
    const events: WorkflowRunEventRow[] = [
      ev(0, "step_started", "s1"),
      ev(50, "step_started", "s2"),
    ]
    const bd = computeStepBreakdown(workflow, events, undefined, 0)
    // fallbackEnd = max ts = 50 → running spans measure to that.
    expect(bd.rows.every((r) => r.status === "running")).toBe(true)
    expect(bd.totalDurationMs).toBe(50) // s1: 0→50 = 50, s2: 50→50 = 0
    expect(bd.slowestStepId).toBe("s1")
  })

  it("excludes skipped steps from the slowest pick", () => {
    const events: WorkflowRunEventRow[] = [
      ev(0, "step_skipped", "s1"),
      ev(0, "step_started", "s2"),
      ev(10, "step_completed", "s2"),
    ]
    const bd = computeStepBreakdown(workflow, events, 10, 0)
    expect(bd.slowestStepId).toBe("s2")
  })

  it("falls back to the step id + annotation category for unknown nodes", () => {
    const events: WorkflowRunEventRow[] = [
      ev(0, "step_started", "ghost"),
      ev(20, "step_completed", "ghost"),
    ]
    const bd = computeStepBreakdown(workflow, events, 20, 0)
    expect(bd.rows[0].label).toBe("ghost") // no matching node → id fallback
    expect(bd.rows[0].kind).toBeUndefined()
    expect(bd.rows[0].category).toBe("annotation")
  })

  it("returns empty results for no events", () => {
    const bd = computeStepBreakdown(workflow, [], 0, 0)
    expect(bd.rows).toEqual([])
    expect(bd.slowestStepId).toBeNull()
  })
})
