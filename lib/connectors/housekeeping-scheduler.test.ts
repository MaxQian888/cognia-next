const registerTaskExecutor = jest.fn()
const getAllTasks = jest.fn()
const createTask = jest.fn()
const triggerEventTask = jest.fn()

jest.mock("@/lib/scheduler/task-scheduler", () => ({
  registerTaskExecutor: (...args: unknown[]) => registerTaskExecutor(...args),
  getTaskScheduler: () => ({ getAllTasks, createTask, triggerEventTask }),
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
  CONNECTOR_HOUSEKEEPING_EVENT,
  EXECUTION_RUN_RETENTION_TASK_TYPE,
  CONNECTOR_RETENTION_TASK_TYPE,
  HOUSEKEEPING_CLOCK_TASK_TYPE,
  OUTBOUND_RETENTION_TASK_TYPE,
  installConnectorHousekeepingSchedule,
} from "./housekeeping-scheduler"

beforeEach(() => {
  jest.clearAllMocks()
  getAllTasks.mockResolvedValue([])
  createTask.mockImplementation(async (input) => ({ id: input.type, ...input }))
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
    })
  )
  for (const type of [
    OUTBOUND_RETENTION_TASK_TYPE,
    CALLBACK_BINDING_CLEANUP_TASK_TYPE,
    EXECUTION_RUN_RETENTION_TASK_TYPE,
    CONNECTOR_RETENTION_TASK_TYPE,
    ATTACHMENT_CACHE_TASK_TYPE,
  ]) {
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        type,
        trigger: { type: "event", eventType: CONNECTOR_HOUSEKEEPING_EVENT },
      })
    )
  }
  expect(triggerEventTask).toHaveBeenCalledWith(
    CONNECTOR_HOUSEKEEPING_EVENT,
    "connector-runtime-boot",
    expect.any(Object)
  )
})

it("does not duplicate durable tasks that already exist", async () => {
  getAllTasks.mockResolvedValue([
    { type: HOUSEKEEPING_CLOCK_TASK_TYPE },
    { type: OUTBOUND_RETENTION_TASK_TYPE },
    { type: CALLBACK_BINDING_CLEANUP_TASK_TYPE },
    { type: EXECUTION_RUN_RETENTION_TASK_TYPE },
    { type: CONNECTOR_RETENTION_TASK_TYPE },
    { type: ATTACHMENT_CACHE_TASK_TYPE },
  ])

  await installConnectorHousekeepingSchedule()

  expect(createTask).not.toHaveBeenCalled()
})

it("registers executors that emit the daily event and run each sweep", async () => {
  await installConnectorHousekeepingSchedule()
  const executorFor = (type: string) =>
    registerTaskExecutor.mock.calls.find(([registeredType]) => registeredType === type)?.[1] as (
      task: { id: string },
      execution: { id: string },
      signal: AbortSignal
    ) => Promise<unknown>
  const task = { id: "task-1" }
  const execution = { id: "exec-1" }
  const signal = new AbortController().signal

  await executorFor(HOUSEKEEPING_CLOCK_TASK_TYPE)(task, execution, signal)
  expect(triggerEventTask).toHaveBeenCalledWith(
    CONNECTOR_HOUSEKEEPING_EVENT,
    "connector-housekeeping-clock",
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
  const executor = registerTaskExecutor.mock.calls.find(
    ([type]) => type === ATTACHMENT_CACHE_TASK_TYPE
  )?.[1] as (t: unknown, e: unknown, s: AbortSignal) => Promise<unknown>
  await executor({ id: "t" }, { id: "e" }, new AbortController().signal)

  expect(order).toEqual(["ledger", "orphans", "budget"])
})
