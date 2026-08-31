/** @jest-environment jsdom */
/**
 * The store is mocked, so what is under test is the pass-through contract
 * itself: which store method each function reaches for, and the two places
 * this module adds behaviour of its own — the load-before-read in
 * `listUserScheduledTasks` and the `run-now` trigger-source default.
 */

const state = {
  permissionPolicy: { agentAutoCreate: true } as unknown,
  tasks: [] as unknown[],
  loadTasks: jest.fn(async () => undefined),
  createTask: jest.fn(async () => ({ id: "t1" })),
  deleteTask: jest.fn(async () => true),
  runTaskNow: jest.fn(async () => ({ id: "e1" })),
}

jest.mock("@/stores/scheduler/scheduler-store", () => ({
  useSchedulerStore: { getState: () => state },
}))

import {
  createUserScheduledTask,
  createUserSchedulerAPI,
  deleteUserScheduledTask,
  getSchedulerPermissionPolicy,
  listUserScheduledTasks,
  runUserScheduledTaskNow,
} from "./scheduler-tasks"

beforeEach(() => {
  state.tasks = []
  state.loadTasks.mockClear()
  state.createTask.mockClear()
  state.deleteTask.mockClear()
  state.runTaskNow.mockClear()
})

describe("plugin scheduler-tasks API", () => {
  it("mounts the same operations on the context facade", async () => {
    const api = createUserSchedulerAPI()
    await api.getPolicy()
    await api.listTasks()
    await api.createTask({ name: "n" } as never)
    await api.deleteTask("t1")
    await api.runTaskNow("t1")

    expect(state.loadTasks).toHaveBeenCalledTimes(1)
    expect(state.createTask).toHaveBeenCalledTimes(1)
    expect(state.deleteTask).toHaveBeenCalledWith("t1")
    expect(state.runTaskNow).toHaveBeenCalledWith("t1", { triggerSource: "run-now" })
  })

  it("reads the persisted permission policy from the store", async () => {
    await expect(getSchedulerPermissionPolicy()).resolves.toEqual({ agentAutoCreate: true })
  })

  it("loads before reading, so a fresh renderer never reports an empty schedule", async () => {
    state.loadTasks.mockImplementation(async () => {
      state.tasks = [{ id: "t1" }]
    })
    await expect(listUserScheduledTasks()).resolves.toEqual([{ id: "t1" }])
    expect(state.loadTasks).toHaveBeenCalledTimes(1)
  })

  it("still returns the current rows when the load fails", async () => {
    state.tasks = [{ id: "cached" }]
    state.loadTasks.mockRejectedValueOnce(new Error("offline"))
    await expect(listUserScheduledTasks()).resolves.toEqual([{ id: "cached" }])
  })

  it("passes create and delete straight through", async () => {
    const input = { name: "n", type: "chat", trigger: { type: "once" } } as never
    await expect(createUserScheduledTask(input)).resolves.toEqual({ id: "t1" })
    expect(state.createTask).toHaveBeenCalledWith(input)
    await expect(deleteUserScheduledTask("t1")).resolves.toBe(true)
    expect(state.deleteTask).toHaveBeenCalledWith("t1")
  })

  it("defaults the trigger source to run-now, and lets a caller override it", async () => {
    await runUserScheduledTaskNow("t1")
    expect(state.runTaskNow).toHaveBeenCalledWith("t1", { triggerSource: "run-now" })
    await runUserScheduledTaskNow("t1", { triggerSource: "manual" as never })
    expect(state.runTaskNow).toHaveBeenLastCalledWith("t1", { triggerSource: "manual" })
  })
})
