/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

const isTauriMock = jest.fn().mockReturnValue(true)
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

const sysSched = {
  getSchedulerCapabilities: jest.fn().mockResolvedValue(null),
  isSchedulerAvailable: jest.fn().mockResolvedValue(true),
  isSchedulerElevated: jest.fn().mockResolvedValue(false),
  listSystemTasks: jest.fn().mockResolvedValue([]),
  getPendingConfirmations: jest.fn().mockResolvedValue([]),
  createSystemTask: jest.fn(),
  updateSystemTask: jest.fn(),
  deleteSystemTask: jest.fn(),
  enableSystemTask: jest.fn(),
  disableSystemTask: jest.fn(),
  runSystemTaskNow: jest.fn(),
  confirmSystemTask: jest.fn(),
  cancelTaskConfirmation: jest.fn(),
  validateSystemTask: jest.fn(),
  requestSchedulerElevation: jest.fn(),
}

jest.mock("@/lib/native/system-scheduler", () => ({
  getSchedulerCapabilities: (...a: unknown[]) => sysSched.getSchedulerCapabilities(...a),
  isSchedulerAvailable: (...a: unknown[]) => sysSched.isSchedulerAvailable(...a),
  isSchedulerElevated: (...a: unknown[]) => sysSched.isSchedulerElevated(...a),
  listSystemTasks: (...a: unknown[]) => sysSched.listSystemTasks(...a),
  getPendingConfirmations: (...a: unknown[]) => sysSched.getPendingConfirmations(...a),
  createSystemTask: (...a: unknown[]) => sysSched.createSystemTask(...a),
  updateSystemTask: (...a: unknown[]) => sysSched.updateSystemTask(...a),
  deleteSystemTask: (...a: unknown[]) => sysSched.deleteSystemTask(...a),
  enableSystemTask: (...a: unknown[]) => sysSched.enableSystemTask(...a),
  disableSystemTask: (...a: unknown[]) => sysSched.disableSystemTask(...a),
  runSystemTaskNow: (...a: unknown[]) => sysSched.runSystemTaskNow(...a),
  confirmSystemTask: (...a: unknown[]) => sysSched.confirmSystemTask(...a),
  cancelTaskConfirmation: (...a: unknown[]) => sysSched.cancelTaskConfirmation(...a),
  validateSystemTask: (...a: unknown[]) => sysSched.validateSystemTask(...a),
  requestSchedulerElevation: (...a: unknown[]) => sysSched.requestSchedulerElevation(...a),
}))

jest.mock("@/types/scheduler", () => ({
  isTaskOperationSuccess: (r: { status?: string }) => r?.status === "success",
  isConfirmationRequired: (r: { status?: string }) => r?.status === "confirmation-required",
  isTaskOperationError: (r: { status?: string }) => r?.status === "error",
}))

import { useSystemScheduler } from "./use-system-scheduler"

beforeEach(() => {
  isTauriMock.mockReset().mockReturnValue(true)
  Object.values(sysSched).forEach((fn) => (fn as jest.Mock).mockReset())
  sysSched.getSchedulerCapabilities.mockResolvedValue(null)
  sysSched.isSchedulerAvailable.mockResolvedValue(true)
  sysSched.isSchedulerElevated.mockResolvedValue(false)
  sysSched.listSystemTasks.mockResolvedValue([])
  sysSched.getPendingConfirmations.mockResolvedValue([])
})

describe("useSystemScheduler", () => {
  it("non-Tauri: refresh is a no-op", async () => {
    isTauriMock.mockReturnValue(false)
    const { result } = renderHook(() => useSystemScheduler())
    await act(async () => {
      await result.current.refresh()
    })
    expect(sysSched.listSystemTasks).not.toHaveBeenCalled()
  })

  it("loads capabilities, tasks, and pending queue on mount", async () => {
    sysSched.listSystemTasks.mockResolvedValue([
      { id: "t1", name: "Backup", description: "", trigger: {}, action: {}, run_level: "user" },
    ])
    sysSched.getPendingConfirmations.mockResolvedValue([
      { confirmation_id: "c1", task_id: "t1", created_at: "2026-01-01" },
    ])
    const { result } = renderHook(() => useSystemScheduler())
    await waitFor(() => expect(result.current.tasks).toHaveLength(1))
    expect(result.current.pendingConfirmation?.confirmation_id).toBe("c1")
  })

  it("createTask success path adds task and refreshes", async () => {
    sysSched.createSystemTask.mockResolvedValueOnce({
      status: "success",
      task: { id: "t1", name: "X" },
    })
    // refresh() fetches tasks again — return the new task so the final list
    // reflects the optimistic insert.
    sysSched.listSystemTasks.mockResolvedValueOnce([])
    sysSched.listSystemTasks.mockResolvedValueOnce([{ id: "t1", name: "X" }])
    const { result } = renderHook(() => useSystemScheduler())
    await waitFor(() => expect(result.current.loading).toBe(false))
    let resp: unknown
    await act(async () => {
      resp = await result.current.createTask({} as never)
    })
    expect(resp).toMatchObject({ status: "success" })
    expect(result.current.tasks).toHaveLength(1)
  })

  it("createTask error path surfaces error", async () => {
    sysSched.createSystemTask.mockResolvedValueOnce({
      status: "error",
      message: "perm denied",
    })
    const { result } = renderHook(() => useSystemScheduler())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.createTask({} as never)
    })
    expect(result.current.error).toBe("perm denied")
  })

  it("createTask confirmation-required refreshes the queue", async () => {
    sysSched.createSystemTask.mockResolvedValueOnce({ status: "confirmation-required" })
    const { result } = renderHook(() => useSystemScheduler())
    await waitFor(() => expect(result.current.loading).toBe(false))
    sysSched.getPendingConfirmations.mockResolvedValueOnce([
      { confirmation_id: "c2", task_id: "t-future", created_at: "2026-01-02" },
    ])
    await act(async () => {
      await result.current.createTask({} as never)
    })
    expect(result.current.pendingConfirmation?.confirmation_id).toBe("c2")
  })

  it("createTask thrown error is normalized", async () => {
    sysSched.createSystemTask.mockRejectedValueOnce(new Error("ipc-down"))
    const { result } = renderHook(() => useSystemScheduler())
    await waitFor(() => expect(result.current.loading).toBe(false))
    let resp: unknown
    await act(async () => {
      resp = await result.current.createTask({} as never)
    })
    expect(resp).toEqual({ status: "error", message: "ipc-down" })
  })

  it("updateTask success path updates the matching task", async () => {
    sysSched.listSystemTasks.mockResolvedValueOnce([{ id: "t1", name: "Old" }])
    sysSched.updateSystemTask.mockResolvedValueOnce({
      status: "success",
      task: { id: "t1", name: "New" },
    })
    const { result } = renderHook(() => useSystemScheduler())
    await waitFor(() => expect(result.current.tasks).toHaveLength(1))
    await act(async () => {
      await result.current.updateTask("t1" as never, {} as never)
    })
    expect(sysSched.updateSystemTask).toHaveBeenCalledWith("t1", expect.anything(), false)
  })

  it("deleteTask refreshes when successful", async () => {
    sysSched.deleteSystemTask.mockResolvedValueOnce(true)
    const { result } = renderHook(() => useSystemScheduler())
    await waitFor(() => expect(result.current.loading).toBe(false))
    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.deleteTask("t1" as never)
    })
    expect(ok).toBe(true)
  })

  it("deleteTask error returns false", async () => {
    sysSched.deleteSystemTask.mockRejectedValueOnce(new Error("locked"))
    const { result } = renderHook(() => useSystemScheduler())
    await waitFor(() => expect(result.current.loading).toBe(false))
    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.deleteTask("t1" as never)
    })
    expect(ok).toBe(false)
    expect(result.current.error).toBe("locked")
  })

  it("enableTask / disableTask happy path", async () => {
    sysSched.enableSystemTask.mockResolvedValueOnce(true)
    sysSched.disableSystemTask.mockResolvedValueOnce(true)
    const { result } = renderHook(() => useSystemScheduler())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.enableTask("t1" as never)
      await result.current.disableTask("t1" as never)
    })
    expect(sysSched.enableSystemTask).toHaveBeenCalledWith("t1")
    expect(sysSched.disableSystemTask).toHaveBeenCalledWith("t1")
  })

  it("runTaskNow returns the manager result", async () => {
    sysSched.runSystemTaskNow.mockResolvedValueOnce({ success: true })
    const { result } = renderHook(() => useSystemScheduler())
    await waitFor(() => expect(result.current.loading).toBe(false))
    let runRes: unknown
    await act(async () => {
      runRes = await result.current.runTaskNow("t1" as never)
    })
    expect(runRes).toEqual({ success: true })
  })

  it("runTaskNow normalizes thrown errors", async () => {
    sysSched.runSystemTaskNow.mockRejectedValueOnce(new Error("blocked"))
    const { result } = renderHook(() => useSystemScheduler())
    await waitFor(() => expect(result.current.loading).toBe(false))
    let runRes: unknown
    await act(async () => {
      runRes = await result.current.runTaskNow("t1" as never)
    })
    expect(runRes).toEqual({ success: false, error: "blocked" })
  })

  it("validateTask passes through to native validator", async () => {
    sysSched.validateSystemTask.mockResolvedValueOnce({ valid: true })
    const { result } = renderHook(() => useSystemScheduler())
    await waitFor(() => expect(result.current.loading).toBe(false))
    let validation: unknown
    await act(async () => {
      validation = await result.current.validateTask({} as never)
    })
    expect(validation).toEqual({ valid: true })
  })

  it("requestElevation returns native result; surfaces errors", async () => {
    sysSched.requestSchedulerElevation.mockResolvedValueOnce(true)
    const { result } = renderHook(() => useSystemScheduler())
    await waitFor(() => expect(result.current.loading).toBe(false))
    let granted: boolean | undefined
    await act(async () => {
      granted = await result.current.requestElevation()
    })
    expect(granted).toBe(true)
    sysSched.requestSchedulerElevation.mockRejectedValueOnce(new Error("denied"))
    await act(async () => {
      granted = await result.current.requestElevation()
    })
    expect(granted).toBe(false)
    expect(result.current.error).toBe("denied")
  })

  it("duplicateTask returns null when task is missing, otherwise (copy)", async () => {
    sysSched.listSystemTasks.mockResolvedValueOnce([
      {
        id: "t1",
        name: "Backup",
        description: "d",
        trigger: { kind: "daily" },
        action: { kind: "exec" },
        run_level: "user",
        tags: ["x"],
      },
    ])
    const { result } = renderHook(() => useSystemScheduler())
    await waitFor(() => expect(result.current.tasks).toHaveLength(1))
    let dup: unknown
    await act(async () => {
      dup = await result.current.duplicateTask("missing" as never)
    })
    expect(dup).toBeNull()
    await act(async () => {
      dup = await result.current.duplicateTask("t1" as never)
    })
    expect((dup as { name: string }).name).toBe("Backup (copy)")
  })

  it("recreateTask: missing task returns error", async () => {
    const { result } = renderHook(() => useSystemScheduler())
    await waitFor(() => expect(result.current.loading).toBe(false))
    let res: unknown
    await act(async () => {
      res = await result.current.recreateTask("missing" as never)
    })
    expect(res).toEqual({ status: "error", message: "Task not found" })
  })

  it("recreateTask: delete failure surfaces error message", async () => {
    sysSched.listSystemTasks.mockResolvedValueOnce([
      {
        id: "t1",
        name: "X",
        description: "",
        trigger: {},
        action: {},
        run_level: "user",
        tags: [],
      },
    ])
    sysSched.deleteSystemTask.mockResolvedValueOnce(false)
    const { result } = renderHook(() => useSystemScheduler())
    await waitFor(() => expect(result.current.tasks).toHaveLength(1))
    let res: unknown
    await act(async () => {
      res = await result.current.recreateTask("t1" as never)
    })
    expect(res).toEqual({ status: "error", message: "Failed to delete degraded task" })
  })

  it("confirmTask happy path adds the new task to the list", async () => {
    sysSched.confirmSystemTask.mockResolvedValueOnce({ id: "tx", name: "TX" })
    sysSched.listSystemTasks.mockResolvedValueOnce([])
    sysSched.listSystemTasks.mockResolvedValueOnce([{ id: "tx", name: "TX" }])
    const { result } = renderHook(() => useSystemScheduler())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.confirmTask("c1")
    })
    expect(result.current.tasks.some((t) => t.id === "tx")).toBe(true)
  })

  it("cancelPending without a pending confirmation is a no-op", () => {
    const { result } = renderHook(() => useSystemScheduler())
    expect(() => result.current.cancelPending()).not.toThrow()
  })

  it("clearError resets the error slot", async () => {
    sysSched.deleteSystemTask.mockRejectedValueOnce(new Error("x"))
    const { result } = renderHook(() => useSystemScheduler())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.deleteTask("t1" as never)
    })
    expect(result.current.error).toBe("x")
    act(() => result.current.clearError())
    expect(result.current.error).toBeNull()
  })
})
