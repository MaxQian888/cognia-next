/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { DEFAULT_EXECUTION_CONFIG, type ScheduledTask } from "@/types/scheduler"
import { schedulerDb } from "./scheduler-db"
import {
  getTaskScheduler,
  initTaskScheduler,
  stopTaskScheduler,
  registerTaskExecutor,
  unregisterTaskExecutor,
} from "./task-scheduler"
import { notifyTaskEvent } from "./notification-integration"
import { NodeTimingDriver } from "./timing/node-driver"
import {
  ensureMaintenanceSchedule,
  reconcileMaintenanceNotifications,
  saveManagedTask,
} from "./managed-tasks"

jest.mock("./notification-integration", () => ({ notifyTaskEvent: jest.fn() }))

beforeEach(async () => {
  await schedulerDb.clearAll()
  await initTaskScheduler(new NodeTimingDriver())
})
afterEach(() => stopTaskScheduler())

const draft = {
  name: "Archive",
  type: "conversation-auto-archive",
  trigger: { type: "interval", intervalMs: 60_000 },
  tags: ["system:conversation-archive"],
} as const

function row(id: string, overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    ...draft,
    tags: [...draft.tags],
    id,
    config: { ...DEFAULT_EXECUTION_CONFIG },
    notification: { onStart: false, onComplete: true, onError: true, channels: ["toast"] },
    status: "active",
    nextRunAt: new Date(Date.now() + 60_000),
    createdAt: new Date(0),
    updatedAt: new Date(0),
    runCount: 9,
    successCount: 7,
    failureCount: 2,
    ...overrides,
  }
}

it("creates a silent maintenance singleton once under concurrent installation", async () => {
  const scheduler = getTaskScheduler()
  await Promise.all(
    Array.from({ length: 5 }, () =>
      ensureMaintenanceSchedule(scheduler, { ...draft, tags: [...draft.tags] })
    )
  )
  const rows = await schedulerDb.getAllTasks()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    id: "system:conversation-auto-archive",
    notification: {
      dueReminder: false,
      onStart: false,
      onComplete: false,
      onError: false,
      channels: ["none"],
    },
  })
  expect(scheduler.getStatus().scheduledCount).toBe(1)
})

it("records a failed maintenance run without emitting a user notification", async () => {
  const scheduler = getTaskScheduler()
  jest.mocked(notifyTaskEvent).mockClear()
  registerTaskExecutor(draft.type, async () => ({ success: false, error: "maintenance failed" }))
  try {
    await ensureMaintenanceSchedule(scheduler, {
      ...draft,
      tags: [...draft.tags],
      config: { maxRetries: 0 },
    })
    const execution = await scheduler.runTaskNow(`system:${draft.type}`)
    expect(execution?.status).toBe("failed")
    expect(await schedulerDb.getTaskExecutions(`system:${draft.type}`)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "failed", error: "maintenance failed" }),
      ])
    )
    expect(notifyTaskEvent).not.toHaveBeenCalled()
  } finally {
    unregisterTaskExecutor(draft.type)
  }
})

it("retires duplicate alarms without deleting their history or undoing a manual pause", async () => {
  const scheduler = getTaskScheduler()
  const paused = row("paused", { status: "paused" })
  const duplicate = row("duplicate")
  await schedulerDb.createTask(paused)
  await schedulerDb.createTask(duplicate)
  await scheduler.updateTask(duplicate.id, {})
  expect(scheduler.getStatus().scheduledCount).toBe(1)
  await ensureMaintenanceSchedule(scheduler, { ...draft, tags: [...draft.tags] })
  expect(await schedulerDb.getTask(paused.id)).toMatchObject({ status: "paused", runCount: 9 })
  expect(await schedulerDb.getTask(duplicate.id)).toMatchObject({
    status: "disabled",
    runCount: 9,
    tags: expect.arrayContaining(["system:maintenance-duplicate", "duplicate-of:paused"]),
  })
  expect(scheduler.getStatus().scheduledCount).toBe(0)
  await ensureMaintenanceSchedule(scheduler, { ...draft, tags: [...draft.tags] })
  expect(await schedulerDb.getAllTasks()).toHaveLength(2)
})

it("fences every lifecycle route of a retired duplicate, even after canonical deletion", async () => {
  const scheduler = getTaskScheduler()
  await schedulerDb.createTask(row("canonical"))
  await schedulerDb.createTask(row("retired", { createdAt: new Date(1) }))
  await ensureMaintenanceSchedule(scheduler, { ...draft, tags: [...draft.tags] })
  await expect(scheduler.pauseTask("retired")).resolves.toBe(false)
  await expect(scheduler.resumeTask("retired")).resolves.toBe(false)
  await expect(
    scheduler.setTaskOwner("retired", undefined, { status: "active" })
  ).rejects.toMatchObject({ code: "RETIRED_MAINTENANCE_TASK" })
  await expect(
    scheduler.updateTask("retired", { status: "active", tags: [] })
  ).rejects.toMatchObject({
    code: "RETIRED_MAINTENANCE_TASK",
  })
  await expect(scheduler.updateTask("retired", { tags: [] })).rejects.toMatchObject({
    code: "RETIRED_MAINTENANCE_TASK",
  })
  await scheduler.deleteTask("canonical")
  await expect(scheduler.runTaskNow("retired")).rejects.toMatchObject({
    code: "RETIRED_MAINTENANCE_TASK",
  })
  await ensureMaintenanceSchedule(scheduler, { ...draft, tags: [...draft.tags] })
  expect((await schedulerDb.getTask("retired"))?.status).toBe("disabled")
  expect((await schedulerDb.getTask(`system:${draft.type}`))?.status).toBe("active")
})

it.each([
  { type: "prompt" },
  { createdBy: { kind: "plugin", pluginId: "other" } },
  { status: "disabled", tags: ["system:maintenance-duplicate"] },
])("refuses a reserved identity occupied by an ineligible row: %j", async (overrides) => {
  const id = `system:${draft.type}`
  const existing = row(id, overrides as Partial<ScheduledTask>)
  await schedulerDb.createTask(existing)
  const persisted = await schedulerDb.getTask(id)
  await expect(
    ensureMaintenanceSchedule(getTaskScheduler(), { ...draft, tags: [...draft.tags] })
  ).rejects.toMatchObject({ code: "MAINTENANCE_IDENTITY_COLLISION" })
  expect(await schedulerDb.getTask(id)).toEqual(persisted)
})

it("leaves plugin-authored and remote-host tasks out of local singleton reconciliation", async () => {
  await schedulerDb.createTask(row("plugin", { createdBy: { kind: "plugin", pluginId: "p" } }))
  await schedulerDb.createTask(
    row("remote", {
      owner: {
        kind: "remote-host",
        hostId: "other",
        hostLabel: "Other",
        remoteItemId: "remote-item",
        operationId: "move",
        movedAt: 0,
      },
    } as Partial<ScheduledTask>)
  )
  await ensureMaintenanceSchedule(getTaskScheduler(), { ...draft, tags: [...draft.tags] })
  expect((await schedulerDb.getTask("plugin"))?.status).toBe("active")
  expect((await schedulerDb.getTask("remote"))?.status).toBe("active")
  expect(await schedulerDb.getAllTasks()).toHaveLength(3)
})

it("adopts old inherited toast defaults, preserving explicit delivery channels", async () => {
  await schedulerDb.createTask(row("legacy", { type: "github-issue-sync" }))
  await schedulerDb.createTask(
    row("explicit", {
      notification: {
        onStart: false,
        onComplete: false,
        onError: true,
        channels: ["desktop"],
        dueReminder: true,
      },
    })
  )
  await reconcileMaintenanceNotifications(getTaskScheduler())
  expect((await schedulerDb.getTask("legacy"))?.notification).toMatchObject({
    channels: ["none"],
    dueReminder: false,
  })
  expect((await schedulerDb.getTask("explicit"))?.notification).toMatchObject({
    channels: ["desktop"],
    dueReminder: true,
  })
})

it("keeps identity, counts and manual pauses when settings retime a managed task", async () => {
  const existing = row("managed", { status: "paused" })
  await schedulerDb.createTask(existing)
  await saveManagedTask(
    getTaskScheduler(),
    { ...existing, status: "active", trigger: { type: "interval", intervalMs: 120_000 } },
    existing
  )
  expect(await schedulerDb.getTask(existing.id)).toMatchObject({
    status: "paused",
    runCount: 9,
    successCount: 7,
    trigger: { intervalMs: 120_000 },
  })
  expect(getTaskScheduler().getStatus().scheduledCount).toBe(0)
})

it("does not rewrite remote-host placeholders during boot migration", async () => {
  const remote = row("remote", {
    owner: {
      kind: "remote-host",
      hostId: "other",
      hostLabel: "Other",
      remoteItemId: "r",
      operationId: "move",
      movedAt: 0,
    },
    status: "disabled",
  })
  await schedulerDb.createTask(remote)
  await expect(reconcileMaintenanceNotifications(getTaskScheduler())).resolves.toBeUndefined()
  expect((await schedulerDb.getTask(remote.id))?.notification.channels).toEqual(["toast"])
})

it("abandons a boot migration if it is stopped while the initial database read is pending", async () => {
  const scheduler = getTaskScheduler()
  let finishRead: (tasks: ScheduledTask[]) => void = () => undefined
  let current = true
  const read = jest.spyOn(scheduler, "getAllTasks").mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishRead = resolve
      })
  )
  const update = jest.spyOn(scheduler, "updateTask")
  const migration = reconcileMaintenanceNotifications(scheduler, () => current)
  current = false
  scheduler.stop()
  finishRead([row("legacy")])
  await migration
  expect(update).not.toHaveBeenCalled()
  expect(scheduler.getStatus().initialized).toBe(false)
  read.mockRestore()
  update.mockRestore()
})

it("stops a boot migration between task updates", async () => {
  const scheduler = getTaskScheduler()
  await schedulerDb.createTask(row("first"))
  await schedulerDb.createTask(row("second"))
  let current = true
  const original = scheduler.updateTask.bind(scheduler)
  const update = jest.spyOn(scheduler, "updateTask").mockImplementation(async (id, input) => {
    const result = await original(id, input)
    current = false
    scheduler.stop()
    return result
  })
  await reconcileMaintenanceNotifications(scheduler, () => current)
  expect(update).toHaveBeenCalledTimes(1)
  expect(scheduler.getStatus().initialized).toBe(false)
  update.mockRestore()
})

it("adopts a concurrent winner through the live clock but propagates other failures", async () => {
  const scheduler = getTaskScheduler()
  const create = jest.spyOn(scheduler, "createTask")
  create.mockImplementationOnce(async (input) => {
    await schedulerDb.createTask(row(input.id!))
    const collision = new Error("already installed")
    collision.name = "ConstraintError"
    throw collision
  })
  await ensureMaintenanceSchedule(scheduler, { ...draft, tags: [...draft.tags] })
  expect(scheduler.getStatus().scheduledCount).toBe(1)
  create.mockRestore()
  const failed = jest
    .spyOn(scheduler, "createTask")
    .mockRejectedValueOnce(new Error("disk unavailable"))
  await expect(
    ensureMaintenanceSchedule(scheduler, {
      ...draft,
      type: "files-trash-purge",
      tags: [...draft.tags],
    })
  ).rejects.toThrow("disk unavailable")
  failed.mockRestore()
})
