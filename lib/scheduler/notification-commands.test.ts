import {
  SCHEDULED_DUE_MUTE_COMMAND,
  SCHEDULER_OPEN_TASK_COMMAND,
  installScheduledNotificationCommands,
} from "./notification-commands"
import {
  __resetNotificationCommandsForTesting,
  dispatchNotificationCommand,
} from "@/lib/notifications/action-registry"
import type { ScheduledTask } from "@/types/scheduler"

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t1",
    name: "Backup",
    type: "agent",
    trigger: { type: "interval", intervalMs: 3_600_000 },
    config: { timeout: 60_000, maxRetries: 0, retryDelay: 0, runMissedOnStartup: false },
    notification: {
      onStart: false,
      onComplete: true,
      onError: true,
      channels: ["toast", "desktop"],
    },
    status: "active",
    runCount: 3,
    successCount: 3,
    failureCount: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  }
}

describe("installScheduledNotificationCommands", () => {
  beforeEach(() => __resetNotificationCommandsForTesting())

  it("open-task navigates to the task's ?item= address", async () => {
    const navigate = jest.fn()
    const off = installScheduledNotificationCommands({ navigate })
    await dispatchNotificationCommand({
      notificationId: "n1",
      command: SCHEDULER_OPEN_TASK_COMMAND,
      args: { taskId: "t 1" },
    })
    expect(navigate).toHaveBeenCalledWith("/scheduler?item=app%3At%201")
    off()
  })

  it("open-task prefers a valid itemId arg — plugin tasks resolve under plugin:", async () => {
    const navigate = jest.fn()
    installScheduledNotificationCommands({ navigate })
    await dispatchNotificationCommand({
      notificationId: "n1",
      command: SCHEDULER_OPEN_TASK_COMMAND,
      args: { taskId: "p9", itemId: "plugin:p9" },
    })
    expect(navigate).toHaveBeenCalledWith("/scheduler?item=plugin%3Ap9")
  })

  it("open-task falls back to app: when the itemId arg is absent or malformed", async () => {
    const navigate = jest.fn()
    installScheduledNotificationCommands({ navigate })
    // Records persisted before itemId existed only carry taskId.
    await dispatchNotificationCommand({
      notificationId: "n1",
      command: SCHEDULER_OPEN_TASK_COMMAND,
      args: { taskId: "t1" },
    })
    await dispatchNotificationCommand({
      notificationId: "n2",
      command: SCHEDULER_OPEN_TASK_COMMAND,
      args: { taskId: "t1", itemId: "not-a-unified-id" },
    })
    expect(navigate).toHaveBeenNthCalledWith(1, "/scheduler?item=app%3At1")
    expect(navigate).toHaveBeenNthCalledWith(2, "/scheduler?item=app%3At1")
  })

  it("open-task is a no-op without a taskId arg", async () => {
    const navigate = jest.fn()
    installScheduledNotificationCommands({ navigate })
    await dispatchNotificationCommand({
      notificationId: "n1",
      command: SCHEDULER_OPEN_TASK_COMMAND,
    })
    expect(navigate).not.toHaveBeenCalled()
  })

  it("mute merges dueReminder:false into the existing notification config", async () => {
    const task = makeTask()
    const getTask = jest.fn().mockResolvedValue(task)
    const updateTask = jest.fn().mockResolvedValue(task)
    installScheduledNotificationCommands({ navigate: jest.fn(), getTask, updateTask })

    await dispatchNotificationCommand({
      notificationId: "n1",
      command: SCHEDULED_DUE_MUTE_COMMAND,
      args: { taskId: "t1" },
    })

    expect(getTask).toHaveBeenCalledWith("t1")
    // Merging is the contract: a bare `{dueReminder:false}` write would wipe
    // onComplete/channels for every task muted from a toast.
    expect(updateTask).toHaveBeenCalledWith("t1", {
      notification: {
        onStart: false,
        onComplete: true,
        onError: true,
        channels: ["toast", "desktop"],
        dueReminder: false,
      },
    })
  })

  it("mute is a no-op when the task is gone or the id is missing", async () => {
    const updateTask = jest.fn()
    installScheduledNotificationCommands({
      navigate: jest.fn(),
      getTask: jest.fn().mockResolvedValue(null),
      updateTask,
    })
    await dispatchNotificationCommand({
      notificationId: "n1",
      command: SCHEDULED_DUE_MUTE_COMMAND,
      args: { taskId: "ghost" },
    })
    await dispatchNotificationCommand({
      notificationId: "n1",
      command: SCHEDULED_DUE_MUTE_COMMAND,
    })
    expect(updateTask).not.toHaveBeenCalled()
  })

  it("returns an unregister function that removes both handlers", async () => {
    const navigate = jest.fn()
    const off = installScheduledNotificationCommands({ navigate })
    off()
    await dispatchNotificationCommand({
      notificationId: "n1",
      command: SCHEDULER_OPEN_TASK_COMMAND,
      args: { taskId: "t1" },
    })
    expect(navigate).not.toHaveBeenCalled()
  })
})
