/**
 * Tests for scheduler/executors/plugin-executor: payload validation, handler
 * dispatch, cancellation, and what a handler's run leaves on its execution
 * (progress, log lines, metrics).
 */

jest.mock("@cognia/logging", () => {
  const stub = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
  return { loggers: { app: stub, scheduler: stub, store: stub, plugin: stub } }
})

// The executor persists handler logs mid-run; the database is a spy here so
// the suite can see those writes without a real IndexedDB.
const updateExecution = jest.fn(async (_execution: unknown) => undefined)
jest.mock("../scheduler-db", () => ({
  schedulerDb: { updateExecution: (execution: unknown) => updateExecution(execution) },
}))

import {
  executePluginTask,
  cancelPluginTaskExecution,
  getActivePluginTaskCount,
  isPluginTaskExecutionActive,
  MAX_HANDLER_LOGS,
} from "./plugin-executor"
import {
  PLUGIN_TASK_HANDLER_LOG_KIND,
  PLUGIN_TASK_METRICS_LOG_KIND,
} from "@/types/plugin/plugin-scheduler"
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

  it("records ctx.log lines on the execution, so getExecutions() returns them", async () => {
    // Before, these went only to the host logger and the run's own log never
    // contained a line the handler wrote.
    reg.registerPluginTaskHandler("p:logs", async (_args, ctx) => {
      ctx.log("info", "fetched", { rows: 3 })
      ctx.log("warn", "slow page")
      return { success: true }
    })
    const execution = makeExecution()
    await executePluginTask(
      makeTask({ pluginId: "p", handler: "logs" }),
      execution,
      new AbortController().signal
    )
    const lines = execution.logs.filter(
      (row) => (row.data as { kind?: string } | undefined)?.kind === PLUGIN_TASK_HANDLER_LOG_KIND
    )
    expect(lines.map((row) => [row.level, row.message, row.data])).toEqual([
      ["info", "fetched", { kind: PLUGIN_TASK_HANDLER_LOG_KIND, data: { rows: 3 } }],
      ["warn", "slow page", { kind: PLUGIN_TASK_HANDLER_LOG_KIND }],
    ])
    // Persisted while the run is still going, not only when it settles.
    expect(updateExecution).toHaveBeenCalledWith(execution)
  })

  it("caps the handler's lines without touching the scheduler's own", async () => {
    reg.registerPluginTaskHandler("p:chatty", async (_args, ctx) => {
      for (let index = 0; index < MAX_HANDLER_LOGS + 5; index += 1) {
        ctx.log("debug", `line ${index}`)
      }
      return { success: true }
    })
    const execution = makeExecution()
    execution.logs.push({
      id: "scheduler-line",
      timestamp: new Date(),
      level: "info",
      message: "Starting task execution",
    })
    await executePluginTask(
      makeTask({ pluginId: "p", handler: "chatty" }),
      execution,
      new AbortController().signal
    )
    const handlerLines = execution.logs.filter(
      (row) => (row.data as { kind?: string } | undefined)?.kind === PLUGIN_TASK_HANDLER_LOG_KIND
    )
    expect(handlerLines).toHaveLength(MAX_HANDLER_LOGS)
    // The oldest handler lines went first; the scheduler's own line stayed.
    expect(handlerLines[handlerLines.length - 1].message).toBe(`line ${MAX_HANDLER_LOGS + 4}`)
    expect(execution.logs.some((row) => row.id === "scheduler-line")).toBe(true)
  })

  it("replaces unserializable log data with a marker instead of failing the run", async () => {
    reg.registerPluginTaskHandler("p:cyclic", async (_args, ctx) => {
      const cyclic: Record<string, unknown> = {}
      cyclic.self = cyclic
      ctx.log("info", "cyclic", cyclic)
      return { success: true }
    })
    const execution = makeExecution()
    const r = await executePluginTask(
      makeTask({ pluginId: "p", handler: "cyclic" }),
      execution,
      new AbortController().signal
    )
    expect(r.success).toBe(true)
    expect(execution.logs[0].data).toEqual({
      kind: PLUGIN_TASK_HANDLER_LOG_KIND,
      data: { unserializable: true },
    })
  })

  it("keeps the handler's metrics with the run on a tagged log entry", async () => {
    reg.registerPluginTaskHandler("p:metrics", async () => ({
      success: true,
      output: { done: true },
      metrics: { itemsProcessed: 7 },
    }))
    const execution = makeExecution()
    const r = await executePluginTask(
      makeTask({ pluginId: "p", handler: "metrics" }),
      execution,
      new AbortController().signal
    )
    expect(r.output).toEqual({ done: true })
    expect(execution.logs).toContainEqual(
      expect.objectContaining({
        data: { kind: PLUGIN_TASK_METRICS_LOG_KIND, metrics: { itemsProcessed: 7 } },
      })
    )
  })

  it("hands an event fire's envelope and the trigger source to the handler", async () => {
    const handler = jest.fn(async () => ({ success: true }))
    reg.registerPluginTaskHandler("p:event", handler)
    const execution = { ...makeExecution(), triggerSource: "event" } as TaskExecution
    await executePluginTask(
      makeTask({
        pluginId: "p",
        handler: "event",
        args: { a: 1 },
        event: { type: "sync:done", source: "plugin:p", data: { n: 2 } },
      }),
      execution,
      new AbortController().signal
    )
    const [args, ctx] = handler.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { event?: unknown; triggerSource?: string },
    ]
    expect(args).toEqual({ a: 1 })
    expect(ctx.event).toEqual({ type: "sync:done", source: "plugin:p", data: { n: 2 } })
    expect(ctx.triggerSource).toBe("event")
  })

  it("gives a non-event run no event", async () => {
    const handler = jest.fn(async () => ({ success: true }))
    reg.registerPluginTaskHandler("p:plain", handler)
    await executePluginTask(
      makeTask({ pluginId: "p", handler: "plain" }),
      makeExecution(),
      new AbortController().signal
    )
    const ctx = (handler.mock.calls[0] as unknown as [unknown, { event?: unknown }])[1]
    expect(ctx.event).toBeUndefined()
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
