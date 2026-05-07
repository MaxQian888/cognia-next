/**
 * Tests for native/system-scheduler — thin wrappers over Tauri scheduler_*
 * commands. Each function should pass its arguments straight through and
 * return whatever transport.call resolves to.
 */

import { transport } from "@/lib/tauri"
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

let callSpy: jest.SpiedFunction<typeof transport.call>

beforeEach(() => {
  callSpy = jest.spyOn(transport, "call")
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe("system-scheduler transport wrappers", () => {
  it("getSchedulerCapabilities()", async () => {
    const caps = { supportsElevation: true } as unknown
    callSpy.mockResolvedValueOnce(caps)
    await expect(getSchedulerCapabilities()).resolves.toBe(caps)
    expect(callSpy).toHaveBeenCalledWith("scheduler_get_capabilities")
  })

  it("isSchedulerAvailable()", async () => {
    callSpy.mockResolvedValueOnce(true)
    await expect(isSchedulerAvailable()).resolves.toBe(true)
    expect(callSpy).toHaveBeenCalledWith("scheduler_is_available")
  })

  it("isSchedulerElevated()", async () => {
    callSpy.mockResolvedValueOnce(false)
    await expect(isSchedulerElevated()).resolves.toBe(false)
    expect(callSpy).toHaveBeenCalledWith("scheduler_is_elevated")
  })

  it("listSystemTasks()", async () => {
    callSpy.mockResolvedValueOnce([])
    await expect(listSystemTasks()).resolves.toEqual([])
    expect(callSpy).toHaveBeenCalledWith("scheduler_list_tasks")
  })

  it("getSystemTask() forwards the taskId", async () => {
    callSpy.mockResolvedValueOnce(null)
    await expect(getSystemTask("task-1")).resolves.toBeNull()
    expect(callSpy).toHaveBeenCalledWith("scheduler_get_task", { taskId: "task-1" })
  })

  it("createSystemTask() defaults confirmed=false", async () => {
    callSpy.mockResolvedValueOnce({ ok: true })
    const input = { name: "task" } as unknown as Parameters<typeof createSystemTask>[0]
    await createSystemTask(input)
    expect(callSpy).toHaveBeenCalledWith("scheduler_create_task", {
      input,
      confirmed: false,
    })
  })

  it("createSystemTask() forwards confirmed=true when provided", async () => {
    callSpy.mockResolvedValueOnce({ ok: true })
    const input = { name: "task" } as unknown as Parameters<typeof createSystemTask>[0]
    await createSystemTask(input, true)
    expect(callSpy).toHaveBeenCalledWith("scheduler_create_task", {
      input,
      confirmed: true,
    })
  })

  it("updateSystemTask() defaults confirmed=false", async () => {
    callSpy.mockResolvedValueOnce({ ok: true })
    const input = { name: "updated" } as unknown as Parameters<typeof updateSystemTask>[1]
    await updateSystemTask("task-1", input)
    expect(callSpy).toHaveBeenCalledWith("scheduler_update_task", {
      taskId: "task-1",
      input,
      confirmed: false,
    })
  })

  it("updateSystemTask() forwards explicit confirmed flag", async () => {
    callSpy.mockResolvedValueOnce({ ok: true })
    const input = { name: "updated" } as unknown as Parameters<typeof updateSystemTask>[1]
    await updateSystemTask("task-1", input, true)
    expect(callSpy).toHaveBeenCalledWith("scheduler_update_task", {
      taskId: "task-1",
      input,
      confirmed: true,
    })
  })

  it("deleteSystemTask()", async () => {
    callSpy.mockResolvedValueOnce(true)
    await expect(deleteSystemTask("task-1")).resolves.toBe(true)
    expect(callSpy).toHaveBeenCalledWith("scheduler_delete_task", { taskId: "task-1" })
  })

  it("enableSystemTask()", async () => {
    callSpy.mockResolvedValueOnce(true)
    await enableSystemTask("task-1")
    expect(callSpy).toHaveBeenCalledWith("scheduler_enable_task", { taskId: "task-1" })
  })

  it("disableSystemTask()", async () => {
    callSpy.mockResolvedValueOnce(true)
    await disableSystemTask("task-1")
    expect(callSpy).toHaveBeenCalledWith("scheduler_disable_task", { taskId: "task-1" })
  })

  it("runSystemTaskNow()", async () => {
    callSpy.mockResolvedValueOnce({ success: true })
    await runSystemTaskNow("task-1")
    expect(callSpy).toHaveBeenCalledWith("scheduler_run_task_now", { taskId: "task-1" })
  })

  it("validateSystemTask()", async () => {
    callSpy.mockResolvedValueOnce({ valid: true })
    const input = { name: "t" } as unknown as Parameters<typeof validateSystemTask>[0]
    await validateSystemTask(input)
    expect(callSpy).toHaveBeenCalledWith("scheduler_validate_task", { input })
  })

  it("confirmSystemTask()", async () => {
    callSpy.mockResolvedValueOnce({ id: "task-1" })
    await confirmSystemTask("confirm-1")
    expect(callSpy).toHaveBeenCalledWith("scheduler_confirm_task", {
      confirmationId: "confirm-1",
    })
  })

  it("cancelConfirmation()", async () => {
    callSpy.mockResolvedValueOnce(true)
    await cancelConfirmation("confirm-1")
    expect(callSpy).toHaveBeenCalledWith("scheduler_cancel_confirmation", {
      confirmationId: "confirm-1",
    })
  })

  it("cancelTaskConfirmation is an alias of cancelConfirmation", () => {
    expect(cancelTaskConfirmation).toBe(cancelConfirmation)
  })

  it("requestSchedulerElevation()", async () => {
    callSpy.mockResolvedValueOnce(true)
    await expect(requestSchedulerElevation()).resolves.toBe(true)
    expect(callSpy).toHaveBeenCalledWith("scheduler_request_elevation")
  })

  it("getPendingConfirmations()", async () => {
    callSpy.mockResolvedValueOnce([])
    await getPendingConfirmations()
    expect(callSpy).toHaveBeenCalledWith("scheduler_get_pending_confirmations")
  })

  it("propagates errors from the transport", async () => {
    callSpy.mockRejectedValueOnce(new Error("boom"))
    await expect(listSystemTasks()).rejects.toThrow("boom")
  })
})
