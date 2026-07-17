import { reduceRunEvents } from "./run-reducer"
import type { ExecutionRun, RunEvent } from "@/types/execution/run"

const baseRun: ExecutionRun = {
  id: "run-1",
  kind: "workflow",
  sourceId: "workflow-run-1",
  title: "Publish release",
  status: "running",
  currentRevision: 0,
  startedAt: 1_000,
  updatedAt: 1_000,
}

function event(overrides: Partial<RunEvent> & Pick<RunEvent, "type" | "seq">): RunEvent {
  return {
    id: `event-${overrides.seq}`,
    runId: baseRun.id,
    ts: 1_000 + overrides.seq,
    visibility: "summary",
    payload: {},
    ...overrides,
  }
}

describe("reduceRunEvents", () => {
  it("stops at a journal gap so a later event cannot advance the revision", () => {
    const snapshot = reduceRunEvents(baseRun, [
      event({ type: "run.started", seq: 1 }),
      event({ type: "run.completed", seq: 3, payload: { summary: "must wait" } }),
    ])

    expect(snapshot.revision).toBe(1)
    expect(snapshot.status).toBe("running")
  })

  it("rebuilds a workflow snapshot deterministically from ordered semantic events", () => {
    const snapshot = reduceRunEvents(baseRun, [
      event({
        type: "plan.created",
        seq: 1,
        payload: {
          version: 1,
          steps: [
            { id: "build", title: "Build", status: "pending" },
            { id: "publish", title: "Publish", status: "pending" },
          ],
        },
      }),
      event({ type: "step.started", seq: 2, payload: { stepId: "build", title: "Build" } }),
      event({
        type: "step.completed",
        seq: 3,
        payload: { stepId: "build", title: "Build", summary: "Bundle ready" },
      }),
      event({ type: "step.started", seq: 4, payload: { stepId: "publish", title: "Publish" } }),
    ])

    expect(snapshot).toEqual(
      expect.objectContaining({
        runId: "run-1",
        status: "running",
        revision: 4,
        progress: { completed: 1, total: 2, ratio: 0.5, trustworthy: true },
        activeSteps: [expect.objectContaining({ id: "publish", status: "in_progress" })],
        recentSteps: [
          expect.objectContaining({ id: "build", status: "completed", summary: "Bundle ready" }),
        ],
      })
    )
  })

  it("ignores duplicates and stale events and never invents a percentage for dynamic agent runs", () => {
    const agentRun: ExecutionRun = { ...baseRun, kind: "agent-turn" }
    const events = [
      event({ type: "step.added", seq: 1, payload: { stepId: "search", title: "Search" } }),
      event({ type: "step.started", seq: 2, payload: { stepId: "search", title: "Search" } }),
      event({ type: "step.completed", seq: 3, payload: { stepId: "search", title: "Search" } }),
      event({ type: "step.failed", seq: 2, payload: { stepId: "search", title: "Search" } }),
      event({ type: "step.completed", seq: 3, payload: { stepId: "search", title: "Search" } }),
    ]

    const snapshot = reduceRunEvents(agentRun, events)

    expect(snapshot.revision).toBe(3)
    expect(snapshot.progress).toEqual({ completed: 1, total: 1, trustworthy: false })
    expect(snapshot.recentSteps[0]).toEqual(expect.objectContaining({ status: "completed" }))
  })

  it("keeps a terminal run terminal when later non-terminal events arrive", () => {
    const snapshot = reduceRunEvents(baseRun, [
      event({ type: "run.completed", seq: 1, payload: { summary: "Done" } }),
      event({ type: "run.resumed", seq: 2, payload: {} }),
      event({ type: "step.started", seq: 3, payload: { stepId: "late", title: "Late" } }),
    ])

    expect(snapshot.status).toBe("completed")
    expect(snapshot.summary).toBe("Done")
    expect(snapshot.allowedActions).toEqual(["open_details"])
  })

  it("replaces removed pending steps when a plan is revised", () => {
    const snapshot = reduceRunEvents(baseRun, [
      event({
        type: "plan.created",
        seq: 1,
        payload: { steps: [{ id: "old", title: "Old step" }] },
      }),
      event({
        type: "plan.revised",
        seq: 2,
        payload: { steps: [{ id: "new", title: "New step" }] },
      }),
    ])

    expect(snapshot.pendingSteps.map((step) => step.id)).toEqual(["new"])
  })
})
