import { dispatchTeammate } from "./dispatch-teammate"
import type { TeamRunContext } from "./team-run-context"
import type { AgentTeam, AgentTeammate } from "@/types/agent/agent-team"
import { emitSystemBusEvent, SystemEvents } from "@/lib/plugin/messaging/message-bus"

const mockedBusEmit = emitSystemBusEvent as jest.Mock
const mockTrackEvent = jest.fn().mockResolvedValue(true)

jest.mock("@/lib/telemetry/events/track-event", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}))

// ── Module mocks ────────────────────────────────────────────────────────────
const isTauriMock = jest.fn<boolean, []>(() => false)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

const taskWorkspaceEnabledMock = jest.fn(() => false)
jest.mock("@/stores/settings", () => ({
  useSettingsStore: {
    getState: () => ({
      settings: { developer: { taskWorkspace: taskWorkspaceEnabledMock() } },
    }),
  },
}))

const beginTaskWorkspaceTurnMock = jest.fn()
const settleTaskWorkspaceRunMock = jest.fn()
jest.mock("@/lib/task-workspace/client", () => ({
  beginTaskWorkspaceTurn: (...args: unknown[]) => beginTaskWorkspaceTurnMock(...args),
  settleTaskWorkspaceRun: (...args: unknown[]) => settleTaskWorkspaceRunMock(...args),
  taskIdForMessage: (value: string) => `task:${value}`,
  runIdForTurn: (sessionId: string, runId: number) => `run:${sessionId}:${runId}`,
}))

const resolveAcpMcpMock = jest.fn<Promise<unknown[]>, unknown[]>(async () => [])
jest.mock("@/lib/ai/agent/external/resolve-acp-mcp-servers", () => ({
  resolveAcpMcpServers: (...a: unknown[]) => resolveAcpMcpMock(...a),
}))

const executeAgentMock = jest.fn()
jest.mock("../agent-executor", () => ({
  executeAgent: (...a: unknown[]) => executeAgentMock(...a),
}))

const createSessionMock = jest.fn((..._a: unknown[]) => Promise.resolve({ id: "sess" }))
const getSessionMock = jest.fn((..._a: unknown[]) => Promise.resolve(undefined as unknown))
const deleteSessionMock = jest.fn((..._a: unknown[]) => Promise.resolve())
jest.mock("@/lib/db/sessions", () => ({
  createSession: (...a: unknown[]) => createSessionMock(...a),
  getSession: (...a: unknown[]) => getSessionMock(...a),
  deleteSession: (...a: unknown[]) => deleteSessionMock(...a),
}))

jest.mock("@/lib/db/settings", () => ({ getSettings: () => Promise.resolve({}) }))

const resolveSendOptionsMock = jest.fn((..._a: unknown[]) => Promise.resolve({}))
jest.mock("@/lib/claude/build-options", () => ({
  resolveSendOptions: (...a: unknown[]) => resolveSendOptionsMock(...a),
}))

const runAndCaptureMock = jest.fn()
jest.mock("@/lib/claude/run-and-capture", () => ({
  runAndCaptureAssistantReply: (...a: unknown[]) => runAndCaptureMock(...a),
}))

const hookFns = {
  dispatchOnTeammateClaim: jest.fn(),
  dispatchOnTeammateRelease: jest.fn(),
  dispatchOnAgentStart: jest.fn(),
  dispatchOnAgentComplete: jest.fn(),
  dispatchOnAgentError: jest.fn(),
}
jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginLifecycleHooks: () => hookFns,
}))

jest.mock("@/lib/plugin/messaging/message-bus", () => {
  const actual = jest.requireActual("@/lib/plugin/messaging/message-bus")
  return { ...actual, emitSystemBusEvent: jest.fn() }
})

const resolveExternalMock = jest.fn<Promise<string | null>, unknown[]>(async () => null)
jest.mock("./resolve-external-backing", () => ({
  resolveTeammateExternalAgent: (...a: unknown[]) => resolveExternalMock(...a),
}))

const externalExecuteMock = jest.fn()
jest.mock("@/lib/ai/agent/external/manager", () => ({
  getExternalAgentManager: () => ({ execute: (...a: unknown[]) => externalExecuteMock(...a) }),
}))

const applyTeammateTwinContextMock = jest.fn()
jest.mock("./twin-context", () => ({
  applyTeammateTwinContext: (...a: unknown[]) => applyTeammateTwinContextMock(...a),
}))

// ── Fixtures ────────────────────────────────────────────────────────────────
function makeTeammate(overrides: Partial<AgentTeammate> = {}): AgentTeammate {
  return {
    id: "tm1",
    teamId: "team1",
    name: "Worker",
    description: "does work",
    role: "teammate",
    status: "idle",
    config: {},
    completedTaskIds: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    progress: 0,
    createdAt: new Date(0),
    ...overrides,
  }
}

function makeCtx(
  teammate: AgentTeammate | null,
  configOverrides: Partial<AgentTeam["config"]> = {},
  modelHint?: string
) {
  const pool = {
    claim: jest.fn(() => teammate),
    recordSuccess: jest.fn(),
    recordFailure: jest.fn(),
    availableCount: jest.fn(() => (teammate ? 1 : 0)),
    isDisqualified: jest.fn(() => false),
    allUnavailable: jest.fn(() => !teammate),
    onAllUnavailable: jest.fn(() => () => {}),
    onTeammateDisqualified: jest.fn(() => () => {}),
    forceUnquarantine: jest.fn(),
    rejoin: jest.fn(),
  }
  const storeWriter = {
    addMessage: jest.fn(),
    setTaskStatus: jest.fn(),
    updateTeammate: jest.fn(),
  }
  const notifier = { notify: jest.fn() }
  const ctx = {
    runId: "run1",
    teamId: "team1",
    team: {
      id: "team1",
      name: "Team",
      config: {
        maxTeammates: 5,
        maxConcurrentTeammates: 3,
        executionMode: "coordinated",
        displayMode: "expanded",
        ...configOverrides,
      },
    },
    pool,
    budget: { add: jest.fn() },
    notifier,
    concurrency: { get: () => 3 },
    modelPref: { get: () => ({ modelHint }) },
    storeWriter,
    resolvedCapabilities: new Map(),
    externalAgentInstances: new Map(),
  } as unknown as TeamRunContext
  return { ctx, pool, storeWriter, notifier }
}

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(false)
  taskWorkspaceEnabledMock.mockReturnValue(false)
  beginTaskWorkspaceTurnMock.mockResolvedValue(null)
  settleTaskWorkspaceRunMock.mockResolvedValue([])
  resolveExternalMock.mockResolvedValue(null)
  applyTeammateTwinContextMock.mockResolvedValue({ systemPrompt: "unused-default", applied: false })
})

describe("dispatchTeammate — text-only fallback", () => {
  it("runs the AI-SDK path off-desktop and records success", async () => {
    executeAgentMock.mockResolvedValue({ text: "the answer" })
    const { ctx, pool } = makeCtx(makeTeammate())

    const result = await dispatchTeammate(ctx, { taskId: "t1", prompt: "do it" })

    expect(result.channel).toBe("text")
    expect(result.text).toBe("the answer")
    expect(result.teammateId).toBe("tm1")
    expect(executeAgentMock).toHaveBeenCalledTimes(1)
    expect(runAndCaptureMock).not.toHaveBeenCalled()
    expect(pool.recordSuccess).toHaveBeenCalledWith("tm1")
    expect(hookFns.dispatchOnAgentStart).toHaveBeenCalledTimes(1)
    expect(hookFns.dispatchOnAgentComplete).toHaveBeenCalledTimes(1)
    // Plugin bus mirrors the team agent lifecycle (ids only).
    expect(mockedBusEmit).toHaveBeenCalledWith(
      SystemEvents.AGENT_STARTED,
      expect.objectContaining({ agentId: "tm1", teamId: "team1" })
    )
    expect(mockedBusEmit).toHaveBeenCalledWith(
      SystemEvents.AGENT_COMPLETED,
      expect.objectContaining({ agentId: "tm1" })
    )
    expect(mockTrackEvent.mock.calls).toEqual([
      ["agent.teammate.started", { runId: "run1", teamId: "team1", role: "teammate" }],
      [
        "agent.teammate.completed",
        expect.objectContaining({ runId: "run1", teamId: "team1", channel: "text" }),
      ],
    ])
  })

  it("records a bounded failure class without exporting the error message", async () => {
    executeAgentMock.mockRejectedValue(new TypeError("private provider response"))
    const { ctx } = makeCtx(makeTeammate())

    await expect(dispatchTeammate(ctx, { taskId: "t1", prompt: "do it" })).rejects.toThrow(
      "private provider response"
    )
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "agent.teammate.failed",
      expect.objectContaining({ runId: "run1", teamId: "team1", errorType: "TypeError" })
    )
    expect(JSON.stringify(mockTrackEvent.mock.calls)).not.toContain("private provider response")
  })

  it("reports degradedReason on the result when a tool-capable claude teammate degrades to text (ADR-0090)", async () => {
    executeAgentMock.mockResolvedValue({ text: "ok" })
    const { ctx } = makeCtx(makeTeammate())

    const result = await dispatchTeammate(ctx, { taskId: "t1", prompt: "do it" })
    expect(result.degradedReason).toBe("sidecar-unavailable")
  })

  it("resolver flag on: the unified resolver picks the same text channel (parity)", async () => {
    process.env.NEXT_PUBLIC_AGENT_EXECUTION_RESOLVER_V2 = "1"
    try {
      executeAgentMock.mockResolvedValue({ text: "ok" })
      const { ctx, notifier } = makeCtx(makeTeammate())

      const result = await dispatchTeammate(ctx, { taskId: "t1", prompt: "do it" })
      expect(result.channel).toBe("text")
      expect(result.degradedReason).toBe("sidecar-unavailable")
      expect(notifier.notify).toHaveBeenCalledWith(
        expect.objectContaining({ dedupeKey: "text-fallback:run1:tm1" })
      )
    } finally {
      delete process.env.NEXT_PUBLIC_AGENT_EXECUTION_RESOLVER_V2
    }
  })

  it("forwards preferTeammateId to pool.claim (skill-aware assignment)", async () => {
    executeAgentMock.mockResolvedValue({ text: "ok" })
    const { ctx, pool } = makeCtx(makeTeammate())
    await dispatchTeammate(ctx, { taskId: "t1", prompt: "do it", preferTeammateId: "tm1" })
    expect(pool.claim).toHaveBeenCalledWith("t1", { preferTeammateId: "tm1" })
  })

  it("claims without options when no preferTeammateId is given", async () => {
    executeAgentMock.mockResolvedValue({ text: "ok" })
    const { ctx, pool } = makeCtx(makeTeammate())
    await dispatchTeammate(ctx, { taskId: "t1", prompt: "do it" })
    expect(pool.claim).toHaveBeenCalledWith("t1", undefined)
  })

  it("resolves a function prompt against the claimed teammate", async () => {
    executeAgentMock.mockResolvedValue({ text: "ok" })
    const { ctx } = makeCtx(makeTeammate({ name: "Skeptic" }))

    await dispatchTeammate(ctx, { taskId: "t1", prompt: (tm) => `hello ${tm.name}` })

    expect(executeAgentMock).toHaveBeenCalledWith("hello Skeptic", expect.any(Object))
  })

  it("forwards the team defaultMaxSteps to executeAgent", async () => {
    executeAgentMock.mockResolvedValue({ text: "ok" })
    const { ctx } = makeCtx(makeTeammate(), { defaultMaxSteps: 7 })
    await dispatchTeammate(ctx, { taskId: "t1", prompt: "do it" })
    expect(executeAgentMock).toHaveBeenCalledWith("do it", expect.objectContaining({ maxSteps: 7 }))
  })

  it("prefers the teammate's maxSteps over the team default", async () => {
    executeAgentMock.mockResolvedValue({ text: "ok" })
    const { ctx } = makeCtx(makeTeammate({ config: { maxSteps: 3 } }), { defaultMaxSteps: 7 })
    await dispatchTeammate(ctx, { taskId: "t1", prompt: "do it" })
    expect(executeAgentMock).toHaveBeenCalledWith("do it", expect.objectContaining({ maxSteps: 3 }))
  })

  it("omits maxSteps when neither teammate nor team set it", async () => {
    executeAgentMock.mockResolvedValue({ text: "ok" })
    const { ctx } = makeCtx(makeTeammate())
    await dispatchTeammate(ctx, { taskId: "t1", prompt: "do it" })
    expect(executeAgentMock.mock.calls[0][1]).not.toHaveProperty("maxSteps")
  })
})

describe("dispatchTeammate — degraded text-channel diagnostic", () => {
  it("warns once when a tool-capable claude teammate falls back to text", async () => {
    isTauriMock.mockReturnValue(false) // sidecar unavailable
    executeAgentMock.mockResolvedValue({ text: "ok" })
    const { ctx, notifier } = makeCtx(makeTeammate())

    const result = await dispatchTeammate(ctx, { taskId: "t1", prompt: "do it" })

    expect(result.channel).toBe("text")
    expect(notifier.notify).toHaveBeenCalledTimes(1)
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        dedupeKey: "text-fallback:run1:tm1",
        teamId: "team1",
        taskId: "t1",
      })
    )
  })

  it("does not warn on the sidecar path (desktop)", async () => {
    isTauriMock.mockReturnValue(true)
    createSessionMock.mockResolvedValue({ id: "sess1" })
    getSessionMock.mockResolvedValue({ id: "sess1", kind: "team" })
    runAndCaptureMock.mockResolvedValue({ text: "tool result" })
    const { ctx, notifier } = makeCtx(makeTeammate())

    await dispatchTeammate(ctx, { taskId: "t1", prompt: "edit" })

    expect(notifier.notify).not.toHaveBeenCalled()
  })

  it("does not warn when text is intentional (preferToolEnabled false)", async () => {
    isTauriMock.mockReturnValue(false)
    executeAgentMock.mockResolvedValue({ text: "ok" })
    const { ctx, notifier } = makeCtx(makeTeammate())

    await dispatchTeammate(ctx, { taskId: "t1", prompt: "reason", preferToolEnabled: false })

    expect(notifier.notify).not.toHaveBeenCalled()
  })

  it("does not warn for an external-backed teammate", async () => {
    resolveExternalMock.mockResolvedValue("ext-agent-1")
    externalExecuteMock.mockResolvedValue({ success: true, finalResponse: "external result" })
    const { ctx, notifier } = makeCtx(makeTeammate({ config: { runtime: "codex" } }))

    await dispatchTeammate(ctx, { taskId: "t1", prompt: "do it" })

    expect(notifier.notify).not.toHaveBeenCalled()
  })
})

describe("dispatchTeammate — tool-enabled sidecar path", () => {
  it("sets sendOptions.maxTurns from the resolved maxSteps", async () => {
    isTauriMock.mockReturnValue(true)
    createSessionMock.mockResolvedValue({ id: "sess1" })
    getSessionMock.mockResolvedValue({ id: "sess1", kind: "team" })
    runAndCaptureMock.mockResolvedValue({ text: "tool result" })
    const { ctx } = makeCtx(makeTeammate(), { defaultMaxSteps: 9 })

    await dispatchTeammate(ctx, { taskId: "t1", prompt: "edit" })

    expect(runAndCaptureMock).toHaveBeenCalledWith(
      "sess1",
      "edit",
      expect.objectContaining({ maxTurns: 9 }),
      expect.objectContaining({ execution: expect.objectContaining({ kind: "team" }) })
    )
  })

  it("creates a team session and drives runAndCapture on desktop", async () => {
    isTauriMock.mockReturnValue(true)
    createSessionMock.mockResolvedValue({ id: "sess1" })
    getSessionMock.mockResolvedValue({ id: "sess1", kind: "team" })
    runAndCaptureMock.mockResolvedValue({ text: "tool result", messageId: "m1" })
    const { ctx } = makeCtx(makeTeammate(), { workingDir: "/repo" })

    const result = await dispatchTeammate(ctx, { taskId: "t1", prompt: "edit code" })

    expect(result.channel).toBe("sidecar")
    expect(result.text).toBe("tool result")
    expect(createSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "team", workingDir: "/repo" })
    )
    expect(resolveSendOptionsMock).toHaveBeenCalledTimes(1)
    expect(runAndCaptureMock).toHaveBeenCalledWith("sess1", "edit code", {}, expect.any(Object))
    expect(deleteSessionMock).toHaveBeenCalledWith("sess1")
    expect(executeAgentMock).not.toHaveBeenCalled()
  })

  it("falls back to text-only when external backing does not resolve", async () => {
    isTauriMock.mockReturnValue(true)
    resolveExternalMock.mockResolvedValue(null) // e.g. unknown preset / web
    executeAgentMock.mockResolvedValue({ text: "acp result" })
    const { ctx } = makeCtx(makeTeammate({ config: { runtime: "codex" } }))

    const result = await dispatchTeammate(ctx, { taskId: "t1", prompt: "x" })

    expect(result.channel).toBe("text")
    expect(runAndCaptureMock).not.toHaveBeenCalled()
    expect(externalExecuteMock).not.toHaveBeenCalled()
  })

  it("dispatches to the external CLI agent when a preset resolves", async () => {
    isTauriMock.mockReturnValue(true)
    resolveExternalMock.mockResolvedValue("agent-1")
    externalExecuteMock.mockResolvedValue({
      success: true,
      finalResponse: "external output",
      tokenUsage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
    })
    const { ctx, pool } = makeCtx(makeTeammate({ config: { runtime: "claude-code" } }), {
      workingDir: "/repo",
    })

    const result = await dispatchTeammate(ctx, { taskId: "t1", prompt: "edit code" })

    expect(result.channel).toBe("external")
    expect(result.text).toBe("external output")
    expect(result.usage).toEqual({ promptTokens: 3, completionTokens: 4, totalTokens: 7 })
    expect(externalExecuteMock).toHaveBeenCalledWith(
      "agent-1",
      "edit code",
      expect.objectContaining({ workingDirectory: "/repo" })
    )
    expect(runAndCaptureMock).not.toHaveBeenCalled()
    expect(executeAgentMock).not.toHaveBeenCalled()
    expect(pool.recordSuccess).toHaveBeenCalledWith("tm1")
  })

  it("does not mark a task completed when the lead still has to review it", async () => {
    // Regression: the dispatcher wrote `completed` before the review node ran,
    // so the board claimed work was done while it was still under review — and
    // flipped completed → failed when the lead rejected it. With review on the
    // task stays `in_progress` (true, and a runtime-owned column no one can
    // hand-move) until the review node writes the terminal status.
    isTauriMock.mockReturnValue(false)
    executeAgentMock.mockResolvedValue({ text: "the work" })
    const { ctx, storeWriter } = makeCtx(makeTeammate(), { taskReview: { enabled: true } })

    await dispatchTeammate(ctx, { taskId: "t1", prompt: "do it", recordToStore: true })

    expect(storeWriter.setTaskStatus).not.toHaveBeenCalled()
    // The result message still lands — only the acceptance decision moves.
    expect(storeWriter.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "result_share", taskId: "t1" })
    )
  })

  it("still completes the task itself when review is off", async () => {
    isTauriMock.mockReturnValue(false)
    executeAgentMock.mockResolvedValue({ text: "the work" })
    const { ctx, storeWriter } = makeCtx(makeTeammate())

    await dispatchTeammate(ctx, { taskId: "t1", prompt: "do it", recordToStore: true })

    expect(storeWriter.setTaskStatus).toHaveBeenCalledWith("t1", "completed", "the work")
  })

  it("passes the teammate's configured model to the external agent", async () => {
    // Regression: runExternalBacked never received modelHint and never sent a
    // model, so an external teammate silently ran on whatever its own CLI
    // config selected — while the sidecar and text channels both honoured it.
    isTauriMock.mockReturnValue(true)
    resolveExternalMock.mockResolvedValue("agent-1")
    externalExecuteMock.mockResolvedValue({ success: true, finalResponse: "ok" })
    const { ctx } = makeCtx(
      makeTeammate({ config: { runtime: "codex-app-server", model: "gpt-5.6-sol" } })
    )

    await dispatchTeammate(ctx, { taskId: "t1", prompt: "edit code" })

    expect(externalExecuteMock).toHaveBeenCalledWith(
      "agent-1",
      "edit code",
      expect.objectContaining({ model: "gpt-5.6-sol" })
    )
  })

  it("falls back to the run's model hint when the teammate pins no model", async () => {
    isTauriMock.mockReturnValue(true)
    resolveExternalMock.mockResolvedValue("agent-1")
    externalExecuteMock.mockResolvedValue({ success: true, finalResponse: "ok" })
    const { ctx } = makeCtx(makeTeammate({ config: { runtime: "codex" } }), {}, "gpt-5.6-codex")

    await dispatchTeammate(ctx, { taskId: "t1", prompt: "edit code" })

    expect(externalExecuteMock).toHaveBeenCalledWith(
      "agent-1",
      "edit code",
      expect.objectContaining({ model: "gpt-5.6-codex" })
    )
  })

  it("prefers the teammate's model over the run's hint", async () => {
    isTauriMock.mockReturnValue(true)
    resolveExternalMock.mockResolvedValue("agent-1")
    externalExecuteMock.mockResolvedValue({ success: true, finalResponse: "ok" })
    const { ctx } = makeCtx(
      makeTeammate({ config: { runtime: "codex", model: "gpt-5.6-sol" } }),
      {},
      "gpt-5.6-codex"
    )

    await dispatchTeammate(ctx, { taskId: "t1", prompt: "edit code" })

    expect(externalExecuteMock).toHaveBeenCalledWith(
      "agent-1",
      "edit code",
      expect.objectContaining({ model: "gpt-5.6-sol" })
    )
  })

  it("sends no model when neither the teammate nor the run picks one", async () => {
    // The agent then keeps whatever its own config.toml selects.
    isTauriMock.mockReturnValue(true)
    resolveExternalMock.mockResolvedValue("agent-1")
    externalExecuteMock.mockResolvedValue({ success: true, finalResponse: "ok" })
    const { ctx } = makeCtx(makeTeammate({ config: { runtime: "codex" } }))

    await dispatchTeammate(ctx, { taskId: "t1", prompt: "edit code" })

    const opts = externalExecuteMock.mock.calls[0]?.[2] as Record<string, unknown>
    expect(opts).not.toHaveProperty("model")
  })

  it("records a failure when the external agent returns success=false", async () => {
    isTauriMock.mockReturnValue(true)
    resolveExternalMock.mockResolvedValue("agent-1")
    externalExecuteMock.mockResolvedValue({ success: false, error: "spawn failed" })
    const { ctx, pool } = makeCtx(makeTeammate({ config: { runtime: "codex" } }))

    await expect(dispatchTeammate(ctx, { taskId: "t1", prompt: "x" })).rejects.toThrow(
      "spawn failed"
    )
    expect(pool.recordFailure).toHaveBeenCalled()
  })

  it("honours preferToolEnabled=false even on desktop", async () => {
    isTauriMock.mockReturnValue(true)
    executeAgentMock.mockResolvedValue({ text: "pure reasoning" })
    const { ctx } = makeCtx(makeTeammate())

    const result = await dispatchTeammate(ctx, {
      taskId: "t1",
      prompt: "reason only",
      preferToolEnabled: false,
    })

    expect(result.channel).toBe("text")
    expect(runAndCaptureMock).not.toHaveBeenCalled()
  })

  it("warns (never silently) and falls back when the external runtime is unavailable", async () => {
    // Non-claude runtime, but no external agent resolves (web/mobile or the CLI
    // is not installed). The task must NOT silently run as the built-in engine
    // without telling the user their chosen runtime was dropped.
    isTauriMock.mockReturnValue(false)
    resolveExternalMock.mockResolvedValue(null)
    executeAgentMock.mockResolvedValue({ text: "fallback answer" })
    const { ctx, notifier } = makeCtx(makeTeammate({ config: { runtime: "codex" } }))

    const result = await dispatchTeammate(ctx, { taskId: "t1", prompt: "go" })

    expect(result.channel).toBe("text")
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        title: "External runtime unavailable",
        dedupeKey: "external-fallback:run1:tm1",
      })
    )
  })

  it("forwards the teammate's resolved MCP servers into the external session", async () => {
    isTauriMock.mockReturnValue(true)
    resolveExternalMock.mockResolvedValue("agent-1")
    resolveAcpMcpMock.mockResolvedValue([{ name: "fs", command: "fs", args: [] }])
    externalExecuteMock.mockResolvedValue({ success: true, finalResponse: "ok" })
    const { ctx } = makeCtx(makeTeammate({ config: { runtime: "codex" } }))

    await dispatchTeammate(ctx, { taskId: "t1", prompt: "go" })

    expect(externalExecuteMock.mock.calls[0][2]).toMatchObject({
      context: { custom: { mcpServers: [{ name: "fs", command: "fs", args: [] }] } },
    })
  })

  it("omits the MCP context when the teammate resolves no servers", async () => {
    isTauriMock.mockReturnValue(true)
    resolveExternalMock.mockResolvedValue("agent-1")
    resolveAcpMcpMock.mockResolvedValue([])
    externalExecuteMock.mockResolvedValue({ success: true, finalResponse: "ok" })
    const { ctx } = makeCtx(makeTeammate({ config: { runtime: "codex" } }))

    await dispatchTeammate(ctx, { taskId: "t1", prompt: "go" })

    expect(externalExecuteMock.mock.calls[0][2]).not.toHaveProperty("context")
  })

  it("streams external tool activity into the progress reporter", async () => {
    isTauriMock.mockReturnValue(true)
    resolveExternalMock.mockResolvedValue("agent-1")
    resolveAcpMcpMock.mockResolvedValue([])
    externalExecuteMock.mockImplementation(async (_id: unknown, _p: unknown, opts: unknown) => {
      ;(opts as { onEvent?: (e: unknown) => void }).onEvent?.({
        type: "tool_use_start",
        timestamp: new Date(),
        toolUseId: "x",
        toolName: "Bash",
      })
      return { success: true, finalResponse: "done" }
    })
    const { ctx, storeWriter } = makeCtx(makeTeammate({ config: { runtime: "codex" } }))
    const addEvent = jest.fn()
    ;(storeWriter as { addEvent?: unknown }).addEvent = addEvent

    await dispatchTeammate(ctx, { taskId: "t1", prompt: "go" })

    const frames = addEvent.mock.calls.map(
      (c) => c[0] as { type: string; data?: { channel?: string; toolCount?: number } }
    )
    expect(
      frames.some(
        (f) =>
          f.type === "progress_update" &&
          f.data?.channel === "external" &&
          (f.data?.toolCount ?? 0) >= 1
      )
    ).toBe(true)
  })
})

describe("dispatchTeammate — team permission ceiling", () => {
  it("clamps the sidecar path: team ceiling flows into resolveSendOptions", async () => {
    isTauriMock.mockReturnValue(true)
    createSessionMock.mockResolvedValue({ id: "sess1" })
    getSessionMock.mockResolvedValue({ id: "sess1", kind: "team" })
    runAndCaptureMock.mockResolvedValue({ text: "ok", messageId: "m1" })
    const { ctx } = makeCtx(makeTeammate({ config: { tools: ["Read", "Bash"] } }), {
      allowedTools: ["Read"],
      disallowedTools: ["Write"],
    })

    await dispatchTeammate(ctx, { taskId: "t1", prompt: "go" })

    expect(resolveSendOptionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        permissionCeiling: { allowedTools: ["Read"], disallowedTools: ["Write"] },
      })
    )
  })

  it("omits the ceiling on the sidecar path when the team expresses none", async () => {
    isTauriMock.mockReturnValue(true)
    createSessionMock.mockResolvedValue({ id: "sess1" })
    getSessionMock.mockResolvedValue({ id: "sess1", kind: "team" })
    runAndCaptureMock.mockResolvedValue({ text: "ok", messageId: "m1" })
    const { ctx } = makeCtx(makeTeammate())

    await dispatchTeammate(ctx, { taskId: "t1", prompt: "go" })

    expect(resolveSendOptionsMock.mock.calls[0][0]).not.toHaveProperty("permissionCeiling")
  })

  it("clamps the external path: team mode ceiling caps the teammate", async () => {
    isTauriMock.mockReturnValue(true)
    resolveExternalMock.mockResolvedValue("agent-1")
    externalExecuteMock.mockResolvedValue({ success: true, finalResponse: "out" })
    const { ctx } = makeCtx(makeTeammate({ config: { runtime: "claude-code" } }), {
      defaultPermissionMode: "plan",
    })

    await dispatchTeammate(ctx, { taskId: "t1", prompt: "go" })

    expect(externalExecuteMock).toHaveBeenCalledWith(
      "agent-1",
      "go",
      expect.objectContaining({ permissionMode: "plan" })
    )
  })
})

describe("dispatchTeammate — failures + validation", () => {
  it("throws (retryable) when no teammate is available", async () => {
    const { ctx, pool } = makeCtx(null)
    await expect(dispatchTeammate(ctx, { taskId: "t1", prompt: "x" })).rejects.toThrow(
      /no available teammate/
    )
    expect(pool.recordSuccess).not.toHaveBeenCalled()
  })

  it("records a breaker failure + fires onAgentError when the LLM throws", async () => {
    executeAgentMock.mockRejectedValue(new Error("boom"))
    const { ctx, pool, storeWriter } = makeCtx(makeTeammate())

    await expect(
      dispatchTeammate(ctx, { taskId: "t1", prompt: "x", recordToStore: true })
    ).rejects.toThrow("boom")

    expect(pool.recordFailure).toHaveBeenCalledWith("tm1", expect.any(Error))
    expect(storeWriter.setTaskStatus).toHaveBeenCalledWith("t1", "failed", undefined, "boom")
    expect(hookFns.dispatchOnAgentError).toHaveBeenCalledTimes(1)
    expect(mockedBusEmit).toHaveBeenCalledWith(
      SystemEvents.AGENT_ERROR,
      // Bounded error class only — the "boom" message must NOT reach the bus.
      expect.objectContaining({ agentId: "tm1", error: "Error" })
    )
  })

  it("schedules a guarded resume on a rate-limit failure when the controller is present", async () => {
    executeAgentMock.mockRejectedValue(new Error("429 rate limit exceeded, retry after 30s"))
    const { ctx } = makeCtx(makeTeammate())
    const onRateLimit = jest.fn()
    ;(ctx as unknown as { rateLimitResume: unknown }).rateLimitResume = { onRateLimit }

    await expect(dispatchTeammate(ctx, { taskId: "t9", prompt: "x" })).rejects.toThrow(/rate limit/)

    expect(onRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: "tm1", retryAfterMs: 30_000 })
    )
  })

  it("does not schedule a resume for a non-rate-limit failure", async () => {
    executeAgentMock.mockRejectedValue(new Error("boom"))
    const { ctx } = makeCtx(makeTeammate())
    const onRateLimit = jest.fn()
    ;(ctx as unknown as { rateLimitResume: unknown }).rateLimitResume = { onRateLimit }

    await expect(dispatchTeammate(ctx, { taskId: "t1", prompt: "x" })).rejects.toThrow("boom")
    expect(onRateLimit).not.toHaveBeenCalled()
  })

  it("rejects empty output as EMPTY_OUTPUT and records failure", async () => {
    executeAgentMock.mockResolvedValue({ text: "   " })
    const { ctx, pool } = makeCtx(makeTeammate())

    await expect(dispatchTeammate(ctx, { taskId: "t1", prompt: "x" })).rejects.toThrow(
      /EMPTY_OUTPUT/
    )
    expect(pool.recordFailure).toHaveBeenCalledWith("tm1", expect.any(Error))
  })

  it("enforces minOutputChars", async () => {
    executeAgentMock.mockResolvedValue({ text: "hi" })
    const { ctx } = makeCtx(makeTeammate(), { minOutputChars: 10 })
    await expect(dispatchTeammate(ctx, { taskId: "t1", prompt: "x" })).rejects.toThrow(
      /minOutputChars=10/
    )
  })

  it("skips validation when validateOutput=false", async () => {
    executeAgentMock.mockResolvedValue({ text: "" })
    const { ctx, pool } = makeCtx(makeTeammate())
    const result = await dispatchTeammate(ctx, {
      taskId: "t1",
      prompt: "x",
      validateOutput: false,
    })
    expect(result.text).toBe("")
    expect(pool.recordSuccess).toHaveBeenCalled()
  })
})

describe("dispatchTeammate — usage + signal", () => {
  it("accumulates valid token usage onto the budget", async () => {
    executeAgentMock.mockResolvedValue({
      text: "ok",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    })
    const { ctx } = makeCtx(makeTeammate())
    const result = await dispatchTeammate(ctx, { taskId: "t1", prompt: "x" })
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 })
    expect((ctx.budget as unknown as { add: jest.Mock }).add).toHaveBeenCalledWith({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    })
  })

  it("ignores a malformed usage object", async () => {
    executeAgentMock.mockResolvedValue({ text: "ok", usage: { promptTokens: "nan" } })
    const { ctx } = makeCtx(makeTeammate())
    const result = await dispatchTeammate(ctx, { taskId: "t1", prompt: "x" })
    expect(result.usage).toBeUndefined()
    expect((ctx.budget as unknown as { add: jest.Mock }).add).not.toHaveBeenCalled()
  })

  it("combines an explicit caller signal with the per-task timeout", async () => {
    executeAgentMock.mockResolvedValue({ text: "ok" })
    const { ctx } = makeCtx(makeTeammate())
    const signal = new AbortController().signal
    const result = await dispatchTeammate(ctx, { taskId: "t1", prompt: "x", signal })
    expect(result.text).toBe("ok")
    // executeAgent received a combined (non-null) abort signal.
    const opts = executeAgentMock.mock.calls[0][1] as { abortSignal?: AbortSignal }
    expect(opts.abortSignal).toBeInstanceOf(AbortSignal)
  })

  it("respects an explicit timeoutMs override", async () => {
    executeAgentMock.mockResolvedValue({ text: "ok" })
    const { ctx } = makeCtx(makeTeammate())
    const result = await dispatchTeammate(ctx, { taskId: "t1", prompt: "x", timeoutMs: 1000 })
    expect(result.text).toBe("ok")
  })
})

describe("dispatchTeammate — store recording on validation failure", () => {
  it("writes a failed status when empty output + recordToStore", async () => {
    executeAgentMock.mockResolvedValue({ text: "" })
    const { ctx, storeWriter } = makeCtx(makeTeammate())
    await expect(
      dispatchTeammate(ctx, { taskId: "t1", prompt: "x", recordToStore: true })
    ).rejects.toThrow(/EMPTY_OUTPUT/)
    expect(storeWriter.setTaskStatus).toHaveBeenCalledWith(
      "t1",
      "failed",
      undefined,
      expect.stringContaining("EMPTY_OUTPUT")
    )
  })

  it("writes a failed status when below minOutputChars + recordToStore", async () => {
    executeAgentMock.mockResolvedValue({ text: "hi" })
    const { ctx, storeWriter } = makeCtx(makeTeammate(), { minOutputChars: 10 })
    await expect(
      dispatchTeammate(ctx, { taskId: "t1", prompt: "x", recordToStore: true })
    ).rejects.toThrow(/minOutputChars/)
    expect(storeWriter.setTaskStatus).toHaveBeenCalledWith(
      "t1",
      "failed",
      undefined,
      expect.stringContaining("minOutputChars")
    )
  })
})

describe("dispatchTeammate — store recording", () => {
  it("writes a result_share message + completed status when recordToStore", async () => {
    executeAgentMock.mockResolvedValue({ text: "deliverable" })
    const { ctx, storeWriter } = makeCtx(makeTeammate())

    await dispatchTeammate(ctx, { taskId: "t1", prompt: "x", recordToStore: true })

    expect(storeWriter.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "result_share", taskId: "t1", content: "deliverable" })
    )
    expect(storeWriter.setTaskStatus).toHaveBeenCalledWith("t1", "completed", "deliverable")
  })

  it("routes auto-success to review when requireResultReview is on", async () => {
    executeAgentMock.mockResolvedValue({ text: "deliverable" })
    const { ctx, storeWriter } = makeCtx(makeTeammate(), {
      governancePolicy: {
        approval: {
          requirePlanApproval: false,
          requireDelegationApproval: false,
          requireResultReview: true,
        },
      },
    } as never)

    await dispatchTeammate(ctx, { taskId: "t1", prompt: "x", recordToStore: true })

    expect(storeWriter.setTaskStatus).toHaveBeenCalledWith("t1", "review", "deliverable")
  })

  it("keeps the direct completed path when requireResultReview is off/absent", async () => {
    executeAgentMock.mockResolvedValue({ text: "deliverable" })
    const { ctx, storeWriter } = makeCtx(makeTeammate(), {
      governancePolicy: {
        approval: { requirePlanApproval: false, requireDelegationApproval: false },
      },
    } as never)

    await dispatchTeammate(ctx, { taskId: "t1", prompt: "x", recordToStore: true })

    expect(storeWriter.setTaskStatus).toHaveBeenCalledWith("t1", "completed", "deliverable")
  })

  it("does not touch the store when recordToStore is omitted", async () => {
    executeAgentMock.mockResolvedValue({ text: "x" })
    const { ctx, storeWriter } = makeCtx(makeTeammate())
    await dispatchTeammate(ctx, { taskId: "t1", prompt: "x" })
    expect(storeWriter.addMessage).not.toHaveBeenCalled()
    expect(storeWriter.setTaskStatus).not.toHaveBeenCalled()
  })
})

describe("dispatchTeammate — progress streaming", () => {
  function withEvents(ctx: TeamRunContext) {
    const addEvent = jest.fn()
    ;(ctx.storeWriter as unknown as { addEvent: jest.Mock }).addEvent = addEvent
    return addEvent
  }
  const phasesOf = (m: jest.Mock) =>
    m.mock.calls.map((c) => (c[0] as { data?: { phase?: string } }).data?.phase)

  it("emits start + done progress frames on a successful text run", async () => {
    executeAgentMock.mockResolvedValue({ text: "answer" })
    const { ctx } = makeCtx(makeTeammate())
    const addEvent = withEvents(ctx)

    await dispatchTeammate(ctx, { taskId: "t1", prompt: "x" })

    const phases = phasesOf(addEvent)
    expect(phases).toContain("start")
    expect(phases).toContain("done")
    expect(addEvent.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ type: "progress_update", taskId: "t1", teamId: "team1" })
    )
  })

  it("forwards sidecar capture events as running frames when streamProgress on", async () => {
    isTauriMock.mockReturnValue(true)
    createSessionMock.mockResolvedValue({ id: "sess1" })
    getSessionMock.mockResolvedValue({ id: "sess1", kind: "team" })
    runAndCaptureMock.mockImplementation(
      async (_id: string, _p: string, _o: unknown, cap: { onEvent?: (e: unknown) => void }) => {
        cap.onEvent?.({ type: "tool-call", toolName: "Bash", input: {} })
        return { text: "tool result" }
      }
    )
    const { ctx } = makeCtx(makeTeammate())
    const addEvent = withEvents(ctx)

    await dispatchTeammate(ctx, { taskId: "t1", prompt: "go" })

    const phases = phasesOf(addEvent)
    expect(phases).toContain("running")
    const running = addEvent.mock.calls.find(
      (c) => (c[0] as { data?: { phase?: string } }).data?.phase === "running"
    )!
    expect((running[0] as { data: { currentTool: string } }).data.currentTool).toBe("Bash")
  })

  it("does not thread capture events when streamProgress is false (markers only)", async () => {
    isTauriMock.mockReturnValue(true)
    createSessionMock.mockResolvedValue({ id: "sess1" })
    getSessionMock.mockResolvedValue({ id: "sess1", kind: "team" })
    const onEventSpy = jest.fn()
    runAndCaptureMock.mockImplementation(
      async (_id: string, _p: string, _o: unknown, cap: { onEvent?: unknown }) => {
        if (cap.onEvent) onEventSpy()
        return { text: "tool result" }
      }
    )
    const { ctx } = makeCtx(makeTeammate(), { streamProgress: false })
    const addEvent = withEvents(ctx)

    await dispatchTeammate(ctx, { taskId: "t1", prompt: "go" })

    // No onEvent callback passed to the sidecar runner.
    expect(onEventSpy).not.toHaveBeenCalled()
    // But start/done markers still fire so the panel reflects completion.
    const phases = phasesOf(addEvent)
    expect(phases).toEqual(expect.arrayContaining(["start", "done"]))
    expect(phases).not.toContain("running")
  })

  it("emits a failed frame when the run throws", async () => {
    executeAgentMock.mockRejectedValue(new Error("boom"))
    const { ctx } = makeCtx(makeTeammate())
    const addEvent = withEvents(ctx)

    await expect(dispatchTeammate(ctx, { taskId: "t1", prompt: "x" })).rejects.toThrow("boom")

    expect(phasesOf(addEvent)).toContain("failed")
  })

  it("emits no progress events when the store has no addEvent sink", async () => {
    executeAgentMock.mockResolvedValue({ text: "answer" })
    const { ctx, storeWriter } = makeCtx(makeTeammate())
    await dispatchTeammate(ctx, { taskId: "t1", prompt: "x" })
    expect((storeWriter as Record<string, unknown>).addEvent).toBeUndefined()
  })
})

describe("dispatchTeammate — twin-backed teammate (ADR-0003)", () => {
  const twinDepsFixture = { store: {}, embedding: { provider: "openai", model: "m", apiKey: "k" } }

  function withTwinDeps(ctx: TeamRunContext, deps: unknown = twinDepsFixture): void {
    ;(ctx as unknown as { twinDeps: unknown }).twinDeps = deps
  }

  it("threads twinDeps + the dispatch prompt into resolveSendOptions on the sidecar path", async () => {
    isTauriMock.mockReturnValue(true)
    createSessionMock.mockResolvedValue({ id: "sess1" })
    getSessionMock.mockResolvedValue({ id: "sess1", kind: "team" })
    runAndCaptureMock.mockResolvedValue({ text: "ok", messageId: "m1" })
    const { ctx } = makeCtx(makeTeammate({ config: { twinId: "twin-1" } }))
    withTwinDeps(ctx)

    await dispatchTeammate(ctx, { taskId: "t1", prompt: "edit code" })

    expect(resolveSendOptionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        twinDeps: twinDepsFixture,
        twinUserMessage: "edit code",
        twinInjectSource: "team",
      })
    )
  })

  it("omits twin fields from resolveSendOptions when the teammate has no twinId", async () => {
    isTauriMock.mockReturnValue(true)
    createSessionMock.mockResolvedValue({ id: "sess1" })
    getSessionMock.mockResolvedValue({ id: "sess1", kind: "team" })
    runAndCaptureMock.mockResolvedValue({ text: "ok", messageId: "m1" })
    const { ctx } = makeCtx(makeTeammate())
    withTwinDeps(ctx)

    await dispatchTeammate(ctx, { taskId: "t1", prompt: "edit code" })

    const opts = resolveSendOptionsMock.mock.calls[0][0]
    expect(opts).not.toHaveProperty("twinDeps")
    expect(opts).not.toHaveProperty("twinUserMessage")
    expect(opts).not.toHaveProperty("twinInjectSource")
  })

  it("omits twin fields from resolveSendOptions when the run built no twinDeps", async () => {
    isTauriMock.mockReturnValue(true)
    createSessionMock.mockResolvedValue({ id: "sess1" })
    getSessionMock.mockResolvedValue({ id: "sess1", kind: "team" })
    runAndCaptureMock.mockResolvedValue({ text: "ok", messageId: "m1" })
    const { ctx } = makeCtx(makeTeammate({ config: { twinId: "twin-1" } }))
    // No twinDeps on the run context.

    await dispatchTeammate(ctx, { taskId: "t1", prompt: "edit code" })

    const opts = resolveSendOptionsMock.mock.calls[0][0]
    expect(opts).not.toHaveProperty("twinDeps")
  })

  it("invokes applyTeammateTwinContext on the text-only channel when twin-bound with twinDeps", async () => {
    isTauriMock.mockReturnValue(false)
    applyTeammateTwinContextMock.mockResolvedValue({
      systemPrompt: "twin-injected system prompt",
      applied: true,
    })
    executeAgentMock.mockResolvedValue({ text: "ok" })
    const { ctx } = makeCtx(makeTeammate({ config: { twinId: "twin-1" } }))
    withTwinDeps(ctx)

    await dispatchTeammate(ctx, { taskId: "t1", prompt: "reason about this" })

    expect(applyTeammateTwinContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actorName: "Worker",
        userPrompt: "reason about this",
        twinId: "twin-1",
        twinDeps: twinDepsFixture,
        source: "team",
      })
    )
    expect(executeAgentMock).toHaveBeenCalledWith(
      "reason about this",
      expect.objectContaining({ systemPrompt: "twin-injected system prompt" })
    )
  })

  it("does not invoke applyTeammateTwinContext on the text-only channel when the teammate isn't twin-bound", async () => {
    isTauriMock.mockReturnValue(false)
    executeAgentMock.mockResolvedValue({ text: "ok" })
    const { ctx } = makeCtx(makeTeammate())
    withTwinDeps(ctx)

    await dispatchTeammate(ctx, { taskId: "t1", prompt: "reason about this" })

    expect(applyTeammateTwinContextMock).not.toHaveBeenCalled()
    expect(executeAgentMock).toHaveBeenCalledWith(
      "reason about this",
      expect.objectContaining({ systemPrompt: expect.any(String) })
    )
  })

  it("does not invoke applyTeammateTwinContext on the text-only channel when the run built no twinDeps", async () => {
    isTauriMock.mockReturnValue(false)
    executeAgentMock.mockResolvedValue({ text: "ok" })
    const { ctx } = makeCtx(makeTeammate({ config: { twinId: "twin-1" } }))
    // No twinDeps on the run context.

    await dispatchTeammate(ctx, { taskId: "t1", prompt: "reason about this" })

    expect(applyTeammateTwinContextMock).not.toHaveBeenCalled()
  })
})

describe("dispatchTeammate — workspace isolation", () => {
  function withAllocator(
    ctx: TeamRunContext,
    over: { allocate?: jest.Mock; commit?: jest.Mock } = {}
  ) {
    const allocate =
      over.allocate ??
      jest.fn(
        async (a: {
          runId: string
          teammateName: string
          taskId: string
          workspaceKey?: string
        }) => ({
          key: a.workspaceKey ?? a.taskId,
          runId: a.runId,
          teammateName: a.teammateName,
          taskId: a.taskId,
          branch: `agent/${a.runId}/${a.teammateName}/${a.taskId}`,
          path: `/wt/${a.taskId}`,
        })
      )
    const commit = over.commit ?? jest.fn(async () => "sha")
    const ledger = new Map()
    Object.assign(ctx, {
      workspaceAllocator: {
        allocate,
        commit,
        remove: jest.fn(),
        gc: jest.fn(),
        allocated: () => [],
      },
      workspaceLedger: ledger,
    })
    return { allocate, commit, ledger }
  }

  it("allocates a worktree per dispatch and records success + commit", async () => {
    executeAgentMock.mockResolvedValue({ text: "the answer" })
    const { ctx } = makeCtx(makeTeammate({ name: "Alice" }))
    const { allocate, commit, ledger } = withAllocator(ctx)

    await dispatchTeammate(ctx, { taskId: "t1", prompt: "do it" })

    expect(allocate).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run1", teammateName: "Alice", taskId: "t1" })
    )
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "agent/run1/Alice/t1" }),
      expect.stringContaining("Alice")
    )
    expect(ledger.get("t1")).toEqual(
      expect.objectContaining({ ok: true, handle: expect.objectContaining({ taskId: "t1" }) })
    )
  })

  it("uses and settles the shared task workspace when the experiment is enabled", async () => {
    taskWorkspaceEnabledMock.mockReturnValue(true)
    isTauriMock.mockReturnValue(true)
    beginTaskWorkspaceTurnMock.mockResolvedValue({
      runId: "task-run-1",
      executionRoot: "/isolated/task-run-1",
    })
    createSessionMock.mockResolvedValue({ id: "sess1" })
    getSessionMock.mockResolvedValue({ id: "sess1", kind: "team" })
    runAndCaptureMock.mockResolvedValue({ text: "the answer" })
    const { ctx } = makeCtx(makeTeammate({ name: "Alice" }), { workingDir: "/repo" })

    await dispatchTeammate(ctx, { taskId: "t1", prompt: "do it" })

    expect(beginTaskWorkspaceTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "tm1", workspaceRoot: "/repo" })
    )
    expect(createSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ workingDir: "/isolated/task-run-1" })
    )
    expect(settleTaskWorkspaceRunMock).toHaveBeenCalledWith("task-run-1", "ready")
  })

  it("forwards workspaceKey (pipeline sharing) to the allocator", async () => {
    executeAgentMock.mockResolvedValue({ text: "ok" })
    const { ctx } = makeCtx(makeTeammate())
    const { allocate } = withAllocator(ctx)

    await dispatchTeammate(ctx, { taskId: "t1", prompt: "do it", workspaceKey: "pipe" })

    expect(allocate).toHaveBeenCalledWith(expect.objectContaining({ workspaceKey: "pipe" }))
  })

  it("forwards workspaceKey to the task workspace service when the experiment is enabled", async () => {
    taskWorkspaceEnabledMock.mockReturnValue(true)
    isTauriMock.mockReturnValue(true)
    beginTaskWorkspaceTurnMock.mockResolvedValue({
      runId: "task-run-pipeline",
      executionRoot: "/isolated/pipeline",
    })
    createSessionMock.mockResolvedValue({ id: "sess1" })
    getSessionMock.mockResolvedValue({ id: "sess1", kind: "team" })
    runAndCaptureMock.mockResolvedValue({ text: "the answer" })
    const { ctx } = makeCtx(makeTeammate({ name: "Alice" }), { workingDir: "/repo" })

    await dispatchTeammate(ctx, { taskId: "t1", prompt: "do it", workspaceKey: "pipe" })

    expect(beginTaskWorkspaceTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceKey: "pipe" })
    )
  })

  it("is a no-op when no allocator is present (shared-dir behavior)", async () => {
    executeAgentMock.mockResolvedValue({ text: "ok" })
    const { ctx } = makeCtx(makeTeammate())
    // No withAllocator → ctx.workspaceAllocator undefined.
    const result = await dispatchTeammate(ctx, { taskId: "t1", prompt: "do it" })
    expect(result.text).toBe("ok")
  })

  it("fail-closed: an allocation error fails the dispatch and records a failure", async () => {
    executeAgentMock.mockResolvedValue({ text: "ok" })
    const { ctx, pool } = makeCtx(makeTeammate())
    const allocate = jest.fn(async () => {
      throw new Error("git worktree add failed")
    })
    const { ledger } = withAllocator(ctx, { allocate })

    await expect(dispatchTeammate(ctx, { taskId: "t1", prompt: "do it" })).rejects.toThrow(
      /worktree add failed/
    )
    expect(pool.recordFailure).toHaveBeenCalled()
    // Nothing was allocated → no ledger entry, and the model never ran.
    expect(ledger.size).toBe(0)
    expect(executeAgentMock).not.toHaveBeenCalled()
  })

  it("records ok=false in the ledger when the teammate returns empty output", async () => {
    executeAgentMock.mockResolvedValue({ text: "" })
    const { ctx } = makeCtx(makeTeammate())
    const { ledger, commit } = withAllocator(ctx)

    await expect(dispatchTeammate(ctx, { taskId: "t1", prompt: "do it" })).rejects.toThrow(
      /EMPTY_OUTPUT/
    )
    expect(ledger.get("t1")).toEqual(expect.objectContaining({ ok: false }))
    // No commit on a failed turn.
    expect(commit).not.toHaveBeenCalled()
  })
})
