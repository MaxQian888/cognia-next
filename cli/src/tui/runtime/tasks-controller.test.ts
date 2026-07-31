/**
 * @jest-environment node
 */
import { tasksList, tasksPause, tasksResume, tasksShow } from "./tasks-controller"
import type { ScheduledTask } from "@/types/scheduler"
import type { TuiAction } from "../state/types"

function recorder() {
  const actions: TuiAction[] = []
  return { dispatch: (a: TuiAction) => actions.push(a), actions }
}

const task = (id: string, name: string, status = "active"): ScheduledTask =>
  ({
    id,
    name,
    status,
    type: "agent",
    runCount: 3,
    successCount: 2,
    failureCount: 1,
  }) as unknown as ScheduledTask

const noDb = async () => {}

describe("tasksList", () => {
  it("opens a select overlay of tasks", async () => {
    const { dispatch, actions } = recorder()
    await tasksList({ dispatch, ensureDb: noDb, getAll: async () => [task("t1", "Nightly sync")] })
    expect(actions[0]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "select",
        onSelectCommand: "tasks show",
        items: [{ id: "t1", hint: "active" }],
      },
    })
  })

  it("notices when there are no tasks", async () => {
    const { dispatch, actions } = recorder()
    await tasksList({ dispatch, ensureDb: noDb, getAll: async () => [] })
    expect((actions[0] as { message: string }).message).toContain("No scheduled tasks")
  })
})

describe("tasksShow", () => {
  it("renders the task summary", async () => {
    const { dispatch, actions } = recorder()
    await tasksShow("t1", { dispatch, ensureDb: noDb, get: async () => task("t1", "Nightly sync") })
    const msg = (actions[0] as { message: string }).message
    expect(msg).toContain("Nightly sync")
    expect(msg).toContain("3 (2 ok, 1 failed)")
  })

  it("notices a missing task", async () => {
    const { dispatch, actions } = recorder()
    await tasksShow("x", { dispatch, ensureDb: noDb, get: async () => null })
    expect((actions[0] as { message: string }).message).toContain("not found")
  })

  it("rejects an empty id", async () => {
    const { dispatch, actions } = recorder()
    await tasksShow("  ", { dispatch, ensureDb: noDb })
    expect((actions[0] as { message: string }).message).toContain("Usage: /tasks show")
  })
})

describe("tasksPause / tasksResume", () => {
  it("pauses a task by flipping its status", async () => {
    const { dispatch, actions } = recorder()
    const update = jest.fn(async () => {})
    await tasksPause("t1", { dispatch, ensureDb: noDb, get: async () => task("t1", "x"), update })
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: "t1", status: "paused" }))
    expect((actions[0] as { message: string }).message).toContain("Paused task t1")
  })

  it("resumes a task by flipping its status", async () => {
    const { dispatch, actions } = recorder()
    const update = jest.fn(async () => {})
    await tasksResume("t1", {
      dispatch,
      ensureDb: noDb,
      get: async () => task("t1", "x", "paused"),
      update,
    })
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: "active" }))
    expect((actions[0] as { message: string }).message).toContain("Resumed task t1")
  })

  it("notices a missing task on pause", async () => {
    const { dispatch, actions } = recorder()
    const update = jest.fn()
    await tasksPause("x", { dispatch, ensureDb: noDb, get: async () => null, update })
    expect(update).not.toHaveBeenCalled()
    expect((actions[0] as { message: string }).message).toContain("not found")
  })
})
