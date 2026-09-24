import { renderHook, waitFor } from "@testing-library/react"

import { usePetScheduledReminder } from "./use-pet-scheduled-reminder"
import { getPetEventBus } from "@/lib/pet/events/pet-event-bus"
import { usePetStore } from "@/stores/pet/pet-store"
import type { PetEvent } from "@/types/pet"
import type { ScheduledTask } from "@/types/scheduler"

// next-intl: echo the key back (and stringify vars) so we can assert routing
// without loading the real message bundle.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

function emitDue(meta?: Record<string, unknown>) {
  const event: PetEvent = { source: "scheduler", kind: "scheduledRunDue", at: 1, meta }
  getPetEventBus().emit(event)
}

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t1",
    name: "Backup DB",
    type: "agent",
    trigger: { type: "interval", intervalMs: 4 * 60 * 60 * 1000 },
    payload: {},
    config: { timeout: 60_000, maxRetries: 0, retryDelay: 0, runMissedOnStartup: false },
    notification: { onStart: false, onComplete: true, onError: true },
    status: "active",
    lastRunAt: new Date(1_000),
    nextRunAt: new Date(2_000),
    runCount: 12,
    successCount: 11,
    failureCount: 1,
    consecutiveFailures: 0,
    lastTerminalReason: "completed",
    projectId: "p1",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  }
}

describe("usePetScheduledReminder", () => {
  beforeEach(() => {
    usePetStore.setState({ oneShotQueue: [] })
  })

  it("reminds on a due task: flourish + meta + actions + deep link", async () => {
    const notifyDue = jest.fn().mockResolvedValue(true)
    const resolveTask = jest.fn().mockResolvedValue(makeTask())
    const resolveWorkspaceName = jest.fn().mockReturnValue("cognia")
    renderHook(() =>
      usePetScheduledReminder(true, { resolveTask, resolveWorkspaceName, notifyDue })
    )

    emitDue({ taskId: "t1" })

    await waitFor(() => expect(notifyDue).toHaveBeenCalled())
    expect(resolveTask).toHaveBeenCalledWith("t1")
    expect(usePetStore.getState().oneShotQueue).toContain("surprised")
    const call = notifyDue.mock.calls[0]
    expect(call[0]).toBe("t1")
    expect(call[1].title).toBe("notifications.scheduledDue.title")
    expect(call[1].body).toBe('notifications.scheduledDue.body:{"taskName":"Backup DB"}')
    // The functional toast draws from meta.scheduledDue.
    const meta = call[1].meta?.scheduledDue as Record<string, unknown>
    expect(meta).toMatchObject({
      taskId: "t1",
      kind: "app",
      name: "Backup DB",
      runCount: 12,
      consecutiveFailures: 0,
      workspaceName: "cognia",
      lastRunOk: true,
    })
    // Command-keyed actions dispatch identically from toast and center.
    expect(call[1].actions).toEqual([
      {
        id: "open",
        label: "notifications.scheduledDue.open",
        command: "scheduler.open-task",
        args: { taskId: "t1", itemId: "app:t1" },
        variant: "primary",
      },
      {
        id: "mute",
        label: "notifications.scheduledDue.mute",
        command: "scheduled-due.mute",
        args: { taskId: "t1" },
      },
    ])
    expect(call[1].href).toBe("/scheduler?item=app%3At1")
  })

  it("links plugin tasks under the plugin: kind prefix, not app:", async () => {
    const notifyDue = jest.fn().mockResolvedValue(true)
    const resolveTask = jest.fn().mockResolvedValue(makeTask({ id: "p9", type: "plugin" }))
    renderHook(() => usePetScheduledReminder(true, { resolveTask, notifyDue }))

    emitDue({ taskId: "p9" })

    await waitFor(() => expect(notifyDue).toHaveBeenCalled())
    const call = notifyDue.mock.calls[0]
    expect(call[1].href).toBe("/scheduler?item=plugin%3Ap9")
    expect(call[1].actions?.[0].args).toEqual({ taskId: "p9", itemId: "plugin:p9" })
    const meta = call[1].meta?.scheduledDue as Record<string, unknown>
    expect(meta.kind).toBe("plugin")
  })

  it("suppresses the whole reminder when the task mutes due reminders", async () => {
    const notifyDue = jest.fn().mockResolvedValue(true)
    const resolveTask = jest.fn().mockResolvedValue(
      makeTask({
        notification: { onStart: false, onComplete: true, onError: true, dueReminder: false },
      })
    )
    renderHook(() => usePetScheduledReminder(true, { resolveTask, notifyDue }))

    emitDue({ taskId: "t1" })
    await waitFor(() => expect(resolveTask).toHaveBeenCalled())
    await Promise.resolve()

    expect(notifyDue).not.toHaveBeenCalled()
    expect(usePetStore.getState().oneShotQueue).not.toContain("surprised")
  })

  it("uses the generic body when there is no task id", async () => {
    const notifyDue = jest.fn().mockResolvedValue(true)
    const resolveTask = jest.fn()
    renderHook(() => usePetScheduledReminder(true, { resolveTask, notifyDue }))

    emitDue(undefined)

    await waitFor(() => expect(notifyDue).toHaveBeenCalled())
    expect(resolveTask).not.toHaveBeenCalled()
    const call = notifyDue.mock.calls[0]
    expect(call[0]).toBe("unknown")
    expect(call[1].body).toBe("notifications.scheduledDue.bodyGeneric")
    expect(call[1].actions).toBeUndefined()
    expect(call[1].meta).toBeUndefined()
  })

  it("degrades to the generic body (but keeps actions) when the task lookup fails", async () => {
    const notifyDue = jest.fn().mockResolvedValue(true)
    const resolveTask = jest.fn().mockRejectedValue(new Error("cold db"))
    renderHook(() => usePetScheduledReminder(true, { resolveTask, notifyDue }))

    emitDue({ taskId: "t9" })

    await waitFor(() => expect(notifyDue).toHaveBeenCalled())
    const call = notifyDue.mock.calls[0]
    expect(call[1].body).toBe("notifications.scheduledDue.bodyGeneric")
    expect(call[1].meta).toBeUndefined()
    // Open/mute still work — they only need the id.
    expect(call[1].actions).toHaveLength(2)
    expect(call[1].href).toBe("/scheduler?item=app%3At9")
  })

  it("ignores non-due pet events", async () => {
    const notifyDue = jest.fn().mockResolvedValue(true)
    renderHook(() => usePetScheduledReminder(true, { notifyDue, resolveTask: jest.fn() }))

    getPetEventBus().emit({
      source: "scheduler",
      kind: "scheduledRun",
      at: 1,
      meta: { taskId: "t1" },
    })

    await Promise.resolve()
    expect(notifyDue).not.toHaveBeenCalled()
    expect(usePetStore.getState().oneShotQueue).not.toContain("surprised")
  })

  it("does not subscribe when disabled", async () => {
    const notifyDue = jest.fn().mockResolvedValue(true)
    renderHook(() => usePetScheduledReminder(false, { notifyDue, resolveTask: jest.fn() }))

    emitDue({ taskId: "t1" })

    await Promise.resolve()
    expect(notifyDue).not.toHaveBeenCalled()
    expect(usePetStore.getState().oneShotQueue).not.toContain("surprised")
  })
})

it.each(["provider-diagnostics-refresh", "connection:presence:refresh"] as const)(
  "does not remind for legacy maintenance task %s without an explicit opt-in",
  async (type) => {
    const notifyDue = jest.fn().mockResolvedValue(true)
    const resolveTask = jest.fn().mockResolvedValue(makeTask({ type }))
    renderHook(() => usePetScheduledReminder(true, { resolveTask, notifyDue }))
    emitDue({ taskId: "t1" })
    await waitFor(() => expect(resolveTask).toHaveBeenCalledWith("t1"))
    expect(notifyDue).not.toHaveBeenCalled()
  }
)

it("honors an explicit due reminder opt-in for maintenance tasks", async () => {
  const notifyDue = jest.fn().mockResolvedValue(true)
  const resolveTask = jest.fn().mockResolvedValue(
    makeTask({
      type: "provider-diagnostics-refresh",
      notification: { onStart: false, onComplete: false, onError: true, dueReminder: true },
    })
  )
  renderHook(() => usePetScheduledReminder(true, { resolveTask, notifyDue }))
  emitDue({ taskId: "t1" })
  await waitFor(() => expect(notifyDue).toHaveBeenCalled())
})
