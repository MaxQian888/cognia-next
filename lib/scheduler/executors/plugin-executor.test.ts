/**
 * Tests for scheduler/executors/plugin-executor — stub used until a real
 * plugin runtime ships.
 */

jest.mock("@/lib/logger", () => {
  const stub = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
  return { loggers: { app: stub, scheduler: stub, store: stub, plugin: stub } }
})

import {
  executePluginTask,
  cancelPluginTaskExecution,
  getActivePluginTaskCount,
  isPluginTaskExecutionActive,
} from "./plugin-executor"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"

function makeTask(payload: unknown): ScheduledTask {
  return {
    id: "task-1",
    name: "Plugin Task",
    type: "plugin",
    trigger: { type: "cron", cronExpression: "0 9 * * *" },
    payload,
    config: {
      timeout: 300_000,
      maxRetries: 0,
      retryDelay: 1000,
      runMissedOnStartup: false,
      maxMissedRuns: 1,
      allowConcurrent: false,
    },
    notification: { onStart: false, onComplete: false, onError: false, channels: ["toast"] },
    status: "active",
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as ScheduledTask
}

function makeExecution(): TaskExecution {
  return {
    id: "exec-1",
    taskId: "task-1",
    taskName: "Plugin Task",
    taskType: "plugin",
    status: "running",
    retryAttempt: 0,
    startedAt: new Date(),
    logs: [],
  } as unknown as TaskExecution
}

describe("executePluginTask", () => {
  it("rejects payloads without pluginId", async () => {
    const r = await executePluginTask(makeTask({ handler: "h" }), makeExecution())
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/missing pluginId\/handler/)
  })

  it("rejects payloads without handler", async () => {
    const r = await executePluginTask(makeTask({ pluginId: "p" }), makeExecution())
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/missing pluginId\/handler/)
  })

  it("rejects undefined payload", async () => {
    const r = await executePluginTask(makeTask(undefined), makeExecution())
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/missing pluginId\/handler/)
  })

  it('returns the friendly "no runtime" error for valid payloads', async () => {
    const r = await executePluginTask(makeTask({ pluginId: "p", handler: "h" }), makeExecution())
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/p:h/)
    expect(r.error).toMatch(/cognia-next does not ship a plugin runtime/)
  })
})

describe("cancel/active helpers", () => {
  it("cancelPluginTaskExecution returns false for unknown executionId", () => {
    expect(cancelPluginTaskExecution("does-not-exist")).toBe(false)
  })

  it("isPluginTaskExecutionActive returns false for unknown executionId", () => {
    expect(isPluginTaskExecutionActive("does-not-exist")).toBe(false)
  })

  it("getActivePluginTaskCount starts at zero", () => {
    // No plugin runtime registers active controllers in cognia-next, so the
    // count must remain 0.
    expect(getActivePluginTaskCount()).toBe(0)
  })
})
