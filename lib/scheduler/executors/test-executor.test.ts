import type { ScheduledTask, TaskExecution } from "@/types/scheduler"
import { executeTestTask, TEST_TASK_MAX_DELAY_MS } from "./test-executor"

jest.mock("@cognia/logging", () => {
  const stub = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
  return { loggers: { scheduler: stub }, createLogger: () => stub }
})

function makeTask(payload: Record<string, unknown> | undefined): ScheduledTask {
  return {
    id: "task-test",
    name: "Diagnostic",
    type: "test",
    trigger: { type: "interval", intervalMs: 60_000 },
    payload,
    config: { maxRetries: 0, retryDelay: 1000, timeout: 30_000, runMissedOnStartup: false },
    notification: { onStart: false, onComplete: true, onError: true },
    status: "active",
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

function makeExecution(overrides: Partial<TaskExecution> = {}): TaskExecution {
  return {
    id: "exec-1",
    taskId: "task-test",
    taskName: "Diagnostic",
    taskType: "test",
    status: "running",
    retryAttempt: 0,
    startedAt: new Date(),
    logs: [],
    triggerSource: "run-now",
    scheduledFor: new Date("2026-08-16T08:00:00Z"),
    ...overrides,
  }
}

describe("executeTestTask", () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it("echoes the payload and reports host + trigger context", async () => {
    const r = await executeTestTask(
      makeTask({ echo: { hello: "world" } }),
      makeExecution(),
      new AbortController().signal
    )
    expect(r.success).toBe(true)
    expect(r.output).toMatchObject({
      echo: { hello: "world" },
      delayMs: 0,
      platform: "web",
      triggerSource: "run-now",
      scheduledFor: "2026-08-16T08:00:00.000Z",
    })
    expect(typeof (r.output as { firedAt: string }).firedAt).toBe("string")
  })

  it("defaults echo to null and tolerates a missing payload", async () => {
    const r = await executeTestTask(
      makeTask(undefined),
      makeExecution({ triggerSource: undefined, scheduledFor: undefined }),
      new AbortController().signal
    )
    expect(r.success).toBe(true)
    expect(r.output).toMatchObject({ echo: null, triggerSource: null, scheduledFor: null })
  })

  it("sleeps for delayMs (capped) before completing", async () => {
    const pending = executeTestTask(
      makeTask({ delayMs: 2_000 }),
      makeExecution(),
      new AbortController().signal
    )
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await jest.advanceTimersByTimeAsync(1_999)
    expect(settled).toBe(false)
    await jest.advanceTimersByTimeAsync(1)
    const r = await pending
    expect(settled).toBe(true)
    expect(r.output).toMatchObject({ delayMs: 2_000 })

    const capped = executeTestTask(
      makeTask({ delayMs: TEST_TASK_MAX_DELAY_MS * 10 }),
      makeExecution(),
      new AbortController().signal
    )
    await jest.advanceTimersByTimeAsync(TEST_TASK_MAX_DELAY_MS)
    expect((await capped).output).toMatchObject({ delayMs: TEST_TASK_MAX_DELAY_MS })
  })

  it("ignores non-numeric / negative delays", async () => {
    const r = await executeTestTask(
      makeTask({ delayMs: -5 }),
      makeExecution(),
      new AbortController().signal
    )
    expect(r.output).toMatchObject({ delayMs: 0 })
    const r2 = await executeTestTask(
      makeTask({ delayMs: "soon" }),
      makeExecution(),
      new AbortController().signal
    )
    expect(r2.output).toMatchObject({ delayMs: 0 })
  })

  it("fails on request via failWith while still returning the echo output", async () => {
    const r = await executeTestTask(
      makeTask({ echo: 1, failWith: "boom" }),
      makeExecution(),
      new AbortController().signal
    )
    expect(r.success).toBe(false)
    expect(r.error).toBe("boom")
    expect(r.output).toMatchObject({ echo: 1 })
    const blank = await executeTestTask(
      makeTask({ failWith: "   " }),
      makeExecution(),
      new AbortController().signal
    )
    expect(blank.success).toBe(true)
  })

  it("aborts cleanly before start and while sleeping", async () => {
    const pre = new AbortController()
    pre.abort()
    const r = await executeTestTask(makeTask({}), makeExecution(), pre.signal)
    expect(r).toEqual({ success: false, error: "Test task aborted before start" })

    const mid = new AbortController()
    const pending = executeTestTask(makeTask({ delayMs: 5_000 }), makeExecution(), mid.signal)
    await jest.advanceTimersByTimeAsync(10)
    mid.abort()
    const r2 = await pending
    expect(r2.success).toBe(false)
    expect(r2.error).toMatch(/cancelled/)
  })
})
