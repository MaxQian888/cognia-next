/**
 * @jest-environment jsdom
 */

import type { Platform } from "@/lib/platform/detect"
import type { ScheduledTask, SchedulerTimingDriver } from "@/types/scheduler"

const mockProviderDiagnosticsExecutor = jest.fn(async () => ({
  success: true,
  output: { scanned: 0, refreshed: 0, paused: 0 },
}))

// The owning module registers against the REAL scheduler registry, exactly as
// `installProviderDiagnosticsRefreshSchedule` does at boot. Resolved lazily so
// the factory does not capture the registry before the suite imports it.
jest.mock("@/lib/provider-diagnostics/refresh", () => ({
  registerProviderDiagnosticsRefreshExecutor: jest.fn(() => {
    const { registerTaskExecutor } = jest.requireActual("@/lib/scheduler/task-scheduler")
    registerTaskExecutor("provider-diagnostics-refresh", mockProviderDiagnosticsExecutor)
  }),
}))

const mockBuiltInExecutor = jest.fn(async (task: ScheduledTask) => ({
  success: true,
  output: { ran: task.type },
}))

// Stands in for the real `registerBuiltInExecutors()`, which pulls in the whole
// executor graph (Claude IPC, backups, workflows, …). Registers every declared
// built-in type against the REAL registry, like the real one does; the real
// one's record is typed against the same list.
jest.mock("./executors", () => ({
  registerBuiltInExecutors: jest.fn(() => {
    const { registerTaskExecutor } = jest.requireActual("@/lib/scheduler/task-scheduler")
    const { BUILT_IN_EXECUTOR_TASK_TYPES } = jest.requireActual("@/lib/scheduler/executor-owners")
    for (const type of BUILT_IN_EXECUTOR_TASK_TYPES) {
      registerTaskExecutor(type, mockBuiltInExecutor)
    }
  }),
}))

jest.mock("./scheduler-db", () => ({
  schedulerDb: {
    getTasksByStatus: jest.fn().mockResolvedValue([]),
    getOverdueActiveTasks: jest.fn().mockResolvedValue([]),
    createTask: jest.fn().mockResolvedValue(undefined),
    updateTask: jest.fn().mockResolvedValue(undefined),
    claimTaskSlot: jest.fn().mockResolvedValue(null),
    getTask: jest.fn().mockResolvedValue(null),
    getAllTasks: jest.fn().mockResolvedValue([]),
    getActiveEventTasks: jest.fn().mockResolvedValue([]),
    createExecution: jest.fn().mockResolvedValue(undefined),
    updateExecution: jest.fn().mockResolvedValue(undefined),
    getTaskExecutions: jest.fn().mockResolvedValue([]),
    getTasksByType: jest.fn().mockResolvedValue([]),
    cleanupOldExecutions: jest.fn().mockResolvedValue(0),
    interruptStaleExecutions: jest.fn().mockResolvedValue(0),
    backfillTaskWorkspaces: jest.fn().mockResolvedValue(0),
    getExecution: jest.fn().mockResolvedValue(undefined),
  },
}))

jest.mock("./connection-task-orphans", () => ({
  reapOrphanedConnectionTasks: jest.fn(async () => []),
}))

jest.mock("./task-workspace-binding", () => ({
  resolveTaskWorkspace: jest.fn(async () => undefined),
  taskVisibleInWorkspace: () => true,
  backfillSessionWorkspace: jest.fn(async () => null),
}))

jest.mock("./write-authority", () => ({
  loadSchedulerPolicy: jest.fn(async () => ({
    agentAutoCreate: false,
    confirmationRequired: [],
    scriptTasksEnabled: true,
    maxTasksPerSource: 50,
    maxConcurrentExecutions: 5,
  })),
}))

jest.mock("./notification-integration", () => ({
  notifyTaskEvent: jest.fn().mockResolvedValue(undefined),
}))

jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginLifecycleHooks: () => ({
    dispatchOnScheduledTaskStart: jest.fn(),
    dispatchOnScheduledTaskComplete: jest.fn(),
    dispatchOnScheduledTaskError: jest.fn(),
  }),
}))

// The host every case runs on. Web by default, where provider diagnostics was
// verified; a built-in that needs the sidecar runs on the desktop.
let mockPlatform: Platform = "web"
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  detectPlatform: () => mockPlatform,
}))

jest.mock("@cognia/logging", () => {
  const stub = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
  return {
    loggers: new Proxy({}, { get: () => stub }),
    createLogger: () => stub,
  }
})

import { registerProviderDiagnosticsRefreshExecutor } from "@/lib/provider-diagnostics/refresh"
import { registerBuiltInExecutors } from "./executors"
import {
  BUILT_IN_EXECUTOR_TASK_TYPES,
  TASK_EXECUTOR_OWNERS,
  hasTaskExecutorOwner,
  loadTaskExecutorOwner,
} from "./executor-owners"
import { DEPRECATED_TASK_TYPES } from "./host-support"
import { schedulerDb } from "./scheduler-db"
import {
  createTaskScheduler,
  EXECUTOR_REGISTRATION_GRACE_MS,
  hasTaskExecutor,
  unregisterTaskExecutor,
} from "./task-scheduler"

const mockSchedulerDb = schedulerDb as jest.Mocked<typeof schedulerDb>

function makeDriver(): SchedulerTimingDriver {
  return {
    supportsLeaderElection: false,
    start: jest.fn(async () => undefined),
    stop: jest.fn(),
    onDue: jest.fn(),
    arm: jest.fn(async () => undefined),
    disarm: jest.fn(async () => undefined),
  } as unknown as SchedulerTimingDriver
}

function providerDiagnosticsTask(): ScheduledTask {
  const now = new Date()
  return {
    id: "provider-diagnostics",
    name: "Provider diagnostics refresh",
    type: "provider-diagnostics-refresh",
    trigger: { type: "interval", intervalMs: 5 * 60_000 },
    config: {
      maxRetries: 0,
      retryDelay: 1000,
      timeout: 30_000,
      runMissedOnStartup: true,
    },
    notification: { onStart: false, onComplete: false, onError: false },
    status: "active",
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    tags: ["system:provider-diagnostics"],
    createdAt: now,
    updatedAt: now,
  } as ScheduledTask
}

function builtInTask(type: ScheduledTask["type"]): ScheduledTask {
  const now = new Date()
  return {
    id: `persisted-${type}`,
    name: `Persisted ${type}`,
    type,
    trigger: { type: "interval", intervalMs: 60 * 60_000 },
    config: {
      maxRetries: 0,
      retryDelay: 1000,
      timeout: 30_000,
      runMissedOnStartup: true,
    },
    notification: { onStart: false, onComplete: false, onError: false },
    status: "active",
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: now,
    updatedAt: now,
  } as ScheduledTask
}

/**
 * Start a scheduler the way plugin activation does: a lifecycle write reaches
 * it before the scheduler initializer mounts, so `initSchedulerSystem` (the
 * built-ins, the provider-diagnostics install) never runs in this context.
 */
async function startWithoutSchedulerSystem() {
  const scheduler = createTaskScheduler(makeDriver())
  await scheduler.createTask({
    name: "demo-heartbeat",
    type: "plugin",
    trigger: { type: "interval", intervalMs: 60_000 },
    payload: { pluginId: "demo", handler: "heartbeat" },
  } as never)
  return scheduler
}

function unregisterEverythingTheOwnersRegister() {
  unregisterTaskExecutor("provider-diagnostics-refresh")
  for (const type of BUILT_IN_EXECUTOR_TASK_TYPES) unregisterTaskExecutor(type)
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.useFakeTimers()
  mockPlatform = "web"
  unregisterEverythingTheOwnersRegister()
})

afterEach(() => {
  jest.useRealTimers()
  unregisterEverythingTheOwnersRegister()
})

describe("a scheduler started without initSchedulerSystem", () => {
  it("runs the persisted provider-diagnostics task instead of failing with no executor", async () => {
    const scheduler = await startWithoutSchedulerSystem()
    expect(scheduler.getStatus().initialized).toBe(true)
    expect(hasTaskExecutor("provider-diagnostics-refresh")).toBe(false)

    // The boot that would register it never comes: the grace window runs out.
    jest.advanceTimersByTime(EXECUTOR_REGISTRATION_GRACE_MS + 1)
    const task = providerDiagnosticsTask()
    mockSchedulerDb.getTask.mockResolvedValue(task)

    const execution = await scheduler.runTaskNow(task.id, { triggerSource: "schedule" })

    expect(execution?.error).toBeUndefined()
    expect(execution?.terminalReason).toBe("completed")
    expect(execution?.status).toBe("completed")
    expect(registerProviderDiagnosticsRefreshExecutor).toHaveBeenCalledTimes(1)
    expect(mockProviderDiagnosticsExecutor).toHaveBeenCalledTimes(1)
    scheduler.stop()
  })

  it("does not reload the owner once its executor is registered", async () => {
    const scheduler = await startWithoutSchedulerSystem()
    const task = providerDiagnosticsTask()
    mockSchedulerDb.getTask.mockResolvedValue(task)

    await scheduler.runTaskNow(task.id)
    await scheduler.runTaskNow(task.id)

    expect(registerProviderDiagnosticsRefreshExecutor).toHaveBeenCalledTimes(1)
    expect(mockProviderDiagnosticsExecutor).toHaveBeenCalledTimes(2)
    scheduler.stop()
  })

  it("records a failed owner load and still ends in executor-not-found after the grace", async () => {
    jest.mocked(registerProviderDiagnosticsRefreshExecutor).mockImplementationOnce(() => {
      throw new Error("chunk failed to load")
    })
    const scheduler = await startWithoutSchedulerSystem()
    jest.advanceTimersByTime(EXECUTOR_REGISTRATION_GRACE_MS + 1)
    const task = providerDiagnosticsTask()
    mockSchedulerDb.getTask.mockResolvedValue(task)

    const execution = await scheduler.runTaskNow(task.id)

    expect(execution?.status).toBe("failed")
    expect(execution?.terminalReason).toBe("executor-not-found")
    expect(execution?.error).toBe(
      "No executor registered for task type: provider-diagnostics-refresh"
    )
    expect(
      execution?.logs.some(
        (entry) =>
          entry.level === "warn" &&
          entry.message ===
            'Loading the executor for "provider-diagnostics-refresh" failed: chunk failed to load'
      )
    ).toBe(true)
    expect(mockProviderDiagnosticsExecutor).not.toHaveBeenCalled()
    scheduler.stop()
  })

  it("runs a persisted built-in task after the boot grace instead of failing with no executor", async () => {
    mockPlatform = "tauri"
    const scheduler = await startWithoutSchedulerSystem()
    expect(hasTaskExecutor("chat")).toBe(false)

    // The workflow-automation chunk never mounts: the grace window runs out.
    jest.advanceTimersByTime(EXECUTOR_REGISTRATION_GRACE_MS + 1)
    const task = builtInTask("chat")
    mockSchedulerDb.getTask.mockResolvedValue(task)

    const execution = await scheduler.runTaskNow(task.id, { triggerSource: "schedule" })

    expect(execution?.error).toBeUndefined()
    expect(execution?.terminalReason).toBe("completed")
    expect(execution?.output).toEqual({ ran: "chat" })
    expect(registerBuiltInExecutors).toHaveBeenCalledTimes(1)
    scheduler.stop()
  })

  it("fails a built-in the host cannot run with the host's reason, not a missing executor", async () => {
    // Web has no sidecar. The executor now exists, so the central host gate
    // answers, as it does once `initSchedulerSystem` registered the built-ins.
    const scheduler = await startWithoutSchedulerSystem()
    jest.advanceTimersByTime(EXECUTOR_REGISTRATION_GRACE_MS + 1)
    const task = builtInTask("chat")
    mockSchedulerDb.getTask.mockResolvedValue(task)

    const execution = await scheduler.runTaskNow(task.id, { triggerSource: "schedule" })

    expect(execution?.status).toBe("failed")
    expect(execution?.terminalReason).toBe("unsupported-on-host")
    expect(registerBuiltInExecutors).toHaveBeenCalledTimes(1)
    expect(mockBuiltInExecutor).not.toHaveBeenCalled()
    scheduler.stop()
  })

  it("runs the plugin task whose creation started the scheduler", async () => {
    const scheduler = await startWithoutSchedulerSystem()
    const [heartbeat] = mockSchedulerDb.createTask.mock.calls[0] as [ScheduledTask]
    expect(heartbeat.type).toBe("plugin")
    jest.advanceTimersByTime(EXECUTOR_REGISTRATION_GRACE_MS + 1)
    mockSchedulerDb.getTask.mockResolvedValue(heartbeat)

    const execution = await scheduler.runTaskNow(heartbeat.id, { triggerSource: "schedule" })

    expect(execution?.status).toBe("completed")
    expect(mockBuiltInExecutor).toHaveBeenCalledWith(
      heartbeat,
      expect.anything(),
      expect.anything()
    )
    scheduler.stop()
  })

  it("loads a built-in inside the grace window instead of waiting for the initializer", async () => {
    mockPlatform = "tauri"
    const scheduler = await startWithoutSchedulerSystem()
    const task = builtInTask("backup")
    mockSchedulerDb.getTask.mockResolvedValue(task)

    const execution = await scheduler.runTaskNow(task.id)

    expect(execution?.status).toBe("completed")
    expect(execution?.logs.some((entry) => /waiting up to/.test(entry.message))).toBe(false)
    scheduler.stop()
  })

  it("registers the built-ins once for every built-in type that comes due", async () => {
    mockPlatform = "tauri"
    const scheduler = await startWithoutSchedulerSystem()
    for (const type of ["chat", "backup", "plugin"] as const) {
      const task = builtInTask(type)
      mockSchedulerDb.getTask.mockResolvedValue(task)
      await scheduler.runTaskNow(task.id)
    }

    expect(registerBuiltInExecutors).toHaveBeenCalledTimes(1)
    expect(mockBuiltInExecutor).toHaveBeenCalledTimes(3)
    scheduler.stop()
  })

  it("records a failed built-in load and still ends in executor-not-found after the grace", async () => {
    jest.mocked(registerBuiltInExecutors).mockImplementationOnce(() => {
      throw new Error("chunk failed to load")
    })
    const scheduler = await startWithoutSchedulerSystem()
    jest.advanceTimersByTime(EXECUTOR_REGISTRATION_GRACE_MS + 1)
    const task = builtInTask("chat")
    mockSchedulerDb.getTask.mockResolvedValue(task)

    const execution = await scheduler.runTaskNow(task.id)

    expect(execution?.status).toBe("failed")
    expect(execution?.terminalReason).toBe("executor-not-found")
    expect(execution?.error).toBe("No executor registered for task type: chat")
    expect(
      execution?.logs.some(
        (entry) =>
          entry.level === "warn" &&
          entry.message === 'Loading the executor for "chat" failed: chunk failed to load'
      )
    ).toBe(true)
    expect(mockBuiltInExecutor).not.toHaveBeenCalled()

    // The failure is not remembered: the next built-in to come due loads again.
    const heartbeat = builtInTask("plugin")
    mockSchedulerDb.getTask.mockResolvedValue(heartbeat)
    const retried = await scheduler.runTaskNow(heartbeat.id)
    expect(retried?.status).toBe("completed")
    expect(registerBuiltInExecutors).toHaveBeenCalledTimes(2)
    scheduler.stop()
  })
})

describe("TASK_EXECUTOR_OWNERS", () => {
  it("declares the built-ins and provider diagnostics, and no connector or deprecated type", () => {
    const owned = Object.keys(TASK_EXECUTOR_OWNERS)
    expect([...owned].sort()).toEqual(
      [...BUILT_IN_EXECUTOR_TASK_TYPES, "provider-diagnostics-refresh"].sort()
    )
    expect(owned.filter((type) => type.startsWith("connection:"))).toEqual([])
    expect(
      owned.filter((type) => (DEPRECATED_TASK_TYPES as readonly string[]).includes(type))
    ).toEqual([])
    expect(Object.isFrozen(TASK_EXECUTOR_OWNERS)).toBe(true)
    expect(Object.isFrozen(BUILT_IN_EXECUTOR_TASK_TYPES)).toBe(true)
  })

  it("answers whether a type has an owner", () => {
    expect(hasTaskExecutorOwner("provider-diagnostics-refresh")).toBe(true)
    expect(hasTaskExecutorOwner("chat")).toBe(true)
    expect(hasTaskExecutorOwner("plugin")).toBe(true)
    expect(hasTaskExecutorOwner("connection:presence:refresh")).toBe(false)
    expect(hasTaskExecutorOwner("sync")).toBe(false)
    // Inherited object keys are not owners.
    expect(hasTaskExecutorOwner("toString")).toBe(false)
  })

  it("loads a declared owner, which registers the executor", async () => {
    await expect(loadTaskExecutorOwner("provider-diagnostics-refresh")).resolves.toBe(true)
    expect(hasTaskExecutor("provider-diagnostics-refresh")).toBe(true)
    expect(registerBuiltInExecutors).not.toHaveBeenCalled()
  })

  it("loads the built-ins for any built-in type, which registers every one of them", async () => {
    await expect(loadTaskExecutorOwner("goal")).resolves.toBe(true)
    expect(registerBuiltInExecutors).toHaveBeenCalledTimes(1)
    expect(BUILT_IN_EXECUTOR_TASK_TYPES.filter((type) => !hasTaskExecutor(type))).toEqual([])
    expect(registerProviderDiagnosticsRefreshExecutor).not.toHaveBeenCalled()
  })

  it("resolves false without loading anything for a type with no owner", async () => {
    await expect(loadTaskExecutorOwner("connection:presence:refresh")).resolves.toBe(false)
    expect(registerProviderDiagnosticsRefreshExecutor).not.toHaveBeenCalled()
    expect(registerBuiltInExecutors).not.toHaveBeenCalled()
  })

  it("rejects when the owner fails to load", async () => {
    jest.mocked(registerProviderDiagnosticsRefreshExecutor).mockImplementationOnce(() => {
      throw new Error("chunk failed to load")
    })
    await expect(loadTaskExecutorOwner("provider-diagnostics-refresh")).rejects.toThrow(
      "chunk failed to load"
    )
  })
})
