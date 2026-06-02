/**
 * Tests for the scheduler alarm-daemon Tauri bridge. Verifies graceful web-mode
 * no-ops and the Tauri invoke/listen payload shapes.
 */

import { isTauri } from "@/lib/platform/detect"

import { armTask, disarmTask, listenTaskDue } from "./daemon-bridge"

jest.mock("@/lib/platform/detect", () => ({
  isTauri: jest.fn(),
}))

const invokeMock = jest.fn()
const listenMock = jest.fn()

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))
jest.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}))

const mockedIsTauri = isTauri as jest.MockedFunction<typeof isTauri>

beforeEach(() => {
  jest.clearAllMocks()
  invokeMock.mockResolvedValue(undefined)
})

describe("daemon-bridge (web mode)", () => {
  beforeEach(() => mockedIsTauri.mockReturnValue(false))

  it("armTask / disarmTask resolve without invoking", async () => {
    await expect(armTask("task_1", 123)).resolves.toBeUndefined()
    await expect(disarmTask("task_1")).resolves.toBeUndefined()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("listenTaskDue returns a no-op unsubscribe", async () => {
    const stop = await listenTaskDue(() => {})
    expect(typeof stop).toBe("function")
    expect(() => stop()).not.toThrow()
    expect(listenMock).not.toHaveBeenCalled()
  })
})

describe("daemon-bridge (Tauri mode)", () => {
  beforeEach(() => mockedIsTauri.mockReturnValue(true))

  it("armTask invokes scheduler_arm_task with the camelCase input shape", async () => {
    await armTask("task_1", 1700000000000)
    expect(invokeMock).toHaveBeenCalledWith("scheduler_arm_task", {
      input: { taskId: "task_1", fireAtMs: 1700000000000 },
    })
  })

  it("disarmTask invokes scheduler_disarm_task with the task id", async () => {
    await disarmTask("task_1")
    expect(invokeMock).toHaveBeenCalledWith("scheduler_disarm_task", { taskId: "task_1" })
  })

  it("listenTaskDue subscribes to scheduler:task-due and forwards the payload", async () => {
    const received: unknown[] = []
    const unsub = jest.fn()
    listenMock.mockImplementation(async (_event: string, cb: (e: unknown) => void) => {
      // Simulate the daemon firing.
      cb({ payload: { taskId: "task_1", firedAtMs: 42 } })
      return unsub
    })

    const stop = await listenTaskDue((e) => received.push(e))
    expect(listenMock).toHaveBeenCalledWith("scheduler:task-due", expect.any(Function))
    expect(received).toEqual([{ taskId: "task_1", firedAtMs: 42 }])
    expect(stop).toBe(unsub)
  })

  it("swallows invoke errors so the renderer never hard-fails", async () => {
    invokeMock.mockRejectedValueOnce(new Error("ipc down"))
    await expect(armTask("task_1", 1)).resolves.toBeUndefined()
  })

  it("returns a no-op unsubscribe when the event API throws", async () => {
    listenMock.mockImplementation(() => {
      throw new Error("no event api")
    })
    const stop = await listenTaskDue(() => {})
    expect(typeof stop).toBe("function")
    expect(() => stop()).not.toThrow()
  })
})
