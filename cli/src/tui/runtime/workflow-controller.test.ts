/**
 * @jest-environment node
 */
import { workflowInspect, workflowList, workflowRun, workflowRuns } from "./workflow-controller"
import type { TuiAction } from "../state/types"

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
  it("runs a workflow and reports success via the activity pill", async () => {
    const { dispatch, actions } = recorder()
    await workflowRun("w1", {
      dispatch,
      ensureDb: async () => {},
      get: async () => wf("w1", "Nightly"),
      run: async () => ({ runId: "r1", status: "succeeded" }),
    })
    expect(actions[0]).toEqual({ type: "ACTIVITY_START", kind: "workflow", label: "Nightly" })
    expect(actions.at(-1)).toMatchObject({ type: "ACTIVITY_END", status: "done" })
  })

  it("surfaces a failed run with the node-level error", async () => {
    const { dispatch, actions } = recorder()
    await workflowRun("w1", {
      dispatch,
      ensureDb: async () => {},
      get: async () => wf("w1", "Nightly"),
      run: async () => ({
        runId: "r1",
        status: "failed",
        error: { message: "boom", nodeId: "n3" },
      }),
    })
    const end = actions.at(-1) as { type: string; status: string; summary: string }
    expect(end.status).toBe("error")
    expect(end.summary).toContain("boom")
    expect(end.summary).toContain("n3")
  })

  it("notices a missing workflow without starting an activity", async () => {
    const { dispatch, actions } = recorder()
    await workflowRun("nope", { dispatch, ensureDb: async () => {}, get: async () => undefined })
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ type: "NOTICE" })
  })

  it("ends with an error when the runner throws", async () => {
    const { dispatch, actions } = recorder()
    await workflowRun("w1", {
      dispatch,
      ensureDb: async () => {},
      get: async () => wf("w1", "Nightly"),
      run: async () => {
        throw new Error("crash")
      },
    })
    expect(actions.at(-1)).toMatchObject({ type: "ACTIVITY_END", status: "error" })
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
