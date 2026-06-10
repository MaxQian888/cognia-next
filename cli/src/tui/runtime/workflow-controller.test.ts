/**
 * @jest-environment node
 */
import { workflowInspect, workflowList, workflowRun } from "./workflow-controller"
import type { TuiAction } from "../state/types"

function recorder() {
  const actions: TuiAction[] = []
  return { dispatch: (a: TuiAction) => actions.push(a), actions }
}

const wf = (id: string, name: string, nodes = 0) =>
  ({ id, name, nodes: Array.from({ length: nodes }) }) as never

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
  it("notices node + run counts", async () => {
    const { dispatch, actions } = recorder()
    await workflowInspect("w1", {
      dispatch,
      ensureDb: async () => {},
      get: async () => wf("w1", "Nightly", 4),
      listRuns: async () => [{ status: "succeeded" }] as never,
    })
    const msg = (actions[0] as { message: string }).message
    expect(msg).toContain("4")
    expect(msg).toContain("1")
  })
})
