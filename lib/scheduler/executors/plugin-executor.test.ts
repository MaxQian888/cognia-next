/**
 * Tests for scheduler/executors/plugin-executor — stub used until a real
 * plugin runtime ships.
 */

jest.mock("@cognia/logging", () => {
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
    const r = await executePluginTask(
      makeTask({ handler: "h" }),
      makeExecution(),
      new AbortController().signal
    )
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/missing pluginId\/handler/)
  })

  it("rejects payloads without handler", async () => {
    const r = await executePluginTask(
      makeTask({ pluginId: "p" }),
      makeExecution(),
      new AbortController().signal
    )
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/missing pluginId\/handler/)
  })

  it("rejects undefined payload", async () => {
    const r = await executePluginTask(
      makeTask(undefined),
      makeExecution(),
      new AbortController().signal
    )
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/missing pluginId\/handler/)
  })

  it("returns a friendly error when no handler is registered", async () => {
    const r = await executePluginTask(
      makeTask({ pluginId: "p", handler: "h" }),
      makeExecution(),
      new AbortController().signal
    )
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/p:h/)
    // Activated executor wording — the message tells the user a plugin
    // contributing this handler is disabled or not installed.
    expect(r.error).toMatch(/handler not registered/)
  })
})

// §B-2 activation: when a plugin registers a real handler, the executor
// dispatches to it and returns the handler's result, not the placeholder
// "not registered" failure.
describe("executePluginTask — activated handler dispatch", () => {
  // Use require() so we don't widen the top-level imports — these helpers
  // are only relevant to the activation tests.
  const reg =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("@/lib/plugin/scheduler/scheduler-plugin-executor") as typeof import("@/lib/plugin/scheduler/scheduler-plugin-executor")

  afterEach(() => {
    reg.clearPluginTaskHandlers()
  })

  it("records reportProgress on the execution instead of dropping it in a debug log", async () => {
    reg.registerPluginTaskHandler("p:progress", async (_args, ctx) => {
      ctx.reportProgress(0.5, "halfway")
      return { success: true }
    })

    const execution = makeExecution()
    const r = await executePluginTask(
      makeTask({ pluginId: "p", handler: "progress" }),
      execution,
      new AbortController().signal
    )

    expect(r.success).toBe(true)
    const progressLogs = execution.logs.filter(
      (row) => (row.data as { kind?: string } | undefined)?.kind === "progress"
    )
    expect(progressLogs).toHaveLength(1)
    expect(progressLogs[0].message).toBe("50% — halfway")
  })

  it("dispatches to the registered handler and forwards the result", async () => {
    const handler = jest.fn(async () => ({
      success: true,
      output: { hello: "world" },
    }))
    reg.registerPluginTaskHandler("p:h", handler)

    const r = await executePluginTask(
      makeTask({ pluginId: "p", handler: "h", args: { foo: 1 } }),
      makeExecution(),
      new AbortController().signal
    )
    expect(r.success).toBe(true)
    expect(r.output).toEqual({ hello: "world" })
    expect(handler).toHaveBeenCalledTimes(1)
    const call = handler.mock.calls[0] as unknown
    if (!Array.isArray(call) || call.length < 2) {
      throw new Error("handler was not called with the expected argv")
    }
    const args = call[0] as Record<string, unknown>
    const ctx = call[1] as {
      pluginId: string
      taskId: string
      executionId: string
      signal: AbortSignal
    }
    expect(args).toEqual({ foo: 1 })
    expect(ctx.pluginId).toBe("p")
    expect(ctx.taskId).toBe("task-1")
    expect(ctx.executionId).toBe("exec-1")
    expect(ctx.signal).toBeInstanceOf(AbortSignal)
  })

  it("captures handler exceptions as a clean failure result", async () => {
    reg.registerPluginTaskHandler("p:err", async () => {
      throw new Error("boom")
    })
    const r = await executePluginTask(
      makeTask({ pluginId: "p", handler: "err" }),
      makeExecution(),
      new AbortController().signal
    )
    expect(r.success).toBe(false)
    expect(r.error).toBe("boom")
  })

  it("removes the executionId from active map after the handler resolves", async () => {
    reg.registerPluginTaskHandler("p:h", async () => ({ success: true }))
    await executePluginTask(
      makeTask({ pluginId: "p", handler: "h" }),
      makeExecution(),
      new AbortController().signal
    )
    expect(getActivePluginTaskCount()).toBe(0)
  })

  it("cancelPluginTaskExecution aborts a running handler via its AbortSignal", async () => {
    let abortFired = false
    reg.registerPluginTaskHandler("p:slow", async (_args, ctx) => {
      // The handler ignores the signal in production code, but here we
      // attach a listener so we can prove cancellation reaches it.
      ctx.signal.addEventListener("abort", () => {
        abortFired = true
      })
      // Yield a microtask so the executor populates `activeExecutions`
      // before we call cancel.
      await Promise.resolve()
      return { success: true }
    })
    const taskPromise = executePluginTask(
      makeTask({ pluginId: "p", handler: "slow" }),
      makeExecution(),
      new AbortController().signal
    )
    // Wait for the executor to register the controller before we cancel.
    await Promise.resolve()
    expect(cancelPluginTaskExecution("exec-1")).toBe(true)
    await taskPromise
    expect(abortFired).toBe(true)
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
