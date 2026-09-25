/** @jest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react"

jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warning: jest.fn(),
    loading: jest.fn(() => "toast-1"),
    dismiss: jest.fn(),
  },
}))

import { toast } from "sonner"

import { useSchedulerStore } from "@/stores/scheduler/scheduler-store"
import type { TaskExecution } from "@/types/scheduler"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

import {
  isAppTableKind,
  RUN_STARTING_GRACE_MS,
  taskAnnouncesOutcome,
  useSchedulerItemActions,
  type SchedulerItemActionsDeps,
} from "./use-scheduler-item-actions"

const toastMock = toast as unknown as {
  success: jest.Mock
  error: jest.Mock
  info: jest.Mock
  warning: jest.Mock
  loading: jest.Mock
  dismiss: jest.Mock
}

function item(overrides: Partial<UnifiedScheduledItem> = {}): UnifiedScheduledItem {
  return {
    unifiedId: "app:t1",
    kind: "app",
    sourceId: "t1",
    name: "Nightly build",
    status: "active",
    triggerSummary: { type: "cron", cron: "0 2 * * *" },
    origin: { deepLinkHref: "/scheduler" },
    capabilities: { runNow: true, pause: true, edit: true, delete: true },
    ...overrides,
  }
}

function runningRun(itemUnifiedId: string, id = "app:r1"): UnifiedExecutionRun {
  return {
    unifiedId: id,
    kind: "app",
    itemUnifiedId,
    itemName: "Nightly build",
    status: "running",
    startedAt: Date.now(),
    origin: { tableName: "scheduledTaskRuns", nativeId: "r1" },
  } as UnifiedExecutionRun
}

function source() {
  return {
    runNow: jest.fn(async () => undefined),
    pause: jest.fn(async () => undefined),
    resume: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined),
  }
}

function deps(overrides: Partial<SchedulerItemActionsDeps> = {}): SchedulerItemActionsDeps {
  const src = source()
  return {
    runTaskNow: jest.fn(async () => ({ id: "exec-1", status: "completed" }) as TaskExecution),
    pauseTask: jest.fn(async () => true),
    resumeTask: jest.fn(async () => true),
    deleteTask: jest.fn(async () => true),
    runs: [],
    onOpenRun: jest.fn(),
    registry: { getSource: jest.fn(() => src) } as never,
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  useSchedulerStore.setState({ error: null })
})

describe("isAppTableKind", () => {
  it("is true for the kinds stored in the app scheduler's own table", () => {
    expect(isAppTableKind("app")).toBe(true)
    expect(isAppTableKind("plugin")).toBe(true)
    expect(isAppTableKind("connector")).toBe(true)
    expect(isAppTableKind("workflow")).toBe(false)
    expect(isAppTableKind(undefined)).toBe(false)
  })
})

describe("useSchedulerItemActions · pause / resume", () => {
  it("says it paused, and marks the item pending until it has", async () => {
    let resolvePause: (ok: boolean) => void = () => {}
    const d = deps({
      pauseTask: jest.fn(
        () =>
          new Promise<boolean>((resolve) => {
            resolvePause = resolve
          })
      ),
    })
    const { result } = renderHook(() => useSchedulerItemActions(d))
    act(() => result.current.pause(item()))
    expect(result.current.pending["app:t1"]).toBe("pausing")
    await act(async () => resolvePause(true))
    expect(result.current.pending["app:t1"]).toBeUndefined()
    expect(toastMock.success).toHaveBeenCalledWith("Paused Nightly build")
  })

  it("reports the store's refusal instead of staying silent on a false", async () => {
    const d = deps({
      resumeTask: jest.fn(async () => {
        useSchedulerStore.setState({ error: "Scheduled task t1 could not be resumed." })
        return false
      }),
    })
    const { result } = renderHook(() => useSchedulerItemActions(d))
    await act(async () => result.current.resume(item({ status: "paused" })))
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled())
    expect(toastMock.error.mock.calls[0][1]).toEqual({
      description: "Scheduled task t1 could not be resumed.",
    })
    expect(toastMock.success).not.toHaveBeenCalled()
  })

  it("routes other kinds to their source and reports a rejection", async () => {
    const src = source()
    src.pause.mockRejectedValueOnce(new Error("trigger is gone"))
    const d = deps({ registry: { getSource: jest.fn(() => src) } as never })
    const { result } = renderHook(() => useSchedulerItemActions(d))
    await act(async () =>
      result.current.pause(item({ unifiedId: "workflow:w1", kind: "workflow", sourceId: "w1" }))
    )
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled())
    expect(src.pause).toHaveBeenCalledWith("w1")
    expect(d.pauseTask).not.toHaveBeenCalled()
    expect(toastMock.error.mock.calls[0][1]).toEqual({ description: "trigger is gone" })
  })
})

describe("useSchedulerItemActions · run now", () => {
  it("follows one toast from starting to started once the run shows up", async () => {
    const d = deps({ runTaskNow: jest.fn(() => new Promise<TaskExecution | null>(() => {})) })
    const { result, rerender } = renderHook(
      (props: SchedulerItemActionsDeps) => useSchedulerItemActions(props),
      { initialProps: d }
    )
    act(() => result.current.runNow(item()))
    expect(toastMock.loading).toHaveBeenCalledWith("Starting Nightly build…")
    expect(result.current.pending["app:t1"]).toBe("starting")

    rerender({ ...d, runs: [runningRun("app:t1")] })
    expect(result.current.pending["app:t1"]).toBeUndefined()
    const [message, options] = toastMock.success.mock.calls[0]
    expect(message).toBe("Nightly build is running")
    expect(options.id).toBe("toast-1")
    options.action.onClick()
    expect(d.onOpenRun).toHaveBeenCalledWith("app:r1")
  })

  it("does not wait for a long run: the grace period ends 'starting'", async () => {
    jest.useFakeTimers()
    try {
      const d = deps({ runTaskNow: jest.fn(() => new Promise<TaskExecution | null>(() => {})) })
      const { result } = renderHook(() => useSchedulerItemActions(d))
      act(() => result.current.runNow(item()))
      act(() => {
        jest.advanceTimersByTime(RUN_STARTING_GRACE_MS)
      })
      expect(result.current.pending["app:t1"]).toBeUndefined()
      expect(toastMock.success).toHaveBeenCalledWith("Nightly build is running", { id: "toast-1" })
    } finally {
      jest.useRealTimers()
    }
  })

  it("ignores a second press while the first is still starting", () => {
    const d = deps({ runTaskNow: jest.fn(() => new Promise<TaskExecution | null>(() => {})) })
    const { result } = renderHook(() => useSchedulerItemActions(d))
    act(() => result.current.runNow(item()))
    act(() => result.current.runNow(item()))
    expect(d.runTaskNow).toHaveBeenCalledTimes(1)
  })

  it("turns the same toast into an error when the task no longer exists", async () => {
    const d = deps({
      runTaskNow: jest.fn(async () => {
        useSchedulerStore.setState({ error: "Scheduled task t1 was not found." })
        return null
      }),
    })
    const { result } = renderHook(() => useSchedulerItemActions(d))
    await act(async () => result.current.runNow(item()))
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled())
    expect(toastMock.error.mock.calls[0][1]).toEqual({
      id: "toast-1",
      description: "Scheduled task t1 was not found.",
    })
  })

  it("says a failed run failed, with the way to open it", async () => {
    const d = deps({
      runTaskNow: jest.fn(
        async () => ({ id: "exec-9", status: "failed", error: "exit 1" }) as TaskExecution
      ),
    })
    const { result } = renderHook(() => useSchedulerItemActions(d))
    await act(async () => result.current.runNow(item()))
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled())
    const [message, options] = toastMock.error.mock.calls[0]
    expect(message).toBe("Nightly build failed")
    expect(options).toMatchObject({ id: "toast-1", description: "exit 1" })
    options.action.onClick()
    expect(d.onOpenRun).toHaveBeenCalledWith("app:exec-9")
  })

  it("says a run that finished before it was seen running is done", async () => {
    const d = deps()
    const { result } = renderHook(() => useSchedulerItemActions(d))
    await act(async () => result.current.runNow(item()))
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled())
    expect(toastMock.success.mock.calls[0][0]).toBe("Nightly build finished")
  })

  it("says a start held behind the running one is queued, not finished", async () => {
    const d = deps({
      runTaskNow: jest.fn(async () => ({ id: "placeholder", status: "pending" }) as TaskExecution),
      announcesOutcome: () => true,
    })
    const { result } = renderHook(() => useSchedulerItemActions(d))
    await act(async () => result.current.runNow(item()))
    await waitFor(() => expect(toastMock.info).toHaveBeenCalled())
    const [message, options] = toastMock.info.mock.calls[0]
    expect(message).toBe("Nightly build will run when the current run finishes")
    // The placeholder is never persisted, so there is no run to open.
    expect(options).toEqual({ id: "toast-1" })
    expect(toastMock.success).not.toHaveBeenCalled()
    expect(toastMock.dismiss).not.toHaveBeenCalled()
  })

  it("says a skipped start did not run, with the scheduler's reason", async () => {
    const d = deps({
      runTaskNow: jest.fn(
        async () =>
          ({
            id: "exec-s",
            status: "skipped",
            logs: [{ message: "Skipped: concurrent execution not allowed (overlap policy: skip)" }],
          }) as unknown as TaskExecution
      ),
    })
    const { result } = renderHook(() => useSchedulerItemActions(d))
    await act(async () => result.current.runNow(item()))
    await waitFor(() => expect(toastMock.warning).toHaveBeenCalled())
    const [message, options] = toastMock.warning.mock.calls[0]
    expect(message).toBe("Nightly build did not run")
    expect(options).toMatchObject({
      id: "toast-1",
      description: "Skipped: concurrent execution not allowed (overlap policy: skip)",
    })
    options.action.onClick()
    expect(d.onOpenRun).toHaveBeenCalledWith("app:exec-s")
    expect(toastMock.success).not.toHaveBeenCalled()
  })

  it("says a cancelled run was cancelled rather than finished", async () => {
    const d = deps({
      runTaskNow: jest.fn(async () => ({ id: "exec-c", status: "cancelled" }) as TaskExecution),
    })
    const { result } = renderHook(() => useSchedulerItemActions(d))
    await act(async () => result.current.runNow(item()))
    await waitFor(() => expect(toastMock.warning).toHaveBeenCalled())
    expect(toastMock.warning.mock.calls[0][0]).toBe("Nightly build was cancelled")
    expect(toastMock.success).not.toHaveBeenCalled()
  })

  it("starts other kinds through their source", async () => {
    const src = source()
    const d = deps({ registry: { getSource: jest.fn(() => src) } as never })
    const { result } = renderHook(() => useSchedulerItemActions(d))
    await act(async () =>
      result.current.runNow(item({ unifiedId: "backup:b", kind: "backup", sourceId: "b" }))
    )
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled())
    expect(src.runNow).toHaveBeenCalledWith("b")
    expect(d.runTaskNow).not.toHaveBeenCalled()
  })
})

describe("useSchedulerItemActions · remove", () => {
  it("resolves true and says so when the delete lands", async () => {
    const d = deps()
    const { result } = renderHook(() => useSchedulerItemActions(d))
    let removed = false
    await act(async () => {
      removed = await result.current.remove(item())
    })
    expect(removed).toBe(true)
    expect(toastMock.success).toHaveBeenCalledWith("Deleted Nightly build")
  })

  it("resolves false and reports it when the store refused", async () => {
    const d = deps({ deleteTask: jest.fn(async () => false) })
    const { result } = renderHook(() => useSchedulerItemActions(d))
    let removed = true
    await act(async () => {
      removed = await result.current.remove(item())
    })
    expect(removed).toBe(false)
    expect(toastMock.error).toHaveBeenCalled()
    expect(result.current.pending["app:t1"]).toBeUndefined()
  })
})

describe("taskAnnouncesOutcome", () => {
  const notification = (over: Record<string, unknown>) =>
    ({
      notification: {
        onStart: false,
        onComplete: true,
        onError: true,
        channels: ["toast"],
        ...over,
      },
    }) as never

  it("is true only when the task toasts that outcome itself", () => {
    expect(taskAnnouncesOutcome(notification({}), "complete")).toBe(true)
    expect(taskAnnouncesOutcome(notification({ onComplete: false }), "complete")).toBe(false)
    expect(taskAnnouncesOutcome(notification({ channels: ["desktop"] }), "error")).toBe(false)
    expect(taskAnnouncesOutcome(undefined, "error")).toBe(false)
  })
})

describe("useSchedulerItemActions · one toast per outcome", () => {
  it("steps aside when the task announces its own completion", async () => {
    const d = deps({ announcesOutcome: () => true })
    const { result } = renderHook(() => useSchedulerItemActions(d))
    await act(async () => result.current.runNow(item()))
    await waitFor(() => expect(toastMock.dismiss).toHaveBeenCalledWith("toast-1"))
    expect(toastMock.success).not.toHaveBeenCalled()
  })

  it("steps aside when the task announces its own failure", async () => {
    const d = deps({
      runTaskNow: jest.fn(async () => ({ id: "e", status: "failed" }) as TaskExecution),
      announcesOutcome: (_item, outcome) => outcome === "error",
    })
    const { result } = renderHook(() => useSchedulerItemActions(d))
    await act(async () => result.current.runNow(item()))
    await waitFor(() => expect(toastMock.dismiss).toHaveBeenCalledWith("toast-1"))
    expect(toastMock.error).not.toHaveBeenCalled()
  })
})
