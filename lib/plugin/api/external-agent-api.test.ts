import { runPluginExternalAgent } from "./external-agent-api"
import { pluginHasApiPermission } from "./permission-api"
import { assertOwnedBotWorkspace } from "../workspace/bot-run"
import type { PluginWorkspaceHandle } from "../workspace/acquire"
import { getLiveBotRunSignal } from "@/lib/bot/runtime/run"
import { updateBotInstallation } from "@/lib/db/bot-installations"
import { agentInvoke } from "@/lib/ai/agent/external/agent-transport"
import { createBotStepApi } from "@/lib/bot/runtime/step"
import { expireRunInterruptFromSource } from "@/lib/execution/run-control"
import { resolveOwnedBotAuthority } from "@/lib/bot/policy/run-authority"
import type {
  ExternalAgentExecutionOptions,
  ExternalAgentPermissionRequestEvent,
} from "@/types/agent/external-agent"

const mockSteps = new Map<string, unknown>()
const mockAgents = new Map<string, { config: { id: string } }>()
const mockManager = {
  getAgent: jest.fn(),
  addAgent: jest.fn(),
  removeAgent: jest.fn(),
  execute: jest.fn(),
  createSession: jest.fn(),
  resumeSession: jest.fn(),
  getSession: jest.fn(),
  setSessionModel: jest.fn(),
  setSessionMode: jest.fn(),
  getSessionModels: jest.fn(),
  respondToPermission: jest.fn(),
}
const mockApproval = jest.fn()
jest.mock("@/lib/bot/runtime/step", () => ({
  createBotStepApi: jest.fn(() => ({
    waitForApproval: (...args: unknown[]) => mockApproval(...args),
  })),
  botApprovalInterruptId: (runId: string, step: string) => `approval:${runId}:${step}`,
}))
jest.mock("@/lib/execution/run-control", () => ({ expireRunInterruptFromSource: jest.fn() }))
jest.mock("@/lib/bot/policy/run-authority", () => ({ resolveOwnedBotAuthority: jest.fn() }))
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
  mockAgents.clear()
  jest.mocked(pluginHasApiPermission).mockReturnValue(true)
  jest.mocked(assertOwnedBotWorkspace).mockResolvedValue({
    binding: { installation: { id: "installation", monitor: { lastSuccessAt: 1 } } },
  } as never)
  jest.mocked(agentInvoke).mockResolvedValue(true)
  jest
    .mocked(resolveOwnedBotAuthority)
    .mockResolvedValue({ grant: {}, effectivePolicy: {} } as never)
  jest.mocked(getLiveBotRunSignal).mockReturnValue(undefined)
  mockManager.getAgent.mockImplementation((id) => mockAgents.get(id))
  mockManager.getSession.mockReturnValue(undefined)
  mockManager.respondToPermission.mockResolvedValue(undefined)
  mockApproval.mockResolvedValue({ outcome: "denied" })
  jest.mocked(expireRunInterruptFromSource).mockResolvedValue(undefined as never)
  mockManager.addAgent.mockImplementation(async (config) => {
    if (mockAgents.size >= 10) throw new Error("Maximum connections reached: 10")
    const instance = { config }
    mockAgents.set(config.id, instance)
    return instance
  })
  mockManager.removeAgent.mockImplementation(async (id) => {
    mockAgents.delete(id)
    mockManager.getSession.mockReturnValue(undefined)
  })
  mockManager.createSession.mockResolvedValue({ id: "session" })
  mockManager.resumeSession.mockResolvedValue({ id: "session" })
  mockManager.setSessionMode.mockImplementation(async (_agent, _session, mode) => {
    if (mode === "bypassPermissions")
      mockManager.getSession.mockReturnValue({ id: "session", permissionMode: mode })
  })
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
      permissionMode: "acceptEdits",
      cogniaModel: null,
      sessionId: "session",
      model: "swe-2-medium",
      timeout: 1_800_000,
    })
  )
  expect(mockManager.createSession).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ permissionMode: "acceptEdits", mcpServers: [] })
  )
  expect(mockManager.setSessionMode).toHaveBeenCalledWith(
    expect.any(String),
    "session",
    "acceptEdits"
  )
  expect(mockManager.removeAgent).toHaveBeenCalledWith(result.agentId)
  expect(mockAgents.size).toBe(0)
  expect(mockSteps.has("run:__host:external-agent:result")).toBe(true)
})

it("releases more than ten sequential transient agents only after checkpointing each result", async () => {
  mockManager.removeAgent.mockImplementation(async (id) => {
    const checkpoints = [...mockSteps].filter(([key]) => key.endsWith(":result"))
    expect(checkpoints.some(([, result]) => (result as { agentId: string }).agentId === id)).toBe(
      true
    )
    mockAgents.delete(id)
  })
  for (let index = 0; index < 12; index++) {
    const result = await runPluginExternalAgent("plugin", "devin", "fix issue", {
      ...options,
      invocationId: index === 0 ? "default" : `turn-${index}`,
    })
    expect(result.status).toBe("completed")
    expect(mockAgents.size).toBe(0)
  }
  expect(mockManager.execute).toHaveBeenCalledTimes(12)
  expect(mockManager.removeAgent).toHaveBeenCalledTimes(12)
  expect(mockSteps.size).toBeGreaterThanOrEqual(36)
})

it("does not remove a legacy shared agent or an agent whose workspace ownership changed", async () => {
  mockManager.execute.mockResolvedValueOnce({ success: true, finalResponse: "legacy" })
  await runPluginExternalAgent("plugin", "devin", "legacy")
  expect(mockManager.removeAgent).not.toHaveBeenCalled()
  mockManager.execute.mockImplementationOnce(async (id) => {
    mockAgents.set(id, { config: { id, process: { cwd: "/another-run" } } } as never)
    return {
      success: true,
      sessionId: "session",
      finalResponse: "result",
      toolCalls: [],
      messages: [],
      steps: [],
      duration: 1,
    }
  })
  await expect(runPluginExternalAgent("plugin", "devin", "fix", options)).rejects.toThrow(
    "does not belong"
  )
  expect(mockManager.removeAgent).not.toHaveBeenCalled()
})

it("retries failed cleanup from the completed checkpoint without dispatching again", async () => {
  mockManager.removeAgent.mockRejectedValueOnce(new Error("process stop failed"))
  await expect(runPluginExternalAgent("plugin", "devin", "fix", options)).rejects.toThrow(
    "process stop failed"
  )
  expect(mockSteps.has("run:__host:external-agent:result")).toBe(true)
  expect((await runPluginExternalAgent("plugin", "devin", "fix", options)).status).toBe("completed")
  expect(mockManager.execute).toHaveBeenCalledTimes(1)
  expect(mockManager.removeAgent).toHaveBeenCalledTimes(2)
  expect(mockAgents.size).toBe(0)
})

it.each(["createSession", "resumeSession"] as const)(
  "releases an owned transient agent when %s fails before dispatch",
  async (operation) => {
    if (operation === "resumeSession") {
      await runPluginExternalAgent("plugin", "devin", "first", options)
      mockManager.execute.mockClear()
      mockManager.removeAgent.mockClear()
    }
    mockManager[operation].mockRejectedValueOnce(new Error("session allocation failed"))
    await expect(
      runPluginExternalAgent("plugin", "devin", "next", {
        ...options,
        ...(operation === "resumeSession" ? { invocationId: "next", sessionId: "session" } : {}),
      })
    ).rejects.toThrow("session allocation failed")
    expect(mockManager.removeAgent).toHaveBeenCalledTimes(1)
    expect(mockAgents.size).toBe(0)
    expect(mockManager.execute).not.toHaveBeenCalled()
  }
)

it("releases a partially registered agent on connect failure and preserves uncertain dispatch metadata", async () => {
  mockManager.addAgent.mockImplementationOnce(async (config) => {
    mockAgents.set(config.id, { config })
    throw new Error("connection failed")
  })
  await expect(runPluginExternalAgent("plugin", "devin", "fix", options)).rejects.toThrow(
    "connection failed"
  )
  expect(mockAgents.size).toBe(0)
  mockManager.execute.mockRejectedValueOnce(new Error("uncertain transport failure"))
  await expect(runPluginExternalAgent("plugin", "devin", "fix", options)).rejects.toThrow(
    "uncertain transport failure"
  )
  expect(mockSteps.has("run:__host:external-agent:dispatched")).toBe(true)
  expect(mockSteps.has("run:__host:external-agent:result")).toBe(false)
  expect(mockAgents.size).toBe(0)
})

it("retains both execution and cleanup errors and releases the active invocation lock", async () => {
  mockManager.execute.mockRejectedValueOnce(new Error("uncertain execution"))
  mockManager.removeAgent.mockRejectedValueOnce(new Error("process stop failed"))
  await expect(runPluginExternalAgent("plugin", "devin", "fix", options)).rejects.toMatchObject({
    errors: [
      expect.objectContaining({ message: "uncertain execution" }),
      expect.objectContaining({ message: "process stop failed" }),
    ],
  })
  expect((await runPluginExternalAgent("plugin", "devin", "fix", options)).status).toBe(
    "recovery_required"
  )
  expect(mockAgents.size).toBe(0)
})

function allowUnattended() {
  const policy = { maxAuthority: "bypassPermissions", maxAutonomy: "autopilot" }
  jest.mocked(resolveOwnedBotAuthority).mockResolvedValue({
    grant: policy,
    effectivePolicy: policy,
  } as never)
}

it.each([
  { grant: {}, effectivePolicy: { maxAuthority: "bypassPermissions", maxAutonomy: "autopilot" } },
  {
    grant: { maxAuthority: "bypassPermissions" },
    effectivePolicy: { maxAuthority: "bypassPermissions", maxAutonomy: "autopilot" },
  },
  {
    grant: { maxAuthority: "bypassPermissions", maxAutonomy: "autopilot" },
    effectivePolicy: { maxAuthority: "acceptEdits", maxAutonomy: "autopilot" },
  },
  {
    grant: { maxAuthority: "bypassPermissions", maxAutonomy: "autopilot" },
    effectivePolicy: { maxAuthority: "bypassPermissions", maxAutonomy: "assist" },
  },
])(
  "rejects unattended requests unless the host grant and every ceiling permit them: %j",
  async (authority) => {
    jest.mocked(resolveOwnedBotAuthority).mockResolvedValue(authority as never)
    await expect(
      runPluginExternalAgent("plugin", "devin", "fix issue", {
        ...options,
        permissionMode: "bypassPermissions",
      })
    ).rejects.toThrow("explicit bypassPermissions and autopilot installation grant")
    expect(mockManager.createSession).not.toHaveBeenCalled()
    expect(mockManager.execute).not.toHaveBeenCalled()
    expect(updateBotInstallation).toHaveBeenCalledWith(
      "installation",
      expect.objectContaining({ status: "needs_setup" })
    )
  }
)

it("passes the explicitly authorized unattended mode through create, set, execute and durable replay", async () => {
  allowUnattended()
  const unattended = { ...options, permissionMode: "bypassPermissions" as const }
  const result = await runPluginExternalAgent("plugin", "devin", "fix issue", unattended)
  expect(result.status).toBe("completed")
  expect(mockManager.createSession).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ permissionMode: "bypassPermissions", mcpServers: [] })
  )
  expect(mockManager.execute).toHaveBeenCalledWith(
    expect.any(String),
    "fix issue",
    expect.objectContaining({ permissionMode: "bypassPermissions", workingDirectory: "/isolated" })
  )
  expect(mockSteps.get("run:__host:external-agent")).toEqual(
    expect.objectContaining({ permissionMode: "bypassPermissions" })
  )
  expect(await runPluginExternalAgent("plugin", "devin", "fix issue", unattended)).toEqual(result)
  expect(mockManager.execute).toHaveBeenCalledTimes(1)
  expect(mockApproval).not.toHaveBeenCalled()
})

it("does not upgrade a recorded manual invocation or its completed session", async () => {
  await runPluginExternalAgent("plugin", "devin", "fix issue", options)
  allowUnattended()
  await expect(
    runPluginExternalAgent("plugin", "devin", "fix issue", {
      ...options,
      permissionMode: "bypassPermissions",
    })
  ).rejects.toThrow("identity cannot change")
  await expect(
    runPluginExternalAgent("plugin", "devin", "next fix", {
      ...options,
      permissionMode: "bypassPermissions",
      invocationId: "next",
      sessionId: "session",
    })
  ).rejects.toThrow("unowned or unfinished")
  expect(mockManager.setSessionMode).toHaveBeenCalledTimes(1)
})

it("rechecks unattended authority after session setup and rejects revocation before dispatch", async () => {
  allowUnattended()
  mockManager.setSessionModel.mockImplementationOnce(async () => {
    jest
      .mocked(resolveOwnedBotAuthority)
      .mockResolvedValue({ grant: {}, effectivePolicy: {} } as never)
  })
  await expect(
    runPluginExternalAgent("plugin", "devin", "fix issue", {
      ...options,
      permissionMode: "bypassPermissions",
    })
  ).rejects.toThrow("explicit bypassPermissions")
  expect(mockManager.execute).not.toHaveBeenCalled()
  expect(mockManager.setSessionMode).not.toHaveBeenCalled()
})

it("rejects unsupported serialized Bot modes and unconfirmed unattended provider mode", async () => {
  await expect(
    runPluginExternalAgent("plugin", "devin", "fix issue", {
      ...options,
      permissionMode: "dontAsk" as never,
    })
  ).rejects.toThrow("must be acceptEdits or bypassPermissions")
  allowUnattended()
  mockManager.setSessionMode.mockResolvedValueOnce(undefined)
  await expect(
    runPluginExternalAgent("plugin", "devin", "fix issue", {
      ...options,
      permissionMode: "bypassPermissions",
    })
  ).rejects.toThrow("did not confirm")
  expect(mockManager.execute).not.toHaveBeenCalled()
})

it("denies unexpected unattended permission prompts instead of silently falling back to manual approval", async () => {
  allowUnattended()
  emitCommandPermission()
  const result = await runPluginExternalAgent("plugin", "devin", "fix issue", {
    ...options,
    permissionMode: "bypassPermissions",
  })
  expect(mockApproval).not.toHaveBeenCalled()
  expect(result.status).toBe("failed")
  expect(result.success).toBe(false)
  expect(result.error).toContain("permission mode configuration")
  expect(mockManager.respondToPermission).toHaveBeenCalledWith(
    expect.any(String),
    "session",
    expect.objectContaining({ granted: false })
  )
})

function emitCommandPermission(
  overrides: Partial<ExternalAgentPermissionRequestEvent["request"]> = {}
) {
  const event: ExternalAgentPermissionRequestEvent = {
    type: "permission_request",
    timestamp: new Date(),
    sessionId: "session",
    request: {
      id: "command-1",
      sessionId: "session",
      title: "Run tests",
      kind: "execute",
      toolInfo: { id: "exec-1", name: "exec" },
      rawInput: { command: "pnpm test --runInBand" },
      options: [
        { optionId: "yes", kind: "allow_once", name: "Allow once" },
        { optionId: "all", kind: "allow_always", name: "Always" },
        { optionId: "no", kind: "reject_once", name: "Deny" },
      ],
      ...overrides,
    },
  }
  mockManager.execute.mockImplementation(
    async (_agent, _prompt, execution: ExternalAgentExecutionOptions) => {
      let answered!: () => void
      const answer = new Promise<void>((resolve) => {
        answered = resolve
      })
      mockManager.respondToPermission.mockImplementation(async () => answered())
      execution.onEvent?.(event)
      execution.onEvent?.(event)
      await answer
      return {
        success: true,
        finalResponse: "done",
        sessionId: "session",
        messages: [],
        steps: [],
        toolCalls: [],
        duration: 1,
      }
    }
  )
  return event
}

it("shows one immutable concrete command and grants only that approved wire request", async () => {
  const event = emitCommandPermission()
  mockApproval.mockResolvedValue({ outcome: "approved" })
  await runPluginExternalAgent("plugin", "devin", "test", {
    ...options,
    onEvent: () => {
      event.request.rawInput = { command: "altered" }
    },
  })
  expect(mockApproval).toHaveBeenCalledTimes(1)
  expect(mockApproval).toHaveBeenCalledWith(
    expect.stringContaining("external-command-"),
    expect.objectContaining({
      timeoutMs: 240_000,
      detail: {
        model: "swe-2-medium",
        externalAgent: {
          agentId: expect.any(String),
          sessionId: "session",
          requestId: "command-1",
          toolName: "exec",
          input: { command: "pnpm test --runInBand" },
        },
      },
    })
  )
  expect(mockManager.respondToPermission).toHaveBeenCalledTimes(1)
  expect(mockManager.respondToPermission).toHaveBeenCalledWith(expect.any(String), "session", {
    requestId: "command-1",
    granted: true,
    scope: "once",
    optionId: "yes",
  })
})

it.each(["denied", "expired"])(
  "denies a command exactly once when approval is %s",
  async (outcome) => {
    emitCommandPermission()
    mockApproval.mockResolvedValue({ outcome })
    await runPluginExternalAgent("plugin", "devin", "test", options)
    expect(mockManager.respondToPermission).toHaveBeenCalledTimes(1)
    expect(mockManager.respondToPermission).toHaveBeenCalledWith(expect.any(String), "session", {
      requestId: "command-1",
      granted: false,
      scope: "once",
      optionId: "no",
    })
  }
)

it("revalidates installation/workspace ownership after approval before granting", async () => {
  emitCommandPermission()
  mockApproval.mockImplementation(async () => {
    jest.mocked(assertOwnedBotWorkspace).mockRejectedValueOnce(new Error("disabled"))
    return { outcome: "approved" }
  })
  await runPluginExternalAgent("plugin", "devin", "test", options)
  expect(mockManager.respondToPermission).toHaveBeenCalledWith(
    expect.any(String),
    "session",
    expect.objectContaining({ granted: false })
  )
  expect(expireRunInterruptFromSource).toHaveBeenCalled()
})

it("cancellation prevents a grant even when the decision arrives approved", async () => {
  const controller = new AbortController()
  emitCommandPermission()
  mockApproval.mockImplementation(async () => {
    controller.abort()
    return { outcome: "approved" }
  })
  await runPluginExternalAgent("plugin", "devin", "test", { ...options, signal: controller.signal })
  expect(mockManager.respondToPermission).toHaveBeenCalledTimes(1)
  expect(mockManager.respondToPermission).toHaveBeenCalledWith(
    expect.any(String),
    "session",
    expect.objectContaining({ granted: false })
  )
})

it("rejects another session's command without creating an approval", async () => {
  emitCommandPermission({ sessionId: "other" })
  await runPluginExternalAgent("plugin", "devin", "test", options)
  expect(mockApproval).not.toHaveBeenCalled()
  expect(mockManager.respondToPermission).toHaveBeenCalledWith(
    expect.any(String),
    "session",
    expect.objectContaining({ granted: false })
  )
})

it("never upgrades a one-command approval into an always-allow provider option", async () => {
  emitCommandPermission({ options: [{ optionId: "all", kind: "allow_always", name: "Always" }] })
  mockApproval.mockResolvedValue({ outcome: "approved" })
  await runPluginExternalAgent("plugin", "devin", "test", options)
  expect(mockManager.respondToPermission).toHaveBeenCalledWith(expect.any(String), "session", {
    requestId: "command-1",
    granted: false,
    scope: "once",
  })
})

it("expires a live command approval when execution fails while it is waiting", async () => {
  const event = emitCommandPermission()
  mockManager.execute.mockImplementation(
    async (_agent, _prompt, execution: ExternalAgentExecutionOptions) => {
      const waiting = new Promise<void>((resolve) => {
        mockApproval.mockImplementation(async () => {
          resolve()
          const approvalSignal = jest.mocked(createBotStepApi).mock.calls.at(-1)![0].signal
          await new Promise<void>((_resolve, reject) =>
            approvalSignal.addEventListener("abort", () => reject(new Error("cancelled")), {
              once: true,
            })
          )
        })
      })
      execution.onEvent?.(event)
      await waiting
      throw new Error("process failed")
    }
  )
  await expect(runPluginExternalAgent("plugin", "devin", "test", options)).rejects.toThrow(
    "process failed"
  )
  expect(expireRunInterruptFromSource).toHaveBeenCalled()
  expect(mockManager.respondToPermission).toHaveBeenCalledTimes(1)
  expect(mockManager.respondToPermission).toHaveBeenCalledWith(
    expect.any(String),
    "session",
    expect.objectContaining({ granted: false })
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
  expect(mockManager.resumeSession).toHaveBeenCalledWith(
    expect.any(String),
    "session",
    expect.objectContaining({ permissionMode: "acceptEdits" })
  )
  expect(mockManager.setSessionMode).toHaveBeenCalledTimes(2)
  expect(mockManager.setSessionMode).toHaveBeenLastCalledWith(
    expect.any(String),
    "session",
    "acceptEdits"
  )
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

it.each(["addAgent", "createSession", "resumeSession"] as const)(
  "marks an unsupported Bot launcher needs_setup during %s without dispatch or a result checkpoint",
  async (operation) => {
    if (operation === "resumeSession") {
      await runPluginExternalAgent("plugin", "devin", "fix issue", options)
      mockSteps.delete("run:__host:external-agent:result")
      mockManager.execute.mockClear()
    }
    mockManager[operation].mockRejectedValueOnce(
      new Error("BOT_ISOLATION_LAUNCHER_UNSUPPORTED: Rebuild the selected launcher")
    )
    await expect(runPluginExternalAgent("plugin", "devin", "fix issue", options)).rejects.toThrow(
      "Rebuild the selected launcher"
    )
    expect(updateBotInstallation).toHaveBeenCalledWith(
      "installation",
      expect.objectContaining({ status: "needs_setup" })
    )
    expect(mockManager.execute).not.toHaveBeenCalled()
    expect(mockSteps.has("run:__host:external-agent:result")).toBe(false)
  }
)

it("keeps unrelated session connection failures retryable", async () => {
  mockManager.createSession.mockRejectedValueOnce(new Error("session connection interrupted"))
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
