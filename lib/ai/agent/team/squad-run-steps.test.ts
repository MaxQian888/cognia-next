import { squadRunSteps } from "./squad-run-steps"
import type { RunEvent, RunEventType } from "@/types/execution/run"

let seq = 0
function ev(type: RunEventType, payload: Record<string, unknown>, ts = ++seq): RunEvent {
  return { id: `e${seq}`, runId: "r", seq: seq, ts, type, visibility: "summary", payload }
}

beforeEach(() => {
  seq = 0
})

describe("squadRunSteps", () => {
  it("returns nothing for a run that has not started a step", () => {
    expect(squadRunSteps([ev("run.started", {})])).toEqual([])
  })

  it("reads an unterminated step as running", () => {
    const [step] = squadRunSteps([ev("step.started", { stepId: "t1", title: "Read auth.ts" })])
    expect(step).toEqual(
      expect.objectContaining({ id: "t1", label: "Read auth.ts", status: "running" })
    )
    expect(step!.endedAt).toBeUndefined()
  })

  it("collapses a step's whole history into one row", () => {
    const steps = squadRunSteps([
      ev("step.started", { stepId: "t1", title: "Read" }),
      ev("step.progress", { stepId: "t1" }),
      ev("step.completed", { stepId: "t1" }),
    ])
    expect(steps).toHaveLength(1)
    expect(steps[0]).toEqual(
      expect.objectContaining({ status: "completed", label: "Read", endedAt: 3 })
    )
  })

  it("maps each terminal event to its own status", () => {
    for (const [type, status] of [
      ["step.completed", "completed"],
      ["step.failed", "failed"],
      ["step.skipped", "skipped"],
    ] as const) {
      const [step] = squadRunSteps([ev("step.started", { stepId: "t" }), ev(type, { stepId: "t" })])
      expect(step!.status).toBe(status)
    }
  })

  it("orders rows by when each step was first seen, not by status", () => {
    // The order the run actually worked in is more useful than a sort that
    // shuffles finished work to one end.
    const steps = squadRunSteps([
      ev("step.started", { stepId: "a" }),
      ev("step.started", { stepId: "b" }),
      ev("step.completed", { stepId: "a" }),
    ])
    expect(steps.map((s) => s.id)).toEqual(["a", "b"])
  })

  it("resolves ties by journal sequence, not by clock", () => {
    // Two events in the same millisecond must not depend on ts resolution.
    const started = ev("step.started", { stepId: "t" }, 100)
    const failed = ev("step.failed", { stepId: "t" }, 100)
    expect(squadRunSteps([failed, started])[0]!.status).toBe("failed")
  })

  it("lets a later label replace a placeholder, never the reverse", () => {
    const steps = squadRunSteps([
      ev("step.added", { stepId: "t" }),
      ev("step.started", { stepId: "t", title: "Real title" }),
      ev("step.progress", { stepId: "t" }),
    ])
    expect(steps[0]!.label).toBe("Real title")
  })

  it("falls back to the step id when nothing ever named it", () => {
    expect(squadRunSteps([ev("step.started", { stepId: "t1" })])[0]!.label).toBe("t1")
  })

  it("drops events with no step identity rather than inventing rows", () => {
    // A row per orphan event would read as work the Squad never did.
    expect(squadRunSteps([ev("step.started", {}), ev("step.progress", { stepId: "  " })])).toEqual(
      []
    )
  })

  it("ignores tool and run events entirely", () => {
    const steps = squadRunSteps([
      ev("tool.started", { stepId: "t", toolName: "Read" }),
      ev("run.completed", { stepId: "t" }),
    ])
    expect(steps).toEqual([])
  })
})
