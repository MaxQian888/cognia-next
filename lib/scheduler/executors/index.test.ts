/**
 * @jest-environment jsdom
 *
 * Tests for scheduler/executors/index — the executor registry that wires
 * built-in chat/agent/skill/external-agent/script/plugin/backup/custom
 * handlers into the task scheduler. The chat-style runner is the bulk of the
 * surface here: it plumbs the same `resolveSendOptions` pipeline that the
 * interactive composer uses, then layers payload-level overrides on top
 * before handing off to `lib/claude/ipc.sendPrompt`.
 */

let isTauriValue = true
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriValue,
}))

const sendPromptMock = jest.fn(async (..._args: unknown[]) => undefined)
const onClaudeMessageMock = jest.fn()
const interruptSessionMock = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/claude/ipc", () => ({
  sendPrompt: (sessionId: string, prompt: string, options?: unknown) =>
    sendPromptMock(sessionId, prompt, options),
  onClaudeMessage: (cb: (evt: unknown) => void) => onClaudeMessageMock(cb),
  interruptSession: (...args: unknown[]) => interruptSessionMock(...args),
}))

const createSessionMock = jest.fn(async (input: unknown) => ({
  id: "session-created",
  ...((input as Record<string, unknown>) ?? {}),
}))
const getSessionMock = jest.fn(async (_id: string) => undefined as unknown)
jest.mock("@/lib/db/sessions", () => ({
  createSession: (input: unknown) => createSessionMock(input),
  getSession: (id: string) => getSessionMock(id),
}))

const getSettingsMock = jest.fn(async () => ({
  id: "singleton",
  alwaysAllowTools: [],
  builtinTools: {
    fileExtras: true,
    git: true,
    process: false,
    environment: true,
    shellAdvanced: false,
  },
}))
jest.mock("@/lib/db/settings", () => ({
  getSettings: () => getSettingsMock(),
}))

const listEnabledMcpServersMock = jest.fn(async () => [] as unknown[])
const buildMcpServerMapMock = jest.fn(
  (rows: Array<{ id: string }>) =>
    Object.fromEntries(rows.map((r) => [r.id, { id: r.id }])) as Record<string, { id: string }>
)
jest.mock("@/lib/db/mcp-servers", () => ({
  listEnabledMcpServers: () => listEnabledMcpServersMock(),
  buildMcpServerMap: (rows: Array<{ id: string }>) => buildMcpServerMapMock(rows),
}))

const listEnabledSkillsByIdsMock = jest.fn(async (_ids: string[]) => [] as unknown[])
const renderSkillsSectionMock = jest.fn((skills: Array<{ id: string }>) =>
  skills.length > 0 ? `# Skills\n${skills.map((s) => `- ${s.id}`).join("\n")}` : ""
)
jest.mock("@/lib/db/skills", () => ({
  listEnabledSkillsByIds: (ids: string[]) => listEnabledSkillsByIdsMock(ids),
  renderSkillsSection: (skills: Array<{ id: string }>) => renderSkillsSectionMock(skills),
}))

const resolveSendOptionsMock = jest.fn(async (_ctx: unknown) => ({}) as Record<string, unknown>)
jest.mock("@/lib/claude/build-options", () => ({
  resolveSendOptions: (ctx: unknown) => resolveSendOptionsMock(ctx),
}))

const customModeStoreState = {
  customModes: {} as Record<string, { id: string; name: string }>,
}
jest.mock("@/stores/agent/custom-mode-store", () => ({
  useCustomModeStore: { getState: () => customModeStoreState },
}))

jest.mock("@/types/agent/agent-mode", () => ({
  BUILT_IN_AGENT_MODES: [
    { id: "general", name: "General", systemPrompt: "be helpful", tools: [] },
    { id: "code-gen", name: "Code Generator", systemPrompt: "code", tools: ["Bash"] },
  ],
}))

const executeOnExternalAgentMock = jest.fn(async (..._args: unknown[]) => null as unknown)
jest.mock("@/lib/ai/agent/external/manager", () => ({
  executeOnExternalAgent: (prompt: string, opts: unknown) =>
    executeOnExternalAgentMock(prompt, opts),
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
  const stub: Record<string, unknown> = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }
  stub.child = () => stub
  return {
    loggers: {
      app: stub,
      ai: stub,
      chat: stub,
      agent: stub,
      mcp: stub,
      plugin: stub,
      native: stub,
      ui: stub,
      store: stub,
      scheduler: stub,
      data: stub,
      tauri: stub,
      sidecar: stub,
      a2ui: stub,
      canvas: stub,
      tts: stub,
      auth: stub,
      api: stub,
      config: stub,
      backup: stub,
      session: stub,
      router: stub,
      external: stub,
    },
  }
})

import {
  registerBuiltInExecutors,
  executeChatTask,
  executeAgentTask,
  executeSkillTask,
  executeScriptTask,
  executeExternalAgentTask,
  executePluginTask,
  executeBackupTask,
  executeCustomTask,
  reconcileLegacyPromptFields,
  resolveAgentMode,
  applyPayloadOverrides,
  applyAdHocSkill,
} from "./index"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"
import type { SendOptions } from "@/lib/claude/types"

beforeEach(() => {
  isTauriValue = true
  sendPromptMock.mockClear()
  onClaudeMessageMock.mockReset()
  interruptSessionMock.mockClear()
  createSessionMock.mockClear()
  getSessionMock.mockReset()
  getSessionMock.mockResolvedValue(undefined)
  getSettingsMock.mockClear()
  listEnabledMcpServersMock.mockReset()
  listEnabledMcpServersMock.mockResolvedValue([])
  buildMcpServerMapMock.mockClear()
  listEnabledSkillsByIdsMock.mockReset()
  listEnabledSkillsByIdsMock.mockResolvedValue([])
  renderSkillsSectionMock.mockClear()
  resolveSendOptionsMock.mockReset()
  resolveSendOptionsMock.mockResolvedValue({})
  executeScriptMock.mockReset()
  executePluginTaskMock.mockClear()
  executeBackupTaskMock.mockClear()
  registerTaskExecutorMock.mockClear()
  executeOnExternalAgentMock.mockReset()
  executeOnExternalAgentMock.mockResolvedValue(null)
  customModeStoreState.customModes = {}
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

function makeSignal() {
  return new AbortController().signal
}

function emitTerminalResult(sessionId = "session-created") {
  onClaudeMessageMock.mockImplementationOnce(async (cb) => {
    setTimeout(() => (cb as (e: unknown) => void)({ sessionId, type: "result" }), 0)
    return () => undefined
  })
}

describe("registerBuiltInExecutors", () => {
  it("registers all eight executor types and is idempotent", () => {
    registerBuiltInExecutors()
    const types = registerTaskExecutorMock.mock.calls.map((c) => c[0])
    expect(types).toEqual(
      expect.arrayContaining([
        "chat",
        "agent",
        "skill",
        "script",
        "plugin",
        "backup",
        "custom",
        "external-agent",
      ])
    )
    const firstCount = registerTaskExecutorMock.mock.calls.length
    registerBuiltInExecutors()
    expect(registerTaskExecutorMock.mock.calls.length).toBe(firstCount)
  })
})

describe("reconcileLegacyPromptFields", () => {
  it("rewrites payload.message → payload.prompt", () => {
    const out = reconcileLegacyPromptFields("t", { message: "hi" })
    expect(out.prompt).toBe("hi")
    expect(out.message).toBeUndefined()
  })
  it("rewrites payload.agentTask → payload.prompt", () => {
    const out = reconcileLegacyPromptFields("t", { agentTask: "do work" })
    expect(out.prompt).toBe("do work")
    expect(out.agentTask).toBeUndefined()
  })
  it("hoists nested config.{model,maxSteps}", () => {
    const out = reconcileLegacyPromptFields("t", {
      prompt: "hi",
      config: { model: "claude-x", maxSteps: 7 },
    })
    expect(out.model).toBe("claude-x")
    expect(out.maxTurns).toBe(7)
    expect(out.config).toBeUndefined()
  })
  it("does not overwrite an explicit prompt with a legacy field", () => {
    const out = reconcileLegacyPromptFields("t", { prompt: "real", message: "old" })
    expect(out.prompt).toBe("real")
  })
  it("handles whitespace-only legacy fields", () => {
    const out = reconcileLegacyPromptFields("t", { message: "   " })
    expect(out.prompt).toBeUndefined()
  })
})

describe("resolveAgentMode", () => {
  it("returns undefined when no id is given", () => {
    expect(resolveAgentMode("t", undefined)).toBeUndefined()
  })
  it("passes null through as explicit opt-out", () => {
    expect(resolveAgentMode("t", null)).toBeNull()
  })
  it("resolves a built-in mode", () => {
    expect(resolveAgentMode("t", "general")).toMatchObject({ id: "general" })
  })
  it("falls back to a custom mode in the store", () => {
    customModeStoreState.customModes = { myMode: { id: "myMode", name: "My Mode" } }
    expect(resolveAgentMode("t", "myMode")).toMatchObject({ id: "myMode" })
  })
  it("returns null for an unknown id", () => {
    expect(resolveAgentMode("t", "nope")).toBeNull()
  })
})

describe("applyPayloadOverrides", () => {
  it("assigns model / permissionMode / maxTurns / effort", async () => {
    const out = await applyPayloadOverrides(
      {},
      { prompt: "p", model: "m", permissionMode: "plan", maxTurns: 5, effort: "high" },
      null
    )
    expect(out).toMatchObject({
      model: "m",
      permissionMode: "plan",
      maxTurns: 5,
      effort: "high",
    })
  })
  it("appends to existing appendSystemPrompt", async () => {
    const out = await applyPayloadOverrides(
      { appendSystemPrompt: "base" },
      { prompt: "p", appendSystemPrompt: "extra" },
      null
    )
    expect(out.appendSystemPrompt).toBe("base\n\nextra")
  })
  it("uses payload appendSystemPrompt verbatim when base is empty", async () => {
    const out = await applyPayloadOverrides({}, { prompt: "p", appendSystemPrompt: "extra" }, null)
    expect(out.appendSystemPrompt).toBe("extra")
  })
  it("unions allowedTools", async () => {
    const out = await applyPayloadOverrides(
      { allowedTools: ["Read", "Write"] },
      { prompt: "p", allowedTools: ["Bash", "Read"] },
      null
    )
    expect(out.allowedTools).toEqual(expect.arrayContaining(["Read", "Write", "Bash"]))
    expect(out.allowedTools).toHaveLength(3)
  })
  it("unions additionalDirectories", async () => {
    const out = await applyPayloadOverrides(
      { additionalDirectories: ["/a"] },
      { prompt: "p", additionalDirectories: ["/b", "/a"] },
      null
    )
    expect(out.additionalDirectories).toHaveLength(2)
  })
  it("replaces disallowedTools", async () => {
    const out = await applyPayloadOverrides(
      { disallowedTools: ["Old"] },
      { prompt: "p", disallowedTools: ["New"] },
      null
    )
    expect(out.disallowedTools).toEqual(["New"])
  })
  it("resolves payload.mcpServerIds against enabled servers", async () => {
    listEnabledMcpServersMock.mockResolvedValueOnce([
      { id: "a", enabled: true },
      { id: "b", enabled: true },
    ])
    const out = await applyPayloadOverrides({}, { prompt: "p", mcpServerIds: ["a"] }, null)
    expect(out.mcpServers).toMatchObject({ a: { id: "a" } })
  })
  it("strips mcpServers when payload requests an empty subset", async () => {
    listEnabledMcpServersMock.mockResolvedValueOnce([{ id: "a", enabled: true }])
    const out = await applyPayloadOverrides(
      { mcpServers: { x: {} } },
      { prompt: "p", mcpServerIds: [] },
      null
    )
    expect(out.mcpServers).toBeUndefined()
  })
  it("survives listEnabledMcpServers failure", async () => {
    listEnabledMcpServersMock.mockRejectedValueOnce(new Error("boom"))
    const out = await applyPayloadOverrides(
      { mcpServers: { x: {} } },
      { prompt: "p", mcpServerIds: ["a"] },
      null
    )
    expect(out).toBeDefined()
  })
  it("shallow-merges builtinTools over the resolved AppSettings", async () => {
    const out = await applyPayloadOverrides({}, { prompt: "p", builtinTools: { git: false } }, {
      id: "singleton",
      alwaysAllowTools: [],
      builtinTools: {
        fileExtras: true,
        git: true,
        process: false,
        environment: true,
        shellAdvanced: false,
      },
    } as unknown as Parameters<typeof applyPayloadOverrides>[2])
    expect(out.builtinTools).toMatchObject({
      fileExtras: true,
      git: false,
      environment: true,
    })
  })
})

describe("applyAdHocSkill", () => {
  it("is a no-op when no skillId is given", async () => {
    const out = await applyAdHocSkill({}, undefined)
    expect(out).toEqual({})
  })
  it("is a no-op when the skill is not found", async () => {
    listEnabledSkillsByIdsMock.mockResolvedValueOnce([])
    const out = await applyAdHocSkill({}, "missing")
    expect(out).toEqual({})
  })
  it("appends the skill section and unions allowedTools", async () => {
    listEnabledSkillsByIdsMock.mockResolvedValueOnce([{ id: "s1", allowedTools: ["TodoWrite"] }])
    renderSkillsSectionMock.mockReturnValueOnce("SKILL_SECTION")
    const out = await applyAdHocSkill({ systemPrompt: "base", allowedTools: ["Read"] }, "s1")
    expect(out.systemPrompt).toContain("base")
    expect(out.systemPrompt).toContain("SKILL_SECTION")
    expect(out.allowedTools).toEqual(expect.arrayContaining(["Read", "TodoWrite"]))
  })
  it("uses skill section verbatim when base systemPrompt is absent", async () => {
    listEnabledSkillsByIdsMock.mockResolvedValueOnce([{ id: "s1" }])
    renderSkillsSectionMock.mockReturnValueOnce("SKILL")
    const out = await applyAdHocSkill({}, "s1")
    expect(out.systemPrompt).toBe("SKILL")
  })
})

describe("executeChatTask", () => {
  it("rejects missing prompt", async () => {
    const r = await executeChatTask(makeTask({ payload: {} }), makeExecution(), makeSignal())
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/prompt/)
  })
  it("rejects undefined payload", async () => {
    const r = await executeChatTask(makeTask({ payload: undefined }), makeExecution(), makeSignal())
    expect(r.success).toBe(false)
  })
  it("returns runtime error when not running under Tauri", async () => {
    isTauriValue = false
    const r = await executeChatTask(
      makeTask({ payload: { prompt: "hi" } }),
      makeExecution(),
      makeSignal()
    )
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/Tauri runtime/)
  })
  it("rejects whitespace-only prompt", async () => {
    const r = await executeChatTask(
      makeTask({ payload: { prompt: "   " } }),
      makeExecution(),
      makeSignal()
    )
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/Empty prompt/)
  })
  it("invokes resolveSendOptions and forwards merged SendOptions", async () => {
    emitTerminalResult()
    const r = await executeChatTask(
      makeTask({ payload: { prompt: "hello", model: "m" } }),
      makeExecution(),
      makeSignal()
    )
    expect(resolveSendOptionsMock).toHaveBeenCalled()
    expect(sendPromptMock).toHaveBeenCalled()
    const [sId, prompt, options] = sendPromptMock.mock.calls[0] as [string, string, SendOptions]
    expect(sId).toBe("session-created")
    expect(prompt).toBe("hello")
    expect(options.model).toBe("m")
    expect(r.success).toBe(true)
  })
  it("reuses an existing sessionId when getSession returns a row", async () => {
    getSessionMock.mockResolvedValueOnce({ id: "reuse", title: "x" })
    emitTerminalResult("reuse")
    const r = await executeChatTask(
      makeTask({ payload: { prompt: "hi", sessionId: "reuse" } }),
      makeExecution(),
      makeSignal()
    )
    expect(createSessionMock).not.toHaveBeenCalled()
    expect(r.success).toBe(true)
  })
  it("returns an error when sessionId is set but session is missing", async () => {
    getSessionMock.mockResolvedValueOnce(undefined)
    const r = await executeChatTask(
      makeTask({ payload: { prompt: "hi", sessionId: "missing" } }),
      makeExecution(),
      makeSignal()
    )
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/Session not found/)
  })
  it("creates a team session when payload.teamId is set", async () => {
    emitTerminalResult()
    await executeChatTask(
      makeTask({ payload: { prompt: "hi", teamId: "team-1" } }),
      makeExecution(),
      makeSignal()
    )
    expect(createSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "team", teamId: "team-1" })
    )
  })
  it("layers payload.allowedTools on top of resolved allowedTools", async () => {
    resolveSendOptionsMock.mockResolvedValueOnce({ allowedTools: ["Read"] } as Record<
      string,
      unknown
    >)
    emitTerminalResult()
    await executeChatTask(
      makeTask({ payload: { prompt: "hi", allowedTools: ["Bash", "Read"] } }),
      makeExecution(),
      makeSignal()
    )
    const options = sendPromptMock.mock.calls[0]?.[2] as SendOptions
    expect(options.allowedTools).toEqual(expect.arrayContaining(["Read", "Bash"]))
    expect(options.allowedTools).toHaveLength(2)
  })
  it("propagates payload.disabledSkillIds into resolveSendOptions ctx", async () => {
    emitTerminalResult()
    await executeChatTask(
      makeTask({ payload: { prompt: "hi", disabledSkillIds: ["s2"] } }),
      makeExecution(),
      makeSignal()
    )
    const ctx = resolveSendOptionsMock.mock.calls[0]?.[0] as {
      session?: { disabledSkillIds?: string[] }
    }
    expect(ctx?.session?.disabledSkillIds).toEqual(expect.arrayContaining(["s2"]))
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
    const r = await executeChatTask(
      makeTask({ payload: { prompt: "hi" } }),
      makeExecution(),
      makeSignal()
    )
    expect(r.success).toBe(false)
    expect(r.error).toBe("sidecar exploded")
  })
  it("uses default error message when an error event omits .error", async () => {
    onClaudeMessageMock.mockImplementationOnce(async (cb) => {
      setTimeout(
        () => (cb as (e: unknown) => void)({ sessionId: "session-created", type: "error" }),
        0
      )
      return () => undefined
    })
    const r = await executeChatTask(
      makeTask({ payload: { prompt: "hi" } }),
      makeExecution(),
      makeSignal()
    )
    expect(r.error).toBe("Sidecar error")
  })
  it("ignores events for unrelated sessions", async () => {
    onClaudeMessageMock.mockImplementationOnce(async (cb) => {
      const cast = cb as (e: unknown) => void
      setTimeout(() => cast({ sessionId: "other", type: "result" }), 0)
      setTimeout(() => cast({ sessionId: "session-created", type: "result" }), 5)
      return () => undefined
    })
    const r = await executeChatTask(
      makeTask({ payload: { prompt: "hi" } }),
      makeExecution(),
      makeSignal()
    )
    expect(r.success).toBe(true)
  })
  it("catches errors thrown by sendPrompt", async () => {
    onClaudeMessageMock.mockImplementationOnce(async () => () => undefined)
    sendPromptMock.mockRejectedValueOnce(new Error("send failed"))
    const r = await executeChatTask(
      makeTask({ payload: { prompt: "hi" } }),
      makeExecution(),
      makeSignal()
    )
    expect(r.success).toBe(false)
    expect(r.error).toBe("send failed")
  })
  it("coerces non-Error sendPrompt failures", async () => {
    onClaudeMessageMock.mockImplementationOnce(async () => () => undefined)
    sendPromptMock.mockRejectedValueOnce("string error")
    const r = await executeChatTask(
      makeTask({ payload: { prompt: "hi" } }),
      makeExecution(),
      makeSignal()
    )
    expect(r.error).toBe("string error")
  })
  it("returns failure when resolveSendOptions throws", async () => {
    resolveSendOptionsMock.mockRejectedValueOnce(new Error("resolver boom"))
    const r = await executeChatTask(
      makeTask({ payload: { prompt: "hi" } }),
      makeExecution(),
      makeSignal()
    )
    expect(r.success).toBe(false)
    expect(r.error).toBe("resolver boom")
  })
  it("tolerates getSettings failure", async () => {
    getSettingsMock.mockRejectedValueOnce(new Error("settings boom"))
    emitTerminalResult()
    const r = await executeChatTask(
      makeTask({ payload: { prompt: "hi" } }),
      makeExecution(),
      makeSignal()
    )
    expect(r.success).toBe(true)
  })
  it("rewrites legacy payload.message before running", async () => {
    emitTerminalResult()
    const r = await executeChatTask(
      makeTask({ payload: { message: "legacy" } }),
      makeExecution(),
      makeSignal()
    )
    expect(r.success).toBe(true)
    expect(sendPromptMock.mock.calls[0]?.[1]).toBe("legacy")
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
    const r = await executeChatTask(
      makeTask({ payload: { prompt: "hi" } }),
      makeExecution(),
      makeSignal()
    )
    expect(r.success).toBe(true)
  })
  it("calls interruptSession when signal is aborted", async () => {
    onClaudeMessageMock.mockImplementationOnce(async (_cb) => {
      return () => undefined
    })
    const controller = new AbortController()
    const promise = executeChatTask(
      makeTask({ payload: { prompt: "hi" } }),
      makeExecution(),
      controller.signal
    )
    controller.abort()
    const r = await promise
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/aborted/)
    expect(interruptSessionMock).toHaveBeenCalledWith("session-created")
  })
  it("does not set an internal timer for timeout", async () => {
    emitTerminalResult()
    const task = makeTask({ payload: { prompt: "hi" } })
    const r = await executeChatTask(task, makeExecution(), makeSignal())
    expect(r.success).toBe(true)
    // The old implementation would start a setTimeout equal to task.config.timeout (300_000ms).
    // With the internal timer removed, execution resolves as soon as the sidecar
    // emits a terminal event, without waiting for a local timer.
  })
})

describe("executeAgentTask", () => {
  it("rejects without prompt or characterId", async () => {
    expect(
      (await executeAgentTask(makeTask({ payload: {} }), makeExecution(), makeSignal())).error
    ).toMatch(/prompt/)
    expect(
      (
        await executeAgentTask(
          makeTask({ payload: { prompt: "hi" } }),
          makeExecution(),
          makeSignal()
        )
      ).error
    ).toMatch(/characterId/)
  })
  it("passes characterId to createSession", async () => {
    emitTerminalResult()
    await executeAgentTask(
      makeTask({ payload: { prompt: "hi", characterId: "char-1" } }),
      makeExecution(),
      makeSignal()
    )
    expect(createSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ characterId: "char-1" })
    )
  })
  it("rewrites legacy payload.agentTask to prompt", async () => {
    emitTerminalResult()
    const r = await executeAgentTask(
      makeTask({ payload: { agentTask: "do work", characterId: "c" } }),
      makeExecution(),
      makeSignal()
    )
    expect(r.success).toBe(true)
    expect(sendPromptMock.mock.calls[0]?.[1]).toBe("do work")
  })
  it("rejects undefined payload", async () => {
    const r = await executeAgentTask(
      makeTask({ payload: undefined }),
      makeExecution(),
      makeSignal()
    )
    expect(r.success).toBe(false)
  })
})

describe("executeSkillTask", () => {
  it("rejects without prompt or skillId", async () => {
    expect(
      (await executeSkillTask(makeTask({ payload: {} }), makeExecution(), makeSignal())).error
    ).toMatch(/prompt/)
    expect(
      (
        await executeSkillTask(
          makeTask({ payload: { prompt: "hi" } }),
          makeExecution(),
          makeSignal()
        )
      ).error
    ).toMatch(/skillId/)
  })
  it("rejects undefined payload", async () => {
    const r = await executeSkillTask(
      makeTask({ payload: undefined }),
      makeExecution(),
      makeSignal()
    )
    expect(r.success).toBe(false)
  })
  it("invokes applyAdHocSkill when skillId is provided", async () => {
    listEnabledSkillsByIdsMock.mockResolvedValueOnce([
      { id: "skill-1", allowedTools: ["TodoWrite"] },
    ])
    renderSkillsSectionMock.mockReturnValueOnce("SKILL")
    emitTerminalResult()
    const r = await executeSkillTask(
      makeTask({ payload: { prompt: "hi", skillId: "skill-1" } }),
      makeExecution(),
      makeSignal()
    )
    expect(r.success).toBe(true)
    expect(listEnabledSkillsByIdsMock).toHaveBeenCalledWith(["skill-1"])
    const options = sendPromptMock.mock.calls[0]?.[2] as SendOptions
    expect(options.allowedTools).toEqual(expect.arrayContaining(["TodoWrite"]))
  })
})

describe("executeExternalAgentTask", () => {
  it("rejects without prompt", async () => {
    const r = await executeExternalAgentTask(
      makeTask({ payload: { agentId: "a" } }),
      makeExecution(),
      makeSignal()
    )
    expect(r.error).toMatch(/prompt/)
  })
  it("rejects without agentId", async () => {
    const r = await executeExternalAgentTask(
      makeTask({ payload: { prompt: "hi" } }),
      makeExecution(),
      makeSignal()
    )
    expect(r.error).toMatch(/agentId/)
  })
  it("returns 'no matching external agent' when manager returns null", async () => {
    executeOnExternalAgentMock.mockResolvedValueOnce(null)
    const r = await executeExternalAgentTask(
      makeTask({ payload: { prompt: "hi", agentId: "a" } }),
      makeExecution(),
      makeSignal()
    )
    expect(r.error).toMatch(/No matching external agent/)
  })
  it("forwards payload to executeOnExternalAgent and unwraps the result", async () => {
    executeOnExternalAgentMock.mockResolvedValueOnce({
      success: true,
      sessionId: "s",
      finalResponse: "done",
      duration: 1,
      messages: [],
      steps: [],
      toolCalls: [],
    })
    const r = await executeExternalAgentTask(
      makeTask({
        payload: {
          prompt: "hi",
          agentId: "a",
          permissionMode: "acceptEdits",
          cwd: "/tmp",
          timeoutMs: 1000,
        },
      }),
      makeExecution(),
      makeSignal()
    )
    expect(executeOnExternalAgentMock).toHaveBeenCalledWith(
      "hi",
      expect.objectContaining({
        agentId: "a",
        permissionMode: "acceptEdits",
        workingDirectory: "/tmp",
        timeout: 1000,
      })
    )
    expect(r.success).toBe(true)
  })
  it("falls back to task.config.timeout when payload.timeoutMs absent", async () => {
    executeOnExternalAgentMock.mockResolvedValueOnce({
      success: true,
      sessionId: "s",
      finalResponse: "",
      duration: 0,
      messages: [],
      steps: [],
      toolCalls: [],
    })
    await executeExternalAgentTask(
      makeTask({ payload: { prompt: "hi", agentId: "a" } }),
      makeExecution(),
      makeSignal()
    )
    const opts = executeOnExternalAgentMock.mock.calls[0]?.[1] as { timeout: number }
    expect(opts.timeout).toBe(300_000)
  })
  it("catches manager throws", async () => {
    executeOnExternalAgentMock.mockRejectedValueOnce(new Error("nope"))
    const r = await executeExternalAgentTask(
      makeTask({ payload: { prompt: "hi", agentId: "a" } }),
      makeExecution(),
      makeSignal()
    )
    expect(r.error).toBe("nope")
  })
  it("coerces non-Error throws", async () => {
    executeOnExternalAgentMock.mockRejectedValueOnce("string-error")
    const r = await executeExternalAgentTask(
      makeTask({ payload: { prompt: "hi", agentId: "a" } }),
      makeExecution(),
      makeSignal()
    )
    expect(r.error).toBe("string-error")
  })
})

describe("executeScriptTask", () => {
  it("rejects without language and code", async () => {
    const r = await executeScriptTask(makeTask({ payload: {} }), makeExecution(), makeSignal())
    expect(r.error).toMatch(/language.*code/)
  })
  it("rejects when payload is undefined", async () => {
    const r = await executeScriptTask(
      makeTask({ payload: undefined }),
      makeExecution(),
      makeSignal()
    )
    expect(r.success).toBe(false)
  })
  it("forwards payload through executeScript", async () => {
    executeScriptMock.mockResolvedValueOnce({
      success: true,
      exit_code: 0,
      stdout: "ok",
      stderr: "",
      duration_ms: 12,
    })
    const r = await executeScriptTask(
      makeTask({ payload: { language: "bash", code: "echo hi" } }),
      makeExecution(),
      makeSignal()
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
      makeTask({ payload: { language: "bash", code: "exit 1" } }),
      makeExecution(),
      makeSignal()
    )
    expect(r.error).toBe("boom")
  })
  it("falls back to task.config.timeout when payload omits timeout_secs", async () => {
    executeScriptMock.mockResolvedValueOnce({ success: true })
    await executeScriptTask(
      makeTask({ payload: { language: "bash", code: "echo" } }),
      makeExecution(),
      makeSignal()
    )
    const action = executeScriptMock.mock.calls[0]?.[0] as { timeout_secs: number }
    expect(action.timeout_secs).toBe(300)
  })
  it("respects payload.timeout_secs", async () => {
    executeScriptMock.mockResolvedValueOnce({ success: true })
    await executeScriptTask(
      makeTask({
        payload: { language: "bash", code: "echo", timeout_secs: 60 },
      }),
      makeExecution(),
      makeSignal()
    )
    const action = executeScriptMock.mock.calls[0]?.[0] as { timeout_secs: number }
    expect(action.timeout_secs).toBe(60)
  })
  it("falls back to default when task.config.timeout is 0", async () => {
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
      makeExecution(),
      makeSignal()
    )
    const action = executeScriptMock.mock.calls[0]?.[0] as { timeout_secs: number }
    expect(action.timeout_secs).toBe(300)
  })
})

describe("executeCustomTask", () => {
  it("returns a friendly no-op success result", async () => {
    const r = await executeCustomTask(makeTask({}), makeExecution(), makeSignal())
    expect(r.success).toBe(true)
    expect(r.output).toMatchObject({ note: expect.stringMatching(/Custom executor/) })
  })
})

describe("re-exports", () => {
  it("exposes executeBackupTask and executePluginTask", async () => {
    expect(typeof executeBackupTask).toBe("function")
    expect(typeof executePluginTask).toBe("function")
    await executeBackupTask(makeTask({}), makeExecution(), makeSignal())
    expect(executeBackupTaskMock).toHaveBeenCalled()
    await executePluginTask(makeTask({}), makeExecution(), makeSignal())
    expect(executePluginTaskMock).toHaveBeenCalled()
  })
})
