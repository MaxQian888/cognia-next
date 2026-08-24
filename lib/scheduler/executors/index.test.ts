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

// Host gating goes through `lib/scheduler/host-support` → `lib/platform/detect`
// (`detectPlatform()` + the capability baseline); flip the platform between
// "tauri" and "web" to exercise the supported / unsupported branches.
// State lives inside the factory: `detectPlatform()` runs during module
// import (transport selection), before a top-level `let` would be initialised.
jest.mock("@/lib/platform/detect", () => {
  const hostState = { tauri: true }
  return {
    ...jest.requireActual("@/lib/platform/detect"),
    __hostState: hostState,
    detectPlatform: () => (hostState.tauri ? "tauri" : "web"),
    isTauri: () => hostState.tauri,
  }
})
import * as platformDetect from "@/lib/platform/detect"

/**
 * The capability scope these helpers take. A schedule resolves skills and MCP
 * servers against the workspace that owns its conversation; `{}` here means
 * "whatever `resolveScopeProjectId` decides", which is what these unit cases
 * exercise — the threading itself is covered by the run-level tests.
 */
const SCOPE = {}
const hostState = (platformDetect as unknown as { __hostState: { tauri: boolean } }).__hostState
jest.mock("@/lib/tauri", () => ({
  // Delegate to the detect mock's state so both modules agree at import time.
  isTauri: () =>
    (jest.requireMock("@/lib/platform/detect") as { isTauri: () => boolean }).isTauri(),
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
const beginAgentTaskAttemptMock = jest.fn()
const linkAgentTaskAttemptExecutionMock = jest.fn()
const settleAgentTaskAttemptMock = jest.fn()
jest.mock("@/lib/db/agent-tasks", () => ({
  beginAgentTaskAttempt: (...args: unknown[]) => beginAgentTaskAttemptMock(...args),
  linkAgentTaskAttemptExecution: (...args: unknown[]) => linkAgentTaskAttemptExecutionMock(...args),
  settleAgentTaskAttempt: (...args: unknown[]) => settleAgentTaskAttemptMock(...args),
}))

const settleTaskWorkspaceMock = jest.fn(async () => [])
const openWorkspaceBundleTurnLeaseMock = jest.fn()
jest.mock("@/lib/task-workspace/run-lease", () => ({
  openWorkspaceBundleTurnLease: (...args: unknown[]) => openWorkspaceBundleTurnLeaseMock(...args),
}))
const getWorkspaceBundleMock = jest.fn()
const acquireWorkspaceBundleMock = jest.fn()
jest.mock("@/lib/task-workspace/client", () => ({
  acquireWorkspaceBundle: (input: unknown) => acquireWorkspaceBundleMock(input),
  getWorkspaceBundle: (bundleId: string) => getWorkspaceBundleMock(bundleId),
}))

const getProjectEnvironmentMock = jest.fn()
jest.mock("@/lib/db/project-environments", () => ({
  getProjectEnvironment: (id: string) => getProjectEnvironmentMock(id),
}))
const executeProjectEnvironmentMock = jest.fn()
jest.mock("@/lib/project-environment/executor", () => ({
  executeProjectEnvironment: (input: unknown) => executeProjectEnvironmentMock(input),
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
  buildMcpServerMapResolved: (rows: Array<{ id: string }>) => buildMcpServerMapMock(rows),
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
  executeScript: (action: unknown, options?: unknown) => executeScriptMock(action, options),
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

jest.mock("@cognia/logging", () => {
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
import type { SendOptions } from "@cognia/agent-config-types"

beforeEach(() => {
  hostState.tauri = true
  sendPromptMock.mockClear()
  onClaudeMessageMock.mockReset()
  interruptSessionMock.mockClear()
  createSessionMock.mockClear()
  beginAgentTaskAttemptMock.mockReset().mockResolvedValue({ id: "attempt-1" })
  linkAgentTaskAttemptExecutionMock.mockReset().mockResolvedValue(undefined)
  settleAgentTaskAttemptMock.mockReset().mockResolvedValue(undefined)
  getWorkspaceBundleMock.mockReset().mockResolvedValue({
    bundleId: "bundle-1",
    environmentKind: "managed",
    ownerType: "session",
    ownerRef: "session-1",
    state: "active",
    leases: [
      {
        logicalRootId: "root-primary",
        role: "primary",
        aliasPath: "/bundle/primary",
        workspaceId: "workspace-primary",
      },
      {
        logicalRootId: "root-docs",
        role: "additional",
        aliasPath: "/bundle/docs",
        workspaceId: "workspace-docs",
      },
    ],
  })
  acquireWorkspaceBundleMock.mockReset().mockResolvedValue({
    bundleId: "scheduled-bundle-1",
    leases: [
      {
        bundleId: "scheduled-bundle-1",
        workspaceId: "scheduled-workspace-1",
        logicalRootId: "primary",
        role: "primary",
        aliasPath: "/scheduled/isolated",
      },
    ],
  })
  openWorkspaceBundleTurnLeaseMock.mockReset().mockResolvedValue({
    run: { runId: "task-run-bundle-1", executionRoot: "/bundle/primary" },
    primaryAlias: "/bundle/primary",
    additionalAliases: ["/bundle/docs"],
    settle: settleTaskWorkspaceMock,
  })
  settleTaskWorkspaceMock.mockClear()
  getProjectEnvironmentMock.mockReset().mockResolvedValue(undefined)
  executeProjectEnvironmentMock.mockReset().mockResolvedValue({ success: true, bypassed: false })
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
      null,
      SCOPE
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
      null,
      SCOPE
    )
    expect(out.appendSystemPrompt).toBe("base\n\nextra")
  })
  it("uses payload appendSystemPrompt verbatim when base is empty", async () => {
    const out = await applyPayloadOverrides(
      {},
      { prompt: "p", appendSystemPrompt: "extra" },
      null,
      SCOPE
    )
    expect(out.appendSystemPrompt).toBe("extra")
  })
  it("unions allowedTools", async () => {
    const out = await applyPayloadOverrides(
      { allowedTools: ["Read", "Write"] },
      { prompt: "p", allowedTools: ["Bash", "Read"] },
      null,
      SCOPE
    )
    expect(out.allowedTools).toEqual(expect.arrayContaining(["Read", "Write", "Bash"]))
    expect(out.allowedTools).toHaveLength(3)
  })
  it("unions additionalDirectories", async () => {
    const out = await applyPayloadOverrides(
      { additionalDirectories: ["/a"] },
      { prompt: "p", additionalDirectories: ["/b", "/a"] },
      null,
      SCOPE
    )
    expect(out.additionalDirectories).toHaveLength(2)
  })
  it("replaces disallowedTools", async () => {
    const out = await applyPayloadOverrides(
      { disallowedTools: ["Old"] },
      { prompt: "p", disallowedTools: ["New"] },
      null,
      SCOPE
    )
    expect(out.disallowedTools).toEqual(["New"])
  })
  it("resolves payload.mcpServerIds against enabled servers", async () => {
    listEnabledMcpServersMock.mockResolvedValueOnce([
      { id: "a", enabled: true },
      { id: "b", enabled: true },
    ])
    const out = await applyPayloadOverrides({}, { prompt: "p", mcpServerIds: ["a"] }, null, SCOPE)
    expect(out.mcpServers).toMatchObject({ a: { id: "a" } })
  })
  it("strips mcpServers when payload requests an empty subset", async () => {
    listEnabledMcpServersMock.mockResolvedValueOnce([{ id: "a", enabled: true }])
    const out = await applyPayloadOverrides(
      { mcpServers: { x: {} } },
      { prompt: "p", mcpServerIds: [] },
      null,
      SCOPE
    )
    expect(out.mcpServers).toBeUndefined()
  })
  it("survives listEnabledMcpServers failure", async () => {
    listEnabledMcpServersMock.mockRejectedValueOnce(new Error("boom"))
    const out = await applyPayloadOverrides(
      { mcpServers: { x: {} } },
      { prompt: "p", mcpServerIds: ["a"] },
      null,
      SCOPE
    )
    expect(out).toBeDefined()
  })
  it("shallow-merges builtinTools over the resolved AppSettings", async () => {
    const out = await applyPayloadOverrides(
      {},
      { prompt: "p", builtinTools: { git: false } },
      {
        id: "singleton",
        alwaysAllowTools: [],
        builtinTools: {
          fileExtras: true,
          git: true,
          process: false,
          environment: true,
          shellAdvanced: false,
        },
      } as unknown as Parameters<typeof applyPayloadOverrides>[2],
      SCOPE
    )
    expect(out.builtinTools).toMatchObject({
      fileExtras: true,
      git: false,
      environment: true,
    })
  })
})

describe("applyAdHocSkill", () => {
  it("is a no-op when no skillId is given", async () => {
    const out = await applyAdHocSkill({}, undefined, SCOPE)
    expect(out).toEqual({})
  })
  it("is a no-op when the skill is not found", async () => {
    listEnabledSkillsByIdsMock.mockResolvedValueOnce([])
    const out = await applyAdHocSkill({}, "missing", SCOPE)
    expect(out).toEqual({})
  })
  it("appends the skill section and unions allowedTools", async () => {
    listEnabledSkillsByIdsMock.mockResolvedValueOnce([{ id: "s1", allowedTools: ["TodoWrite"] }])
    renderSkillsSectionMock.mockReturnValueOnce("SKILL_SECTION")
    const out = await applyAdHocSkill({ systemPrompt: "base", allowedTools: ["Read"] }, "s1", SCOPE)
    expect(out.systemPrompt).toContain("base")
    expect(out.systemPrompt).toContain("SKILL_SECTION")
    expect(out.allowedTools).toEqual(expect.arrayContaining(["Read", "TodoWrite"]))
  })
  it("uses skill section verbatim when base systemPrompt is absent", async () => {
    listEnabledSkillsByIdsMock.mockResolvedValueOnce([{ id: "s1" }])
    renderSkillsSectionMock.mockReturnValueOnce("SKILL")
    const out = await applyAdHocSkill({}, "s1", SCOPE)
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
  it("returns a structured unsupported-on-host result on a host without the sidecar", async () => {
    hostState.tauri = false
    const r = await executeChatTask(
      makeTask({ payload: { prompt: "hi" } }),
      makeExecution(),
      makeSignal()
    )
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/sidecar capability/)
    expect(r.terminalReason).toBe("unsupported-on-host")
    expect(r.output).toMatchObject({
      hostSupport: { reason: "missing-capability", missing: ["sidecar"], platform: "web" },
    })
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
  it("persists and executes a scheduled chat in its durable managed worktree", async () => {
    const executionContext = {
      location: "managedWorktree" as const,
      projectId: "project-1",
      projectRoot: "/repo",
      taskWorkspace: { taskId: "task-workspace:session-1", workspaceKey: "session-1" },
      baseRef: "main",
    }
    emitTerminalResult()
    const result = await executeChatTask(
      makeTask({ payload: { prompt: "hi", executionContext } }),
      { ...makeExecution(), id: "execution-1" },
      makeSignal()
    )

    expect(createSessionMock).toHaveBeenCalledWith(expect.objectContaining({ executionContext }))
    expect(acquireWorkspaceBundleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerType: "scheduled",
        ownerRef: "task-1",
        base: { kind: "remoteDefault" },
        roots: [expect.objectContaining({ sourceRoot: "/repo" })],
      })
    )
    expect(sendPromptMock).toHaveBeenCalledWith(
      "session-created",
      "hi",
      expect.objectContaining({ cwd: "/bundle/primary" })
    )
    expect(settleTaskWorkspaceMock).toHaveBeenCalledWith("ready")
    expect(result.success).toBe(true)
  })

  it("fails closed when a scheduled managed worktree cannot be acquired", async () => {
    acquireWorkspaceBundleMock.mockRejectedValueOnce(new Error("registry unavailable"))
    const result = await executeChatTask(
      makeTask({
        payload: {
          prompt: "hi",
          executionContext: {
            location: "managedWorktree",
            projectId: "project-1",
            projectRoot: "/repo",
            taskWorkspace: { taskId: "task-1", workspaceKey: "session-1" },
          },
        },
      }),
      makeExecution(),
      makeSignal()
    )
    expect(result).toEqual({
      success: false,
      error: "Scheduled workspace isolation is unavailable",
    })
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("borrows the canonical bundle and replaces live additional directories", async () => {
    const executionContext = {
      execution: {
        mode: "managed" as const,
        bundleId: "bundle-1",
        base: { kind: "remoteDefault" as const },
        roots: [
          {
            logicalRootId: "root-primary",
            role: "primary" as const,
            aliasPath: "/live/repo",
            workspaceId: "workspace-primary",
          },
          {
            logicalRootId: "root-docs",
            role: "additional" as const,
            aliasPath: "/live/docs",
            workspaceId: "workspace-docs",
          },
        ],
      },
      location: "managedWorktree" as const,
      projectId: "project-1",
      projectRoot: "/live/repo",
      taskWorkspace: { taskId: "task-workspace:session-1", workspaceKey: "session-1" },
    }
    resolveSendOptionsMock.mockResolvedValueOnce({
      additionalDirectories: ["/live/docs"],
    } as unknown as Record<string, unknown>)
    getSessionMock.mockResolvedValueOnce({ id: "session-1", executionContext })
    emitTerminalResult("session-1")

    const result = await executeChatTask(
      makeTask({ payload: { prompt: "hi", sessionId: "session-1" } }),
      { ...makeExecution(), id: "execution-bundle-1" },
      makeSignal()
    )

    expect(openWorkspaceBundleTurnLeaseMock).toHaveBeenCalledWith(
      expect.objectContaining({ bundleId: "bundle-1" }),
      "root-primary",
      expect.objectContaining({
        taskId: "task-workspace:session-1",
        surface: "scheduler",
      })
    )
    expect(getWorkspaceBundleMock).toHaveBeenCalledWith("bundle-1")
    expect(createSessionMock).not.toHaveBeenCalled()
    expect(sendPromptMock).toHaveBeenCalledWith(
      "session-1",
      "hi",
      expect.objectContaining({
        cwd: "/bundle/primary",
        additionalDirectories: ["/bundle/docs"],
      })
    )
    expect(result.success).toBe(true)
  })

  it("runs project setup in the selected execution root before scheduled chat", async () => {
    const environment = {
      id: "env-1",
      projectId: "project-1",
      name: "Development",
      isEnabled: true,
      setupScript: { default: "pnpm install" },
      actions: [],
      variables: {},
      keyringReferences: [],
      createdAt: 1,
      updatedAt: 1,
    }
    getProjectEnvironmentMock.mockResolvedValue(environment)
    emitTerminalResult()

    const result = await executeChatTask(
      makeTask({
        payload: {
          prompt: "hi",
          executionContext: {
            location: "local",
            projectId: "project-1",
            projectRoot: "/repo",
            environmentId: "env-1",
            taskWorkspace: { taskId: "task-1", workspaceKey: "session-1" },
          },
        },
      }),
      makeExecution(),
      makeSignal()
    )

    expect(executeProjectEnvironmentMock).toHaveBeenCalledWith({
      environment,
      executionRoot: "/bundle/primary",
      scope: "local",
      surface: "scheduled",
    })
    expect(acquireWorkspaceBundleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerType: "scheduled",
        base: { kind: "remoteDefault" },
        roots: [expect.objectContaining({ sourceRoot: "/repo" })],
      })
    )
    expect(sendPromptMock).toHaveBeenCalled()
    expect(result.success).toBe(true)
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
  it("journals each board execution as an independent Agent task attempt", async () => {
    emitTerminalResult()
    const execution = makeExecution()
    const result = await executeAgentTask(
      makeTask({ payload: { prompt: "do work", characterId: "c", agentTaskId: "board-1" } }),
      execution,
      makeSignal()
    )

    expect(result.success).toBe(true)
    expect(beginAgentTaskAttemptMock).toHaveBeenCalledWith(
      "board-1",
      expect.objectContaining({ runId: execution.id })
    )
    expect(linkAgentTaskAttemptExecutionMock).toHaveBeenCalledWith("attempt-1", execution.id)
    expect(settleAgentTaskAttemptMock).toHaveBeenCalledWith(
      "attempt-1",
      expect.objectContaining({ status: "completed" })
    )
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
        workingDirectory: "/bundle/primary",
        timeout: 1000,
      })
    )
    expect(acquireWorkspaceBundleMock).toHaveBeenCalledWith({
      ownerType: "scheduled",
      ownerRef: "task-1",
      environmentKind: "managed",
      base: { kind: "remoteDefault" },
      roots: [{ logicalRootId: "primary", role: "primary", sourceRoot: "/tmp" }],
    })
    expect(openWorkspaceBundleTurnLeaseMock).toHaveBeenCalledWith(
      expect.objectContaining({ bundleId: "scheduled-bundle-1" }),
      "primary",
      expect.objectContaining({
        runId: "scheduled:exec-1:scheduled-external-agent",
        surface: "scheduler",
        base: { kind: "remoteDefault" },
      })
    )
    expect(settleTaskWorkspaceMock).toHaveBeenCalledWith("ready")
    expect(r.success).toBe(true)
  })
  it("fails closed when the requested cwd cannot acquire a Registry Bundle", async () => {
    acquireWorkspaceBundleMock.mockRejectedValueOnce(new Error("registry unavailable"))

    const r = await executeExternalAgentTask(
      makeTask({ payload: { prompt: "hi", agentId: "a", cwd: "/tmp" } }),
      makeExecution(),
      makeSignal()
    )

    expect(r).toMatchObject({ success: false, error: "registry unavailable" })
    expect(executeOnExternalAgentMock).not.toHaveBeenCalled()
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
  it("routes an explicit working directory through an isolated Registry Bundle", async () => {
    executeScriptMock.mockResolvedValueOnce({ success: true })

    const r = await executeScriptTask(
      makeTask({ payload: { language: "bash", code: "pwd", working_dir: "/tmp" } }),
      makeExecution(),
      makeSignal()
    )

    expect(r.success).toBe(true)
    expect(executeScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ working_dir: "/bundle/primary" }),
      expect.anything()
    )
    expect(acquireWorkspaceBundleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerType: "scheduled",
        ownerRef: "task-1",
        environmentKind: "managed",
        base: { kind: "remoteDefault" },
      })
    )
    expect(settleTaskWorkspaceMock).toHaveBeenCalledWith("ready")
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
  it("fails with executor-not-found instead of a silent no-op success", async () => {
    const r = await executeCustomTask(makeTask({}), makeExecution(), makeSignal())
    expect(r.success).toBe(false)
    expect(r.terminalReason).toBe("executor-not-found")
    expect(r.error).toMatch(/registerTaskExecutor\("custom"/)
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
