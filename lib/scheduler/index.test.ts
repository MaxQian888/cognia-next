/**
 * @jest-environment jsdom
 *
 * Tests for the scheduler module barrel — every named export must resolve
 * to a defined value, and initSchedulerSystem/stopSchedulerSystem must wire
 * into the executor and scheduler lifecycles.
 */

const registerBuiltInExecutorsMock = jest.fn()
const initTaskSchedulerMock = jest.fn(async () => undefined)
const stopTaskSchedulerMock = jest.fn()

jest.mock("./executors", () => ({
  registerBuiltInExecutors: () => registerBuiltInExecutorsMock(),
  executeChatTask: jest.fn(),
  executeAgentTask: jest.fn(),
  executeSkillTask: jest.fn(),
  executeScriptTask: jest.fn(),
  executePluginTask: jest.fn(),
  executeBackupTask: jest.fn(),
  executeCustomTask: jest.fn(),
}))

jest.mock("./executors/plugin-executor", () => ({
  cancelPluginTaskExecution: jest.fn(),
  getActivePluginTaskCount: jest.fn(),
  isPluginTaskExecutionActive: jest.fn(),
  executePluginTask: jest.fn(),
}))

jest.mock("./task-scheduler", () => ({
  __esModule: true,
  getTaskScheduler: jest.fn(),
  createTaskScheduler: jest.fn(),
  initTaskScheduler: () => initTaskSchedulerMock(),
  stopTaskScheduler: () => stopTaskSchedulerMock(),
  registerTaskExecutor: jest.fn(),
  unregisterTaskExecutor: jest.fn(),
}))

jest.mock("@/lib/logger", () => {
  const stub = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
  return { loggers: { app: stub, scheduler: stub, store: stub, plugin: stub } }
})

import * as barrel from "./index"

beforeEach(() => {
  registerBuiltInExecutorsMock.mockClear()
  initTaskSchedulerMock.mockClear()
  stopTaskSchedulerMock.mockClear()
})

describe("scheduler barrel re-exports", () => {
  const expectedExports = [
    // Core scheduler
    "getTaskScheduler",
    "createTaskScheduler",
    "initTaskScheduler",
    "stopTaskScheduler",
    "registerTaskExecutor",
    "unregisterTaskExecutor",
    // Cron
    "parseCronExpression",
    "validateCronExpression",
    "getNextCronTime",
    "getNextCronTimes",
    "describeCronExpression",
    "formatCronExpression",
    "matchesCronExpression",
    // Trigger normalization
    "normalizeTaskTrigger",
    "isValidTimezone",
    // Conversational authoring
    "createScheduledAgentTaskDraft",
    "createScheduledChatTaskDraft",
    "normalizeConversationalTaskPayload",
    // DB
    "schedulerDb",
    "SchedulerDatabase",
    // Notifications
    "notifyTaskEvent",
    "testNotificationChannel",
    // Executors
    "registerBuiltInExecutors",
    "executeChatTask",
    "executeAgentTask",
    "executeSkillTask",
    "executeScriptTask",
    "executePluginTask",
    "executeBackupTask",
    "executeCustomTask",
    "cancelPluginTaskExecution",
    "getActivePluginTaskCount",
    "isPluginTaskExecutionActive",
    // Scripts
    "executeScript",
    "validateScript",
    "getScriptTemplate",
    "getSupportedLanguages",
    // Errors
    "SchedulerError",
    // Tab lock
    "isLeaderTab",
    "startLeaderElection",
    "stopLeaderElection",
    "onLeaderChange",
    "getTabId",
    // Format
    "formatDuration",
    "formatRelativeTime",
    "formatNextRun",
    // Event
    "emitSchedulerEvent",
    "createEventData",
    "isValidEventType",
    // Lifecycle
    "initSchedulerSystem",
    "stopSchedulerSystem",
  ]

  for (const name of expectedExports) {
    it(`re-exports ${name}`, () => {
      const exportsRecord = barrel as Record<string, unknown>
      expect(exportsRecord[name]).toBeDefined()
    })
  }
})

describe("initSchedulerSystem", () => {
  it("registers built-in executors and starts the scheduler", async () => {
    await barrel.initSchedulerSystem()
    expect(registerBuiltInExecutorsMock).toHaveBeenCalled()
    expect(initTaskSchedulerMock).toHaveBeenCalled()
  })
})

describe("stopSchedulerSystem", () => {
  it("stops the scheduler", async () => {
    await barrel.stopSchedulerSystem()
    expect(stopTaskSchedulerMock).toHaveBeenCalled()
  })
})
