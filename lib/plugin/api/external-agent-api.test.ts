import { runPluginExternalAgent } from "./external-agent-api"
import { pluginHasApiPermission } from "./permission-api"
import { assertOwnedBotWorkspace } from "../workspace/bot-run"
import type { PluginWorkspaceHandle } from "../workspace/acquire"
import { getLiveBotRunSignal } from "@/lib/bot/runtime/run"
import { updateBotInstallation } from "@/lib/db/bot-installations"
import { agentInvoke } from "@/lib/ai/agent/external/agent-transport"

const mockSteps = new Map<string, unknown>()
const mockManager = {
  getAgent: jest.fn(),
  addAgent: jest.fn(),
  execute: jest.fn(),
  createSession: jest.fn(),
  resumeSession: jest.fn(),
  getSession: jest.fn(),
  setSessionModel: jest.fn(),
  getSessionModels: jest.fn(),
}
jest.mock("./permission-api", () => ({ pluginHasApiPermission: jest.fn() }))
jest.mock("@/lib/db/bot-installations", () => ({ updateBotInstallation: jest.fn() }))
jest.mock("@/lib/ai/agent/external/agent-transport", () => ({ agentInvoke: jest.fn() }))
jest.mock("../workspace/bot-run", () => ({
  assertOwnedBotWorkspace: jest.fn(),
  digestBotArtifact: async (value: unknown) => JSON.stringify(value),
}))
jest.mock("@/lib/db/bot-run-steps", () => ({
  getBotRunStep: jest.fn(async (run, name) =>
    mockSteps.has(`${run}:${name}`)
      ? { status: "completed", output: mockSteps.get(`${run}:${name}`) }
      : undefined
  ),
  completeBotRunStep: jest.fn(async (run, name, value) => {
    if (!mockSteps.has(`${run}:${name}`)) mockSteps.set(`${run}:${name}`, value)
  }),
}))
jest.mock("@/lib/ai/agent/external/manager", () => ({ getExternalAgentManager: () => mockManager }))
jest.mock("@/lib/ai/agent/external/presets", () => ({
  createAgentFromPreset: (id: string) =>
    id === "missing"
      ? undefined
      : { id: "preset-id", protocol: "acp", process: { command: "devin", args: ["acp"] } },
}))
jest.mock("@/lib/bot/runtime/run", () => ({ getLiveBotRunSignal: jest.fn() }))
const workspace: PluginWorkspaceHandle = {
  id: "workspace",
  runId: "run",
  root: "/isolated",
  runtimeStateRoot: "/run-state",
  origin: "bot-run",
  ephemeral: true,
}
const options = { runId: "run", workspace, model: "swe-2-medium" }

beforeEach(() => {
  jest.clearAllMocks()
  mockSteps.clear()
  jest.mocked(pluginHasApiPermission).mockReturnValue(true)
  jest.mocked(assertOwnedBotWorkspace).mockResolvedValue({
    binding: { installation: { id: "installation", monitor: { lastSuccessAt: 1 } } },
  } as never)
  jest.mocked(agentInvoke).mockResolvedValue(true)
  jest.mocked(getLiveBotRunSignal).mockReturnValue(undefined)
  mockManager.getAgent.mockReturnValue(undefined)
  mockManager.addAgent.mockImplementation(async (config) => ({ config }))
  mockManager.createSession.mockResolvedValue({ id: "session" })
  mockManager.resumeSession.mockResolvedValue({ id: "session" })
  mockManager.getSessionModels.mockReturnValue({
    status: "ok",
    data: { currentModelId: "swe-2-medium" },
  })
  mockManager.execute.mockImplementation(async () => {
    expect(mockSteps.has("run:__host:external-agent")).toBe(true)
    expect(mockSteps.has("run:__host:external-agent:dispatched")).toBe(true)
    return {
      success: true,
      sessionId: "session",
      finalResponse: "result",
      messages: [],
      steps: [],
      toolCalls: [
        {
          id: "test",
          name: "shell",
          input: { command: "pnpm test" },
          status: "completed",
          result: { exitCode: 0 },
        },
      ],
      duration: 1,
    }
  })
})

it("persists identity before execution, uses owned cwd, and returns host tool evidence", async () => {
  const result = await runPluginExternalAgent("plugin", "devin", "fix issue", {
    ...options,
    workingDirectory: "/forged",
    permissionMode: "bypassPermissions",
    cogniaModel: {} as never,
  })
  expect(result.status).toBe("completed")
  expect(result.text).toBe("result")
  expect(result.toolCalls[0].result).toEqual({ exitCode: 0 })
  expect(mockManager.execute).toHaveBeenCalledWith(
    expect.any(String),
    "fix issue",
    expect.objectContaining({
      workingDirectory: "/isolated",
      permissionMode: "default",
      cogniaModel: null,
      sessionId: "session",
      model: "swe-2-medium",
      timeout: 1_800_000,
    })
  )
})

it("replays completed results without another model dispatch", async () => {
  const first = await runPluginExternalAgent("plugin", "devin", "fix issue", options)
  expect(await runPluginExternalAgent("plugin", "devin", "fix issue", options)).toEqual(first)
  expect(mockManager.execute).toHaveBeenCalledTimes(1)
  await expect(
    runPluginExternalAgent("plugin", "devin", "different task", options)
  ).rejects.toThrow("identity")
})

it("reconnects but never redispatches an uncertain crash outcome", async () => {
  mockManager.execute.mockRejectedValueOnce(new Error("transport lost"))
  await expect(runPluginExternalAgent("plugin", "devin", "fix issue", options)).rejects.toThrow(
    "transport lost"
  )
  const result = await runPluginExternalAgent("plugin", "devin", "fix issue", options)
  expect(result.status).toBe("recovery_required")
  expect(mockManager.resumeSession).toHaveBeenCalledWith(
    expect.any(String),
    "session",
    expect.objectContaining({ cwd: "/isolated" })
  )
  expect(mockManager.execute).toHaveBeenCalledTimes(1)
})

it("does not silently fall back when the agent reports a different model", async () => {
  mockManager.getSessionModels.mockReturnValue({
    status: "ok",
    data: { currentModelId: "swe-1.5" },
  })
  await expect(runPluginExternalAgent("plugin", "devin", "fix", options)).rejects.toThrow("confirm")
  expect(mockManager.execute).not.toHaveBeenCalled()
  await expect(
    runPluginExternalAgent("plugin", "devin", "fix", { ...options, model: "swe-1.5" })
  ).rejects.toThrow("Unsupported")
})

it("rejects absent permission, forged workspace and foreign session", async () => {
  jest.mocked(pluginHasApiPermission).mockReturnValueOnce(false)
  await expect(runPluginExternalAgent("plugin", "devin", "fix", options)).rejects.toThrow(
    "permission"
  )
  await expect(
    runPluginExternalAgent("plugin", "devin", "fix", {
      ...options,
      workspace: { ...workspace, runId: "foreign" },
    })
  ).rejects.toThrow("owned workspace")
  await expect(
    runPluginExternalAgent("plugin", "devin", "fix", { ...options, sessionId: "foreign-session" })
  ).rejects.toThrow("unowned")
  expect(mockManager.execute).not.toHaveBeenCalled()
})

it("honors host cancellation before dispatch and validates timeout before session allocation", async () => {
  jest.mocked(getLiveBotRunSignal).mockReturnValue(AbortSignal.abort())
  await expect(runPluginExternalAgent("plugin", "devin", "fix", options)).rejects.toThrow(
    "cancelled"
  )
  expect(mockManager.createSession).not.toHaveBeenCalled()
  await expect(
    runPluginExternalAgent("plugin", "devin", "fix", { ...options, timeoutMs: -1 })
  ).rejects.toThrow("positive")
})

it("keeps existing non-Bot dispatch callers working", async () => {
  mockManager.execute.mockResolvedValue({
    success: true,
    finalResponse: "legacy",
    sessionId: "legacy",
    messages: [],
    steps: [],
    toolCalls: [],
    duration: 1,
  })
  expect((await runPluginExternalAgent("plugin", "devin", "legacy")).text).toBe("legacy")
  expect(mockManager.execute).toHaveBeenCalledWith("preset-id", "legacy", {})
})

it("continues an owned session in an explicitly named later repair turn", async () => {
  mockManager.execute.mockResolvedValue({
    success: true,
    finalResponse: "result",
    sessionId: "session",
    messages: [],
    steps: [],
    toolCalls: [],
    duration: 1,
  })
  await runPluginExternalAgent("plugin", "devin", "first repair", {
    ...options,
    invocationId: "repair-0",
  })
  await runPluginExternalAgent("plugin", "devin", "fix test failures", {
    ...options,
    invocationId: "repair-1",
    sessionId: "session",
  })
  expect(mockManager.createSession).toHaveBeenCalledTimes(1)
  expect(mockManager.execute).toHaveBeenCalledTimes(2)
  expect(mockSteps.has("run:__host:external-agent:repair-1:result")).toBe(true)
})

it("rejects concurrent dispatch, missing models and invalid invocation ids", async () => {
  let finish: (() => void) | undefined
  mockManager.execute.mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return {
      success: true,
      sessionId: "session",
      finalResponse: "",
      messages: [],
      steps: [],
      toolCalls: [],
      duration: 1,
    }
  })
  const first = runPluginExternalAgent("plugin", "devin", "fix", options)
  await expect(runPluginExternalAgent("plugin", "devin", "fix", options)).rejects.toThrow(
    "already active"
  )
  while (!finish) await new Promise((resolve) => setTimeout(resolve, 0))
  finish()
  await first
  await expect(
    runPluginExternalAgent("plugin", "devin", "fix", { ...options, model: undefined })
  ).rejects.toThrow("explicit model")
  await expect(
    runPluginExternalAgent("plugin", "devin", "fix", { ...options, invocationId: "../escape" })
  ).rejects.toThrow("invocation")
})

it("refuses a model surface without confirmation and preserves failed execution state", async () => {
  mockManager.getSessionModels.mockReturnValueOnce({ status: "unsupported" })
  await expect(runPluginExternalAgent("plugin", "devin", "fix", options)).rejects.toThrow("offer")
  mockManager.getSession.mockReturnValue({ id: "session" })
  mockManager.execute.mockResolvedValueOnce({
    success: false,
    finalResponse: "failed",
    sessionId: "session",
    messages: [],
    steps: [],
    toolCalls: [],
    duration: 1,
    error: "check failed",
  })
  expect((await runPluginExternalAgent("plugin", "devin", "fix", options)).status).toBe("failed")
})

it("validates legacy caller input and preserves failed or cancelled legacy results", async () => {
  await expect(runPluginExternalAgent("plugin", "", "prompt")).rejects.toThrow("required")
  await expect(runPluginExternalAgent("plugin", "devin", " ")).rejects.toThrow("required")
  await expect(runPluginExternalAgent("plugin", "devin", "prompt", { workspace })).rejects.toThrow(
    "requires a Bot"
  )
  await expect(runPluginExternalAgent("plugin", "missing", "prompt")).rejects.toThrow(
    "no live agent"
  )
  mockManager.getAgent.mockReturnValue({ id: "live" })
  mockManager.execute.mockResolvedValue({
    success: false,
    finalResponse: "failure",
    sessionId: "legacy",
    messages: [],
    steps: [],
    toolCalls: [],
    duration: 1,
  })
  expect((await runPluginExternalAgent("plugin", "live", "prompt")).status).toBe("failed")
  expect(
    (await runPluginExternalAgent("plugin", "live", "prompt", { signal: AbortSignal.abort() }))
      .status
  ).toBe("cancelled")
})

it("refuses missing runtime isolation and foreign explicit replay sessions", async () => {
  await expect(
    runPluginExternalAgent("plugin", "devin", "fix", {
      ...options,
      workspace: { ...workspace, runtimeStateRoot: undefined },
    })
  ).rejects.toThrow("isolated runtime")
  await runPluginExternalAgent("plugin", "devin", "fix", options)
  await expect(
    runPluginExternalAgent("plugin", "devin", "fix", { ...options, sessionId: "foreign" })
  ).rejects.toThrow("identity")
})

it("redacts outbound PII before persisting replay identity and disables uncertain automatic retries", async () => {
  const prompt = "Investigate the issue reported by alice@example.com"
  const first = await runPluginExternalAgent("plugin", "devin", prompt, options)
  const sanitized = mockManager.execute.mock.calls[0][1]
  expect(sanitized).not.toContain("alice@example.com")
  expect(sanitized).toContain("Investigate the issue")
  expect(JSON.stringify(mockSteps.get("run:__host:external-agent"))).not.toContain(
    "alice@example.com"
  )
  expect(mockManager.addAgent).toHaveBeenCalledWith(
    expect.objectContaining({ retryConfig: expect.objectContaining({ maxRetries: 0 }) })
  )
  expect(await runPluginExternalAgent("plugin", "devin", prompt, options)).toEqual(first)
  expect(mockManager.execute).toHaveBeenCalledTimes(1)
})

it("marks permanently unavailable executables and advertised models needs_setup before prompt dispatch", async () => {
  jest.mocked(agentInvoke).mockResolvedValueOnce(false)
  await expect(runPluginExternalAgent("plugin", "devin", "fix issue", options)).rejects.toThrow(
    "executable is unavailable"
  )
  expect(updateBotInstallation).toHaveBeenCalledWith("installation", {
    status: "needs_setup",
    monitor: { lastSuccessAt: 1, lastError: expect.stringContaining("unavailable") },
  })
  expect(mockManager.execute).not.toHaveBeenCalled()
  jest.mocked(updateBotInstallation).mockClear()
  mockManager.getSessionModels.mockReturnValue({
    status: "ok",
    data: { currentModelId: "other", availableModels: [{ modelId: "other", name: "Other" }] },
  })
  await expect(runPluginExternalAgent("plugin", "devin", "fix issue", options)).rejects.toThrow(
    "does not offer"
  )
  expect(updateBotInstallation).toHaveBeenCalledWith(
    "installation",
    expect.objectContaining({ status: "needs_setup" })
  )
  expect(mockManager.setSessionModel).not.toHaveBeenCalled()
})

it("does not turn transient runtime probe failures into permanent setup state", async () => {
  jest.mocked(agentInvoke).mockRejectedValueOnce(new Error("host connection interrupted"))
  await expect(runPluginExternalAgent("plugin", "devin", "fix issue", options)).rejects.toThrow(
    "connection interrupted"
  )
  expect(updateBotInstallation).not.toHaveBeenCalled()
})

it("preserves transient model-discovery errors without disabling an otherwise configured installation", async () => {
  mockManager.getSessionModels.mockReturnValue({
    status: "error",
    error: new Error("model discovery connection lost"),
  })
  await expect(runPluginExternalAgent("plugin", "devin", "fix issue", options)).rejects.toThrow(
    "connection lost"
  )
  expect(updateBotInstallation).not.toHaveBeenCalled()
  expect(mockManager.execute).not.toHaveBeenCalled()
})
