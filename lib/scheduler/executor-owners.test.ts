/**
 * @jest-environment jsdom
 */

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

jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  detectPlatform: () => "web",
}))

jest.mock("@cognia/logging", () => {
  const stub = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
  return {
    loggers: new Proxy({}, { get: () => stub }),
    createLogger: () => stub,
  }
})

import { registerProviderDiagnosticsRefreshExecutor } from "@/lib/provider-diagnostics/refresh"
import {
  TASK_EXECUTOR_OWNERS,
  hasTaskExecutorOwner,
  loadTaskExecutorOwner,
} from "./executor-owners"
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

beforeEach(() => {
  jest.clearAllMocks()
  jest.useFakeTimers()
  unregisterTaskExecutor("provider-diagnostics-refresh")
})

afterEach(() => {
  jest.useRealTimers()
  unregisterTaskExecutor("provider-diagnostics-refresh")
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
})

describe("TASK_EXECUTOR_OWNERS", () => {
  it("declares the provider-diagnostics owner and nothing the built-ins or connectors own", () => {
    expect(Object.keys(TASK_EXECUTOR_OWNERS)).toEqual(["provider-diagnostics-refresh"])
    expect(Object.isFrozen(TASK_EXECUTOR_OWNERS)).toBe(true)
  })

  it("answers whether a type has an owner", () => {
    expect(hasTaskExecutorOwner("provider-diagnostics-refresh")).toBe(true)
    expect(hasTaskExecutorOwner("connection:presence:refresh")).toBe(false)
    expect(hasTaskExecutorOwner("chat")).toBe(false)
    // Inherited object keys are not owners.
    expect(hasTaskExecutorOwner("toString")).toBe(false)
  })

  it("loads a declared owner, which registers the executor", async () => {
    await expect(loadTaskExecutorOwner("provider-diagnostics-refresh")).resolves.toBe(true)
    expect(hasTaskExecutor("provider-diagnostics-refresh")).toBe(true)
  })

  it("resolves false without loading anything for a type with no owner", async () => {
    await expect(loadTaskExecutorOwner("connection:presence:refresh")).resolves.toBe(false)
    expect(registerProviderDiagnosticsRefreshExecutor).not.toHaveBeenCalled()
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
