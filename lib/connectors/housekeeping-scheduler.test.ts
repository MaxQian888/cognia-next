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

import {
  CALLBACK_BINDING_CLEANUP_TASK_TYPE,
  CONNECTOR_HOUSEKEEPING_EVENT,
  EXECUTION_RUN_RETENTION_TASK_TYPE,
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
})

it("installs one durable clock plus three event-triggered housekeeping tasks", async () => {
  await installConnectorHousekeepingSchedule()

  expect(registerTaskExecutor.mock.calls.map(([type]) => type)).toEqual([
    HOUSEKEEPING_CLOCK_TASK_TYPE,
    OUTBOUND_RETENTION_TASK_TYPE,
    CALLBACK_BINDING_CLEANUP_TASK_TYPE,
    EXECUTION_RUN_RETENTION_TASK_TYPE,
  ])
  expect(createTask).toHaveBeenCalledTimes(4)
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
})
