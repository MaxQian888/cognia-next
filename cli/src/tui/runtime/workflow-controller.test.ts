/**
 * @jest-environment node
 */
import { workflowInspect, workflowList, workflowRun, workflowRuns } from "./workflow-controller"
import type { TuiAction } from "../state/types"
import type { WorkflowRunEventRow } from "@/types/workflow/visual"

function recorder() {
  const actions: TuiAction[] = []
  return { dispatch: (a: TuiAction) => actions.push(a), actions }
}

const wf = (id: string, name: string, nodes = 0) =>
  ({
    id,
    name,
    nodes: Array.from({ length: nodes }, (_, i) => ({
      id: `n${i}`,
      type: "ai.prompt",
      data: { label: `Node ${i}`, params: {} },
    })),
    edges: [],
    settings: { errorPolicy: "stop", timeoutMs: 1000, maxConcurrency: 1 },
  }) as never

describe("workflowList", () => {
  it("opens a select overlay wired to `workflow run`", async () => {
    const { dispatch, actions } = recorder()
    await workflowList({
      dispatch,
      ensureDb: async () => {},
      list: async () => [wf("w1", "Nightly"), wf("w2", "Deploy")],
    })
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "select",
        onSelectCommand: "workflow run",
        items: [
          { id: "w1", label: "Nightly" },
          { id: "w2", label: "Deploy" },
        ],
      },
    })
  })

  it("notices when there are no workflows", async () => {
    const { dispatch, actions } = recorder()
    await workflowList({ dispatch, ensureDb: async () => {}, list: async () => [] })
    expect(actions[0]).toMatchObject({ type: "NOTICE" })
  })
})

describe("workflowRun", () => {
  /** No-op live subscription so unit tests stay hermetic (no real liveQuery). */
  const noSub = () => () => {}

  it("runs a workflow and reports success via the activity pill", async () => {
    const { dispatch, actions } = recorder()
    await workflowRun("w1", {
      dispatch,
      ensureDb: async () => {},
      get: async () => wf("w1", "Nightly", 2),
      run: async () => ({ runId: "r1", status: "succeeded" }),
      subscribe: noSub,
    })
    expect(actions[0]).toMatchObject({
      type: "ACTIVITY_START",
      kind: "workflow",
      label: "Nightly",
      max: 2,
    })
    const types = actions.map((a) => a.type)
    expect(types).toContain("WORKFLOW_RUN_START")
    expect(types).toContain("WORKFLOW_RUN_END")
    expect(actions.at(-1)).toMatchObject({ type: "ACTIVITY_END", status: "done" })
  })

  it("commits a timeline cell and clears the panel before ending the activity", async () => {
    const { dispatch, actions } = recorder()
    await workflowRun("w1", {
      dispatch,
      ensureDb: async () => {},
      get: async () => wf("w1", "Nightly", 1),
      run: async () => ({ runId: "r1", status: "succeeded" }),
      subscribe: noSub,
    })
    const types = actions.map((a) => a.type)
    // WORKFLOW_RUN_END precedes the timeline NOTICE which precedes ACTIVITY_END.
    expect(types.indexOf("WORKFLOW_RUN_END")).toBeLessThan(types.lastIndexOf("NOTICE"))
    expect(types.lastIndexOf("NOTICE")).toBeLessThan(types.indexOf("ACTIVITY_END"))
    const notice = actions.findLast((a) => a.type === "NOTICE") as { message: string }
    expect(notice.message).toContain("# Workflow run · Nightly — succeeded")
  })

  it("folds live events into the panel + Footer progress as the run advances", async () => {
    const { dispatch, actions } = recorder()
    let emit: (e: WorkflowRunEventRow[]) => void = () => {}
    await workflowRun("w1", {
      dispatch,
      ensureDb: async () => {},
      get: async () => wf("w1", "Nightly", 2),
      subscribe: (_runId, next) => {
        emit = next
        return () => {}
      },
      run: async (input) => {
        emit([
          { id: "e1", runId: input.runId!, type: "step_started", stepId: "n0", ts: 1 } as never,
          { id: "e2", runId: input.runId!, type: "step_completed", stepId: "n0", ts: 5 } as never,
          { id: "e3", runId: input.runId!, type: "step_started", stepId: "n1", ts: 6 } as never,
        ])
        return { runId: input.runId!, status: "succeeded" }
      },
    })
    const step = actions.findLast((a) => a.type === "WORKFLOW_RUN_STEP") as {
      completed: number
      currentId?: string
    }
    expect(step.completed).toBe(1)
    expect(step.currentId).toBe("n1")
    const progress = actions.findLast((a) => a.type === "ACTIVITY_PROGRESS") as {
      turns: number
      note?: string
    }
    expect(progress.turns).toBe(1)
    expect(progress.note).toBe("Node 1")
  })

  it("marks the failing node in the timeline on a node-level failure", async () => {
    const { dispatch, actions } = recorder()
    await workflowRun("w1", {
      dispatch,
      ensureDb: async () => {},
      get: async () => wf("w1", "Nightly", 4),
      run: async () => ({
        runId: "r1",
        status: "failed",
        error: { message: "boom", nodeId: "n3" },
      }),
      subscribe: noSub,
    })
    expect(actions.at(-1)).toMatchObject({ type: "ACTIVITY_END", status: "error" })
    const notice = actions.findLast((a) => a.type === "NOTICE") as { message: string }
    expect(notice.message).toContain("— failed")
    expect(notice.message).toContain("✗ Node 3")
    expect(notice.message).toContain("boom")
  })

  it("notices a missing workflow without starting an activity", async () => {
    const { dispatch, actions } = recorder()
    await workflowRun("nope", { dispatch, ensureDb: async () => {}, get: async () => undefined })
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ type: "NOTICE" })
  })

  it("ends with an error and clears the panel when the runner throws", async () => {
    const { dispatch, actions } = recorder()
    await workflowRun("w1", {
      dispatch,
      ensureDb: async () => {},
      get: async () => wf("w1", "Nightly", 1),
      run: async () => {
        throw new Error("crash")
      },
      subscribe: noSub,
    })
    const types = actions.map((a) => a.type)
    expect(types).toContain("WORKFLOW_RUN_END")
    expect(actions.at(-1)).toMatchObject({ type: "ACTIVITY_END", status: "error" })
    const crash = actions.find(
      (a) => a.type === "NOTICE" && (a as { message: string }).message.includes("crash")
    )
    expect(crash).toBeDefined()
  })
})

describe("workflowInspect", () => {
  it("opens a markdown document with the node + run summary", async () => {
    const { dispatch, actions } = recorder()
    await workflowInspect("w1", {
      dispatch,
      ensureDb: async () => {},
      get: async () => wf("w1", "Nightly", 4),
      listRuns: async () => [{ status: "succeeded", startedAt: 0, completedAt: 1000 }] as never,
    })
    expect(actions[0]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: { kind: "document", title: "Workflow · Nightly", format: "markdown" },
    })
    const body = (actions[0] as { overlay: { body: string } }).overlay.body
    expect(body).toContain("# Nightly")
    expect(body).toContain("Nodes:** 4")
    expect(body).toContain("succeeded")
  })

  it("notices a missing workflow", async () => {
    const { dispatch, actions } = recorder()
    await workflowInspect("nope", {
      dispatch,
      ensureDb: async () => {},
      get: async () => undefined,
    })
    expect(actions[0]).toMatchObject({ type: "NOTICE" })
  })
})

describe("workflowRuns", () => {
  it("opens a markdown runs document", async () => {
    const { dispatch, actions } = recorder()
    await workflowRuns("w1", {
      dispatch,
      ensureDb: async () => {},
      get: async () => wf("w1", "Nightly", 1),
      listRuns: async () =>
        [{ status: "failed", startedAt: 0, completedAt: 500, error: { message: "boom" } }] as never,
    })
    expect(actions[0]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: { kind: "document", title: "Runs · Nightly", format: "markdown" },
    })
    const body = (actions[0] as { overlay: { body: string } }).overlay.body
    expect(body).toContain("# Runs · Nightly")
    expect(body).toContain("boom")
  })

  it("notices a missing workflow", async () => {
    const { dispatch, actions } = recorder()
    await workflowRuns("nope", { dispatch, ensureDb: async () => {}, get: async () => undefined })
    expect(actions[0]).toMatchObject({ type: "NOTICE" })
  })
})
