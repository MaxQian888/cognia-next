/**
 * @jest-environment jsdom
 *
 * Tests for scheduler/executors/index — the executor registry that wires
 * built-in chat/agent/skill/script/plugin/backup/custom handlers into the
 * task scheduler.
 */

let isTauriValue = true
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriValue,
}))

const sendPromptMock = jest.fn(async (..._args: unknown[]) => undefined)
const onClaudeMessageMock = jest.fn()
jest.mock("@/lib/claude/ipc", () => ({
  sendPrompt: (sessionId: string, prompt: string) => sendPromptMock(sessionId, prompt),
  onClaudeMessage: (cb: (evt: unknown) => void) => onClaudeMessageMock(cb),
}))

const createSessionMock = jest.fn(async (input: unknown) => ({
  id: "session-created",
  ...((input as Record<string, unknown>) ?? {}),
}))
jest.mock("@/lib/db/sessions", () => ({
  createSession: (input: unknown) => createSessionMock(input),
}))

const executeScriptMock = jest.fn()
jest.mock("../script-executor", () => ({
  executeScript: (action: unknown) => executeScriptMock(action),
}))

const executePluginTaskMock = jest.fn(async (..._args: unknown[]) => ({
  success: false,
  error: "no runtime",
}))
jest.mock("./plugin-executor", () => ({
  executePluginTask: (...args: unknown[]) => executePluginTaskMock(...args),
}))

const executeBackupTaskMock = jest.fn(async (..._args: unknown[]) => ({ success: true }))
jest.mock("./backup-executor", () => ({
  executeBackupTask: (...args: unknown[]) => executeBackupTaskMock(...args),
}))

const registerTaskExecutorMock = jest.fn()
jest.mock("../task-scheduler", () => ({
  registerTaskExecutor: (...args: unknown[]) => registerTaskExecutorMock(...args),
}))

jest.mock("@/lib/logger", () => {
  const stub = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
  return { loggers: { app: stub, scheduler: stub, store: stub, plugin: stub } }
})

import {
  registerBuiltInExecutors,
  executeChatTask,
  executeAgentTask,
  executeSkillTask,
  executeScriptTask,
  executePluginTask,
  executeBackupTask,
  executeCustomTask,
} from "./index"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"

beforeEach(() => {
  isTauriValue = true
  sendPromptMock.mockClear()
  onClaudeMessageMock.mockReset()
  createSessionMock.mockClear()
  executeScriptMock.mockReset()
  executePluginTaskMock.mockClear()
  executeBackupTaskMock.mockClear()
  registerTaskExecutorMock.mockClear()
})

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    name: "Test",
    type: "chat",
    trigger: { type: "cron", cronExpression: "0 0 * * *" },
    payload: undefined,
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
    ...overrides,
  } as unknown as ScheduledTask
}

function makeExecution(): TaskExecution {
  return {
    id: "exec-1",
    taskId: "task-1",
    taskName: "Test",
    taskType: "chat",
    status: "running",
    retryAttempt: 0,
    startedAt: new Date(),
    logs: [],
  } as unknown as TaskExecution
}

describe("registerBuiltInExecutors", () => {
  it("registers all seven executor types and is idempotent", () => {
    registerBuiltInExecutors()
    const types = registerTaskExecutorMock.mock.calls.map((c) => c[0])
    expect(types).toEqual(
      expect.arrayContaining(["chat", "agent", "skill", "script", "plugin", "backup", "custom"])
    )
    const firstCount = registerTaskExecutorMock.mock.calls.length

    // Calling again should be a no-op.
    registerBuiltInExecutors()
    expect(registerTaskExecutorMock.mock.calls.length).toBe(firstCount)
  })
})

describe("executeChatTask", () => {
  it("rejects missing prompt", async () => {
    const r = await executeChatTask(makeTask({ payload: {} }), makeExecution())
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/prompt/)
  })

  it("rejects undefined payload", async () => {
    const r = await executeChatTask(makeTask({ payload: undefined }), makeExecution())
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/prompt/)
  })

  it("rejects when prompt is whitespace", async () => {
    const r = await executeChatTask(makeTask({ payload: { prompt: "   " } }), makeExecution())
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/Empty prompt/)
  })

  it("returns runtime error when not running under Tauri", async () => {
    isTauriValue = false
    const r = await executeChatTask(makeTask({ payload: { prompt: "hi" } }), makeExecution())
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/Tauri runtime/)
  })

  it("subscribes, sends, and resolves on a result event", async () => {
    let captured: ((evt: unknown) => void) | null = null
    const unlisten = jest.fn()
    onClaudeMessageMock.mockImplementationOnce(async (cb) => {
      captured = cb as (evt: unknown) => void
      // Simulate the sidecar emitting a result event after the listener
      // attaches but before the wait resolves.
      setTimeout(() => captured?.({ sessionId: "session-created", type: "result" }), 0)
      return unlisten
    })

    const r = await executeChatTask(makeTask({ payload: { prompt: "hello" } }), makeExecution())

    expect(sendPromptMock).toHaveBeenCalledWith("session-created", "hello")
    expect(r.success).toBe(true)
    expect(r.output).toMatchObject({ sessionId: "session-created" })
    expect(unlisten).toHaveBeenCalled()
  })

  it("reuses an existing sessionId without creating a new one", async () => {
    let captured: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb) => {
      captured = cb as (evt: unknown) => void
      setTimeout(() => captured?.({ sessionId: "reuse-session", type: "result" }), 0)
      return () => undefined
    })

    await executeChatTask(
      makeTask({ payload: { prompt: "hi", sessionId: "reuse-session" } }),
      makeExecution()
    )

    expect(createSessionMock).not.toHaveBeenCalled()
    expect(sendPromptMock).toHaveBeenCalledWith("reuse-session", "hi")
  })

  it("translates an `error` event into a failure result", async () => {
    onClaudeMessageMock.mockImplementationOnce(async (cb) => {
      setTimeout(
        () =>
          (cb as (e: unknown) => void)({
            sessionId: "session-created",
            type: "error",
            error: "sidecar exploded",
          }),
        0
      )
      return () => undefined
    })
    const r = await executeChatTask(makeTask({ payload: { prompt: "hi" } }), makeExecution())
    expect(r.success).toBe(false)
    expect(r.error).toBe("sidecar exploded")
  })

  it("uses default error message when an `error` event has no error field", async () => {
    onClaudeMessageMock.mockImplementationOnce(async (cb) => {
      setTimeout(
        () => (cb as (e: unknown) => void)({ sessionId: "session-created", type: "error" }),
        0
      )
      return () => undefined
    })
    const r = await executeChatTask(makeTask({ payload: { prompt: "hi" } }), makeExecution())
    expect(r.success).toBe(false)
    expect(r.error).toBe("Sidecar error")
  })

  it("ignores events for unrelated sessions", async () => {
    onClaudeMessageMock.mockImplementationOnce(async (cb) => {
      const cast = cb as (e: unknown) => void
      // First emit an event from a different session — must be ignored.
      setTimeout(() => cast({ sessionId: "other", type: "result" }), 0)
      // Then emit the matching one.
      setTimeout(() => cast({ sessionId: "session-created", type: "result" }), 5)
      return () => undefined
    })
    const r = await executeChatTask(makeTask({ payload: { prompt: "hi" } }), makeExecution())
    expect(r.success).toBe(true)
  })

  it("rejects via timeout when no terminal event arrives", async () => {
    jest.useFakeTimers()
    try {
      onClaudeMessageMock.mockImplementationOnce(async () => () => undefined)
      const promise = executeChatTask(
        makeTask({
          config: {
            timeout: 50,
            maxRetries: 0,
            retryDelay: 1000,
            runMissedOnStartup: false,
            maxMissedRuns: 1,
            allowConcurrent: false,
          },
          payload: { prompt: "hi" },
        }),
        makeExecution()
      )
      // Drain microtasks created by createSession + onClaudeMessage.
      await Promise.resolve()
      await Promise.resolve()
      jest.advanceTimersByTime(60)
      const r = await promise
      expect(r.success).toBe(false)
      expect(r.error).toMatch(/exceeded timeout/)
    } finally {
      jest.useRealTimers()
    }
  })

  it("uses default 300_000ms timeout when task config.timeout is 0", async () => {
    onClaudeMessageMock.mockImplementationOnce(async (cb) => {
      setTimeout(
        () => (cb as (e: unknown) => void)({ sessionId: "session-created", type: "result" }),
        0
      )
      return () => undefined
    })
    const r = await executeChatTask(
      makeTask({
        config: {
          timeout: 0,
          maxRetries: 0,
          retryDelay: 1000,
          runMissedOnStartup: false,
          maxMissedRuns: 1,
          allowConcurrent: false,
        },
        payload: { prompt: "hi" },
      }),
      makeExecution()
    )
    expect(r.success).toBe(true)
  })

  it("catches errors thrown by sendPrompt", async () => {
    onClaudeMessageMock.mockImplementationOnce(async () => () => undefined)
    sendPromptMock.mockRejectedValueOnce(new Error("send failed"))
    const r = await executeChatTask(makeTask({ payload: { prompt: "hi" } }), makeExecution())
    expect(r.success).toBe(false)
    expect(r.error).toBe("send failed")
  })

  it("coerces non-Error sendPrompt failures", async () => {
    onClaudeMessageMock.mockImplementationOnce(async () => () => undefined)
    sendPromptMock.mockRejectedValueOnce("string error")
    const r = await executeChatTask(makeTask({ payload: { prompt: "hi" } }), makeExecution())
    expect(r.error).toBe("string error")
  })

  it("tolerates unlisten throwing in finally", async () => {
    const unlisten = jest.fn(() => {
      throw new Error("detach failed")
    })
    onClaudeMessageMock.mockImplementationOnce(async (cb) => {
      setTimeout(
        () => (cb as (e: unknown) => void)({ sessionId: "session-created", type: "result" }),
        0
      )
      return unlisten
    })
    const r = await executeChatTask(makeTask({ payload: { prompt: "hi" } }), makeExecution())
    expect(r.success).toBe(true)
  })
})

describe("executeAgentTask", () => {
  it("rejects without prompt or characterId", async () => {
    expect((await executeAgentTask(makeTask({ payload: {} }), makeExecution())).error).toMatch(
      /prompt/
    )
    expect(
      (await executeAgentTask(makeTask({ payload: { prompt: "hi" } }), makeExecution())).error
    ).toMatch(/characterId/)
  })

  it("rejects undefined payload", async () => {
    const r = await executeAgentTask(makeTask({ payload: undefined }), makeExecution())
    expect(r.success).toBe(false)
  })

  it("passes characterId through to runChatPrompt", async () => {
    onClaudeMessageMock.mockImplementationOnce(async (cb) => {
      setTimeout(
        () => (cb as (e: unknown) => void)({ sessionId: "session-created", type: "result" }),
        0
      )
      return () => undefined
    })
    const r = await executeAgentTask(
      makeTask({
        payload: { prompt: "hi", characterId: "char-1" },
      }),
      makeExecution()
    )
    expect(r.success).toBe(true)
    expect(createSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ characterId: "char-1" })
    )
  })
})

describe("executeSkillTask", () => {
  it("rejects without prompt or skillId", async () => {
    expect((await executeSkillTask(makeTask({ payload: {} }), makeExecution())).error).toMatch(
      /prompt/
    )
    expect(
      (await executeSkillTask(makeTask({ payload: { prompt: "hi" } }), makeExecution())).error
    ).toMatch(/skillId/)
  })

  it("rejects undefined payload", async () => {
    const r = await executeSkillTask(makeTask({ payload: undefined }), makeExecution())
    expect(r.success).toBe(false)
  })

  it("runs successfully when skillId is provided", async () => {
    onClaudeMessageMock.mockImplementationOnce(async (cb) => {
      setTimeout(
        () => (cb as (e: unknown) => void)({ sessionId: "session-created", type: "result" }),
        0
      )
      return () => undefined
    })
    const r = await executeSkillTask(
      makeTask({ payload: { prompt: "hi", skillId: "skill-1" } }),
      makeExecution()
    )
    expect(r.success).toBe(true)
  })
})

describe("executeScriptTask", () => {
  it("rejects without language and code", async () => {
    const r = await executeScriptTask(makeTask({ payload: {} }), makeExecution())
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/language.*code/)
  })

  it("rejects when payload is undefined", async () => {
    const r = await executeScriptTask(makeTask({ payload: undefined }), makeExecution())
    expect(r.success).toBe(false)
  })

  it("forwards payload through executeScript and reflects success", async () => {
    executeScriptMock.mockResolvedValueOnce({
      success: true,
      exit_code: 0,
      stdout: "ok",
      stderr: "",
      duration_ms: 12,
    })
    const r = await executeScriptTask(
      makeTask({
        payload: {
          language: "bash",
          code: "echo hi",
        },
      }),
      makeExecution()
    )
    expect(r.success).toBe(true)
    expect(r.output).toMatchObject({ stdout: "ok" })
  })

  it("reflects errors from executeScript", async () => {
    executeScriptMock.mockResolvedValueOnce({
      success: false,
      error: "boom",
      exit_code: 1,
      stdout: "",
      stderr: "fail",
      duration_ms: 1,
    })
    const r = await executeScriptTask(
      makeTask({
        payload: { language: "bash", code: "exit 1" },
      }),
      makeExecution()
    )
    expect(r.success).toBe(false)
    expect(r.error).toBe("boom")
  })

  it("falls back to task.config.timeout when payload omits timeout_secs", async () => {
    executeScriptMock.mockResolvedValueOnce({ success: true })
    await executeScriptTask(
      makeTask({
        payload: { language: "bash", code: "echo" },
      }),
      makeExecution()
    )
    const action = executeScriptMock.mock.calls[0]?.[0] as { timeout_secs: number }
    // 300_000ms default → 300 seconds.
    expect(action.timeout_secs).toBe(300)
  })

  it("respects payload.timeout_secs when provided", async () => {
    executeScriptMock.mockResolvedValueOnce({ success: true })
    await executeScriptTask(
      makeTask({
        payload: { language: "bash", code: "echo", timeout_secs: 60 },
      }),
      makeExecution()
    )
    const action = executeScriptMock.mock.calls[0]?.[0] as { timeout_secs: number }
    expect(action.timeout_secs).toBe(60)
  })

  it("falls back to 300_000ms default when task.config.timeout is 0", async () => {
    executeScriptMock.mockResolvedValueOnce({ success: true })
    await executeScriptTask(
      makeTask({
        payload: { language: "bash", code: "echo" },
        config: {
          timeout: 0,
          maxRetries: 0,
          retryDelay: 1000,
          runMissedOnStartup: false,
          maxMissedRuns: 1,
          allowConcurrent: false,
        },
      }),
      makeExecution()
    )
    const action = executeScriptMock.mock.calls[0]?.[0] as { timeout_secs: number }
    expect(action.timeout_secs).toBe(300)
  })
})

describe("executeCustomTask", () => {
  it("returns a friendly no-op success result", async () => {
    const r = await executeCustomTask(makeTask({}))
    expect(r.success).toBe(true)
    expect(r.output).toMatchObject({ note: expect.stringMatching(/Custom executor/) })
  })
})

describe("re-exports", () => {
  it("exports executeBackupTask and executePluginTask as references", async () => {
    expect(typeof executeBackupTask).toBe("function")
    expect(typeof executePluginTask).toBe("function")
    await executeBackupTask(makeTask({}), makeExecution())
    expect(executeBackupTaskMock).toHaveBeenCalled()
    await executePluginTask(makeTask({}), makeExecution())
    expect(executePluginTaskMock).toHaveBeenCalled()
  })
})
