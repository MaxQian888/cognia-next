const registerTaskExecutor = jest.fn()
const getAllTasks = jest.fn()
const createTask = jest.fn()
const updateTask = jest.fn()
const triggerEventTask = jest.fn()

jest.mock("@/lib/scheduler/task-scheduler", () => ({
  registerTaskExecutor: (...args: unknown[]) => registerTaskExecutor(...args),
  getTaskScheduler: () => ({ getAllTasks, createTask, updateTask, triggerEventTask }),
}))

const cleanupExpiredCallbackBindings = jest.fn()
jest.mock("./callback-binding-cleanup", () => ({
  cleanupExpiredCallbackBindings: (...args: unknown[]) => cleanupExpiredCallbackBindings(...args),
}))

const sweepTerminalOutboundRows = jest.fn()
jest.mock("@/lib/db/outbound-jobs", () => ({
  sweepTerminalOutboundRows: (...args: unknown[]) => sweepTerminalOutboundRows(...args),
}))

const sweepExecutionRunEventRetention = jest.fn()
jest.mock("@/lib/db/execution-runs", () => ({
  sweepExecutionRunEventRetention: (...args: unknown[]) => sweepExecutionRunEventRetention(...args),
}))

const sweepTerminalConnectorInboundJobs = jest.fn()
jest.mock("@/lib/db/connector-inbound-jobs", () => ({
  sweepTerminalConnectorInboundJobs: (...args: unknown[]) =>
    sweepTerminalConnectorInboundJobs(...args),
}))
const sweepConnectorAuditRetention = jest.fn()
jest.mock("@/lib/db/connector-audit", () => ({
  sweepConnectorAuditRetention: (...args: unknown[]) => sweepConnectorAuditRetention(...args),
}))
const sweepConnectorHeartbeats = jest.fn()
jest.mock("@/lib/connectors/health/heartbeat", () => ({
  sweepConnectorHeartbeats: (...args: unknown[]) => sweepConnectorHeartbeats(...args),
}))
const runCleanupLedger = jest.fn()
const reconcileOrphanedAttachments = jest.fn()
const enforceAttachmentBudget = jest.fn()
jest.mock("@/lib/connectors/attachment-fetcher", () => ({
  runCleanupLedger: (...args: unknown[]) => runCleanupLedger(...args),
  reconcileOrphanedAttachments: (...args: unknown[]) => reconcileOrphanedAttachments(...args),
  enforceAttachmentBudget: (...args: unknown[]) => enforceAttachmentBudget(...args),
}))

import {
  ATTACHMENT_CACHE_TASK_TYPE,
  CALLBACK_BINDING_CLEANUP_TASK_TYPE,
  CONNECTOR_HOUSEKEEPING_BOOT_SOURCE,
  CONNECTOR_HOUSEKEEPING_CLOCK_SOURCE,
  CONNECTOR_HOUSEKEEPING_EVENT,
  EXECUTION_RUN_RETENTION_TASK_TYPE,
  CONNECTOR_RETENTION_TASK_TYPE,
  HOUSEKEEPING_CLOCK_TASK_TYPE,
  HOUSEKEEPING_OVERLAP_POLICY,
  OUTBOUND_RETENTION_TASK_TYPE,
  __resetHousekeepingSweepDebounceForTests,
  housekeepingOverlapDrift,
  installConnectorHousekeepingSchedule,
} from "./housekeeping-scheduler"
import type { TaskExecutionConfig } from "@/types/scheduler"

const SWEEP_TASK_TYPES = [
  OUTBOUND_RETENTION_TASK_TYPE,
  CALLBACK_BINDING_CLEANUP_TASK_TYPE,
  EXECUTION_RUN_RETENTION_TASK_TYPE,
  CONNECTOR_RETENTION_TASK_TYPE,
  ATTACHMENT_CACHE_TASK_TYPE,
]

/** A persisted row as `taskDrafts` used to create it, before this fix. */
function legacyRow(type: string) {
  return {
    id: `row-${type}`,
    type,
    config: { allowConcurrent: false } as TaskExecutionConfig,
  }
}

type Executor = (
  task: { id: string },
  execution: { id: string; triggerSource?: string },
  signal: AbortSignal
) => Promise<unknown>

const executorFor = (type: string): Executor =>
  registerTaskExecutor.mock.calls.find(([registeredType]) => registeredType === type)?.[1]

beforeEach(() => {
  jest.clearAllMocks()
  __resetHousekeepingSweepDebounceForTests()
  getAllTasks.mockResolvedValue([])
  createTask.mockImplementation(async (input) => ({ id: input.type, ...input }))
  updateTask.mockResolvedValue(null)
  triggerEventTask.mockResolvedValue(undefined)
  cleanupExpiredCallbackBindings.mockResolvedValue({
    expiredCount: 1,
    legacyCount: 2,
    total: 3,
  })
  sweepTerminalOutboundRows.mockResolvedValue(4)
  sweepExecutionRunEventRetention.mockResolvedValue(5)
  sweepTerminalConnectorInboundJobs.mockResolvedValue(6)
  sweepConnectorAuditRetention.mockResolvedValue(7)
  sweepConnectorHeartbeats.mockResolvedValue(8)
  runCleanupLedger.mockResolvedValue({ resolved: 2, stillFailing: 1 })
  reconcileOrphanedAttachments.mockResolvedValue({
    deleted: ["k1", "k2", "k3"],
    freedBytes: 300,
    failed: [],
  })
  enforceAttachmentBudget.mockResolvedValue({ deleted: ["k4"], freedBytes: 100, failed: [] })
})

it("installs one durable clock plus bounded event-triggered housekeeping tasks", async () => {
  await installConnectorHousekeepingSchedule()

  expect(registerTaskExecutor.mock.calls.map(([type]) => type)).toEqual([
    HOUSEKEEPING_CLOCK_TASK_TYPE,
    OUTBOUND_RETENTION_TASK_TYPE,
    CALLBACK_BINDING_CLEANUP_TASK_TYPE,
    EXECUTION_RUN_RETENTION_TASK_TYPE,
    ATTACHMENT_CACHE_TASK_TYPE,
    CONNECTOR_RETENTION_TASK_TYPE,
  ])
  expect(createTask).toHaveBeenCalledTimes(6)
  expect(createTask).toHaveBeenCalledWith(
    expect.objectContaining({
      type: HOUSEKEEPING_CLOCK_TASK_TYPE,
      trigger: { type: "interval", intervalMs: 86_400_000 },
      config: {
        overlapPolicy: HOUSEKEEPING_OVERLAP_POLICY,
        runMissedOnStartup: true,
        catchupWindowMs: 7 * 86_400_000,
        maxMissedRuns: 1,
      },
    })
  )
  for (const type of SWEEP_TASK_TYPES) {
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        type,
        trigger: { type: "event", eventType: CONNECTOR_HOUSEKEEPING_EVENT },
      })
    )
  }
  expect(triggerEventTask).toHaveBeenCalledWith(
    CONNECTOR_HOUSEKEEPING_EVENT,
    CONNECTOR_HOUSEKEEPING_BOOT_SOURCE,
    expect.any(Object)
  )
})

it("gives every housekeeping task a queueing overlap policy", async () => {
  // One clock plus five sweeps is 6 starts against a default host cap of 5, so
  // exactly one start per sweep is always refused. Under `skip` that start was
  // dropped outright and the sweep did not run until the next day, where the
  // same task lost again.
  await installConnectorHousekeepingSchedule()

  const drafts = createTask.mock.calls.map(([draft]) => draft)
  expect(drafts).toHaveLength(6)
  for (const draft of drafts) {
    expect(draft.config?.overlapPolicy).toBe(HOUSEKEEPING_OVERLAP_POLICY)
  }
})

it("does not duplicate durable tasks that already exist", async () => {
  getAllTasks.mockResolvedValue(
    [HOUSEKEEPING_CLOCK_TASK_TYPE, ...SWEEP_TASK_TYPES].map((type) => ({
      id: `row-${type}`,
      type,
      config: { overlapPolicy: HOUSEKEEPING_OVERLAP_POLICY } as TaskExecutionConfig,
    }))
  )

  await installConnectorHousekeepingSchedule()

  expect(createTask).not.toHaveBeenCalled()
  expect(updateTask).not.toHaveBeenCalled()
})

it("reconciles rows that predate the queueing policy", async () => {
  // The installer only creates types it cannot find, so a fix confined to the
  // drafts would never reach a host that already has these six rows.
  getAllTasks.mockResolvedValue(
    [HOUSEKEEPING_CLOCK_TASK_TYPE, ...SWEEP_TASK_TYPES].map((type) => legacyRow(type))
  )

  await installConnectorHousekeepingSchedule()

  expect(createTask).not.toHaveBeenCalled()
  expect(updateTask).toHaveBeenCalledTimes(6)
  for (const type of [HOUSEKEEPING_CLOCK_TASK_TYPE, ...SWEEP_TASK_TYPES]) {
    expect(updateTask).toHaveBeenCalledWith(`row-${type}`, {
      config: { overlapPolicy: HOUSEKEEPING_OVERLAP_POLICY },
    })
  }
})

it("leaves an operator's own queueing choice alone", async () => {
  getAllTasks.mockResolvedValue(
    [HOUSEKEEPING_CLOCK_TASK_TYPE, ...SWEEP_TASK_TYPES].map((type) => ({
      id: `row-${type}`,
      type,
      config: { overlapPolicy: "queue-all" } as TaskExecutionConfig,
    }))
  )

  await installConnectorHousekeepingSchedule()

  expect(updateTask).not.toHaveBeenCalled()
})

describe("housekeepingOverlapDrift", () => {
  it("reports drift for every policy that drops a blocked start", () => {
    expect(housekeepingOverlapDrift(undefined)).toBe(HOUSEKEEPING_OVERLAP_POLICY)
    expect(housekeepingOverlapDrift({ overlapPolicy: "skip" } as TaskExecutionConfig)).toBe(
      HOUSEKEEPING_OVERLAP_POLICY
    )
    expect(housekeepingOverlapDrift({ overlapPolicy: "allow" } as TaskExecutionConfig)).toBe(
      HOUSEKEEPING_OVERLAP_POLICY
    )
    expect(
      housekeepingOverlapDrift({ overlapPolicy: "cancel-previous" } as TaskExecutionConfig)
    ).toBe(HOUSEKEEPING_OVERLAP_POLICY)
    // Legacy spelling: no `overlapPolicy` at all resolves to "skip".
    expect(housekeepingOverlapDrift({ allowConcurrent: false } as TaskExecutionConfig)).toBe(
      HOUSEKEEPING_OVERLAP_POLICY
    )
  })

  it("reports no drift once the row buffers", () => {
    expect(
      housekeepingOverlapDrift({ overlapPolicy: "queue-one" } as TaskExecutionConfig)
    ).toBeUndefined()
    expect(
      housekeepingOverlapDrift({ overlapPolicy: "queue-all" } as TaskExecutionConfig)
    ).toBeUndefined()
  })
})

it("collapses the boot sweep and the clock catch-up into one sweep", async () => {
  // Both fire inside one startup window. Two bursts of five starts against a
  // cap of five is what produced the concurrency-blocked / overlap-skipped
  // pile-up in the logs.
  await installConnectorHousekeepingSchedule()
  expect(triggerEventTask).toHaveBeenCalledTimes(1)

  await executorFor(HOUSEKEEPING_CLOCK_TASK_TYPE)(
    { id: "task-1" },
    { id: "exec-1", triggerSource: "catch-up" },
    new AbortController().signal
  )

  expect(triggerEventTask).toHaveBeenCalledTimes(1)
})

it("does not let a failed dispatch stand in for the sweep it never started", async () => {
  triggerEventTask.mockRejectedValueOnce(new Error("scheduler unavailable"))

  await expect(installConnectorHousekeepingSchedule()).rejects.toThrow("scheduler unavailable")

  // The boot sweep never reached the scheduler, so the clock's catch-up is
  // still the sweep for this startup.
  await executorFor(HOUSEKEEPING_CLOCK_TASK_TYPE)(
    { id: "task-1" },
    { id: "exec-1", triggerSource: "catch-up" },
    new AbortController().signal
  )

  expect(triggerEventTask).toHaveBeenCalledTimes(2)
  expect(triggerEventTask).toHaveBeenLastCalledWith(
    CONNECTOR_HOUSEKEEPING_EVENT,
    CONNECTOR_HOUSEKEEPING_CLOCK_SOURCE,
    { clockTaskId: "task-1" }
  )
})

it("never swallows a manual sweep", async () => {
  await installConnectorHousekeepingSchedule()
  expect(triggerEventTask).toHaveBeenCalledTimes(1)

  await expect(
    executorFor(HOUSEKEEPING_CLOCK_TASK_TYPE)(
      { id: "task-1" },
      { id: "exec-1", triggerSource: "run-now" },
      new AbortController().signal
    )
  ).resolves.toEqual({
    success: true,
    output: { eventType: CONNECTOR_HOUSEKEEPING_EVENT, dispatched: true },
  })

  expect(triggerEventTask).toHaveBeenCalledTimes(2)
  expect(triggerEventTask).toHaveBeenLastCalledWith(
    CONNECTOR_HOUSEKEEPING_EVENT,
    CONNECTOR_HOUSEKEEPING_CLOCK_SOURCE,
    { clockTaskId: "task-1" }
  )
})

it("registers executors that emit the daily event and run each sweep", async () => {
  await installConnectorHousekeepingSchedule()
  const task = { id: "task-1" }
  const execution = { id: "exec-1", triggerSource: "schedule" }
  const signal = new AbortController().signal

  __resetHousekeepingSweepDebounceForTests()
  await executorFor(HOUSEKEEPING_CLOCK_TASK_TYPE)(task, execution, signal)
  expect(triggerEventTask).toHaveBeenCalledWith(
    CONNECTOR_HOUSEKEEPING_EVENT,
    CONNECTOR_HOUSEKEEPING_CLOCK_SOURCE,
    { clockTaskId: "task-1" }
  )

  await expect(executorFor(OUTBOUND_RETENTION_TASK_TYPE)(task, execution, signal)).resolves.toEqual(
    { success: true, output: { deleted: 4 } }
  )
  await expect(
    executorFor(CALLBACK_BINDING_CLEANUP_TASK_TYPE)(task, execution, signal)
  ).resolves.toEqual({ success: true, output: { expiredCount: 1, legacyCount: 2, total: 3 } })
  await expect(
    executorFor(EXECUTION_RUN_RETENTION_TASK_TYPE)(task, execution, signal)
  ).resolves.toEqual({ success: true, output: { deleted: 5 } })
  await expect(
    executorFor(CONNECTOR_RETENTION_TASK_TYPE)(task, execution, signal)
  ).resolves.toEqual({
    success: true,
    output: { inboundDeleted: 6, auditDeleted: 7, heartbeatDeleted: 8 },
  })
  await expect(executorFor(ATTACHMENT_CACHE_TASK_TYPE)(task, execution, signal)).resolves.toEqual({
    success: true,
    output: {
      ledgerResolved: 2,
      ledgerStillFailing: 1,
      orphansDeleted: 3,
      orphanBytesFreed: 300,
      evicted: 1,
      evictedBytesFreed: 100,
    },
  })
})

it("retries stuck blob deletes before reclaiming space", async () => {
  // Order matters: a blob whose delete finally succeeds must be off the books
  // before the budget is measured, or it is counted against the cap and a
  // live attachment gets evicted in its place.
  const order: string[] = []
  runCleanupLedger.mockImplementation(async () => {
    order.push("ledger")
    return { resolved: 0, stillFailing: 0 }
  })
  reconcileOrphanedAttachments.mockImplementation(async () => {
    order.push("orphans")
    return { deleted: [], freedBytes: 0, failed: [] }
  })
  enforceAttachmentBudget.mockImplementation(async () => {
    order.push("budget")
    return { deleted: [], freedBytes: 0, failed: [] }
  })

  await installConnectorHousekeepingSchedule()
  await executorFor(ATTACHMENT_CACHE_TASK_TYPE)(
    { id: "t" },
    { id: "e", triggerSource: "schedule" },
    new AbortController().signal
  )

  expect(order).toEqual(["ledger", "orphans", "budget"])
})
