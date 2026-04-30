/**
 * Tests for native/system-scheduler — thin wrappers over Tauri scheduler_*
 * commands. Each function should pass its arguments straight through and
 * return whatever invoke() resolves to.
 */

import { invoke } from "@tauri-apps/api/core"
import {
  getSchedulerCapabilities,
  isSchedulerAvailable,
  isSchedulerElevated,
  listSystemTasks,
  getSystemTask,
  createSystemTask,
  updateSystemTask,
  deleteSystemTask,
  enableSystemTask,
  disableSystemTask,
  runSystemTaskNow,
  validateSystemTask,
  confirmSystemTask,
  cancelConfirmation,
  cancelTaskConfirmation,
  requestSchedulerElevation,
  getPendingConfirmations,
} from "./system-scheduler"

const mockedInvoke = invoke as unknown as jest.Mock

beforeEach(() => {
  mockedInvoke.mockReset()
})

describe("system-scheduler invoke wrappers", () => {
  it("getSchedulerCapabilities()", async () => {
    const caps = { supportsElevation: true } as unknown
    mockedInvoke.mockResolvedValueOnce(caps)
    await expect(getSchedulerCapabilities()).resolves.toBe(caps)
    expect(mockedInvoke).toHaveBeenCalledWith("scheduler_get_capabilities")
  })

  it("isSchedulerAvailable()", async () => {
    mockedInvoke.mockResolvedValueOnce(true)
    await expect(isSchedulerAvailable()).resolves.toBe(true)
    expect(mockedInvoke).toHaveBeenCalledWith("scheduler_is_available")
  })

  it("isSchedulerElevated()", async () => {
    mockedInvoke.mockResolvedValueOnce(false)
    await expect(isSchedulerElevated()).resolves.toBe(false)
    expect(mockedInvoke).toHaveBeenCalledWith("scheduler_is_elevated")
  })

  it("listSystemTasks()", async () => {
    mockedInvoke.mockResolvedValueOnce([])
    await expect(listSystemTasks()).resolves.toEqual([])
    expect(mockedInvoke).toHaveBeenCalledWith("scheduler_list_tasks")
  })

  it("getSystemTask() forwards the taskId", async () => {
    mockedInvoke.mockResolvedValueOnce(null)
    await expect(getSystemTask("task-1")).resolves.toBeNull()
    expect(mockedInvoke).toHaveBeenCalledWith("scheduler_get_task", { taskId: "task-1" })
  })

  it("createSystemTask() defaults confirmed=false", async () => {
    mockedInvoke.mockResolvedValueOnce({ ok: true })
    const input = { name: "task" } as unknown as Parameters<typeof createSystemTask>[0]
    await createSystemTask(input)
    expect(mockedInvoke).toHaveBeenCalledWith("scheduler_create_task", {
      input,
      confirmed: false,
    })
  })

  it("createSystemTask() forwards confirmed=true when provided", async () => {
    mockedInvoke.mockResolvedValueOnce({ ok: true })
    const input = { name: "task" } as unknown as Parameters<typeof createSystemTask>[0]
    await createSystemTask(input, true)
    expect(mockedInvoke).toHaveBeenCalledWith("scheduler_create_task", {
      input,
      confirmed: true,
    })
  })

  it("updateSystemTask() defaults confirmed=false", async () => {
    mockedInvoke.mockResolvedValueOnce({ ok: true })
    const input = { name: "updated" } as unknown as Parameters<typeof updateSystemTask>[1]
    await updateSystemTask("task-1", input)
    expect(mockedInvoke).toHaveBeenCalledWith("scheduler_update_task", {
      taskId: "task-1",
      input,
      confirmed: false,
    })
  })

  it("updateSystemTask() forwards explicit confirmed flag", async () => {
    mockedInvoke.mockResolvedValueOnce({ ok: true })
    const input = { name: "updated" } as unknown as Parameters<typeof updateSystemTask>[1]
    await updateSystemTask("task-1", input, true)
    expect(mockedInvoke).toHaveBeenCalledWith("scheduler_update_task", {
      taskId: "task-1",
      input,
      confirmed: true,
    })
  })

  it("deleteSystemTask()", async () => {
    mockedInvoke.mockResolvedValueOnce(true)
    await expect(deleteSystemTask("task-1")).resolves.toBe(true)
    expect(mockedInvoke).toHaveBeenCalledWith("scheduler_delete_task", { taskId: "task-1" })
  })

  it("enableSystemTask()", async () => {
    mockedInvoke.mockResolvedValueOnce(true)
    await enableSystemTask("task-1")
    expect(mockedInvoke).toHaveBeenCalledWith("scheduler_enable_task", { taskId: "task-1" })
  })

  it("disableSystemTask()", async () => {
    mockedInvoke.mockResolvedValueOnce(true)
    await disableSystemTask("task-1")
    expect(mockedInvoke).toHaveBeenCalledWith("scheduler_disable_task", { taskId: "task-1" })
  })

  it("runSystemTaskNow()", async () => {
    mockedInvoke.mockResolvedValueOnce({ success: true })
    await runSystemTaskNow("task-1")
    expect(mockedInvoke).toHaveBeenCalledWith("scheduler_run_task_now", { taskId: "task-1" })
  })

  it("validateSystemTask()", async () => {
    mockedInvoke.mockResolvedValueOnce({ valid: true })
    const input = { name: "t" } as unknown as Parameters<typeof validateSystemTask>[0]
    await validateSystemTask(input)
    expect(mockedInvoke).toHaveBeenCalledWith("scheduler_validate_task", { input })
  })

  it("confirmSystemTask()", async () => {
    mockedInvoke.mockResolvedValueOnce({ id: "task-1" })
    await confirmSystemTask("confirm-1")
    expect(mockedInvoke).toHaveBeenCalledWith("scheduler_confirm_task", {
      confirmationId: "confirm-1",
    })
  })

  it("cancelConfirmation()", async () => {
    mockedInvoke.mockResolvedValueOnce(true)
    await cancelConfirmation("confirm-1")
    expect(mockedInvoke).toHaveBeenCalledWith("scheduler_cancel_confirmation", {
      confirmationId: "confirm-1",
    })
  })

  it("cancelTaskConfirmation is an alias of cancelConfirmation", () => {
    expect(cancelTaskConfirmation).toBe(cancelConfirmation)
  })

  it("requestSchedulerElevation()", async () => {
    mockedInvoke.mockResolvedValueOnce(true)
    await expect(requestSchedulerElevation()).resolves.toBe(true)
    expect(mockedInvoke).toHaveBeenCalledWith("scheduler_request_elevation")
  })

  it("getPendingConfirmations()", async () => {
    mockedInvoke.mockResolvedValueOnce([])
    await getPendingConfirmations()
    expect(mockedInvoke).toHaveBeenCalledWith("scheduler_get_pending_confirmations")
  })

  it("propagates errors from the Tauri side", async () => {
    mockedInvoke.mockRejectedValueOnce(new Error("boom"))
    await expect(listSystemTasks()).rejects.toThrow("boom")
  })
})
