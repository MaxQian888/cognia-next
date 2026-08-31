import { planTaskMove, type MoveTaskInput } from "./move-task-workspace"

function input(over: Partial<MoveTaskInput> = {}): MoveTaskInput {
  return {
    task: { id: "t1", projectId: "ws_a", status: "active" },
    target: { id: "ws_b" },
    remoteHost: false,
    running: false,
    ...over,
  } as MoveTaskInput
}

describe("planTaskMove", () => {
  it("re-binds to the destination and reports where it came from", () => {
    expect(planTaskMove(input())).toEqual({
      ok: true,
      projectId: "ws_b",
      previousProjectId: "ws_a",
    })
  })

  it("clears the binding when the destination is null", () => {
    // An unbound schedule belongs to every workspace, which is the state rows
    // predating scheduler v5 are already in.
    expect(planTaskMove(input({ target: null }))).toEqual({
      ok: true,
      projectId: null,
      previousProjectId: "ws_a",
    })
  })

  it("omits previousProjectId for a task that was never bound", () => {
    const plan = planTaskMove(input({ task: { id: "t1", status: "active" } as never }))
    expect(plan).toEqual({ ok: true, projectId: "ws_b" })
  })

  it("refuses a re-pick of the workspace the task is already in", () => {
    expect(planTaskMove(input({ target: { id: "ws_a" } }))).toEqual({
      ok: false,
      reason: "same-workspace",
    })
  })

  it("treats clearing an already-unbound task as the same no-op", () => {
    expect(
      planTaskMove(input({ task: { id: "t1", status: "active" } as never, target: null }))
    ).toEqual({ ok: false, reason: "same-workspace" })
  })

  it("refuses on a paired host, whose schedules do not share our workspace ids", () => {
    // `projects` is absent from COMPANION_SYNC_TABLES and `activeProjectId` is
    // `desktop-only`, so a local id names nothing over there.
    expect(planTaskMove(input({ remoteHost: true }))).toEqual({
      ok: false,
      reason: "remote-host",
    })
  })

  it("refuses while an execution is in flight", () => {
    expect(planTaskMove(input({ running: true }))).toEqual({
      ok: false,
      reason: "task-running",
    })
  })

  it("checks the host before anything else, since nothing else is meaningful there", () => {
    expect(planTaskMove(input({ remoteHost: true, target: { id: "ws_a" } }))).toEqual({
      ok: false,
      reason: "remote-host",
    })
  })
})
