import { dispatchSubagent, runTeam } from "./dispatch"
import { executeAgent } from "@/lib/ai/agent/agent-executor"
import { getSubagent } from "@/lib/plugin/registries/subagent-registry"
import { agentTeamManager } from "@/lib/ai/agent/agent-team"
import type { PluginSubagentDef } from "@/types/plugin/plugin-subagent"
import { PluginPiiError } from "@/lib/plugin/api/plugin-pii-gate"

jest.mock("@/lib/ai/agent/agent-executor", () => ({
  __esModule: true,
  executeAgent: jest.fn(),
}))
// ADR-0090 Phase 6: the dispatch path routes through the unified authority.
// Default delegates to the REAL wrapper (flag off ⇒ the executeAgent mock
// above), so legacy assertions still hold; individual tests override it to
// pin the surface and the execution-meta pass-through.
const mockRendererTurn = jest.fn()
jest.mock("@/lib/ai/agent/execution/agent-execution-service", () => ({
  __esModule: true,
  ...jest.requireActual("@/lib/ai/agent/execution/agent-execution-service"),
  executeAgentTurnFromRenderer: (...a: unknown[]) => mockRendererTurn(...(a as [])),
}))
jest.mock("@/lib/plugin/registries/subagent-registry", () => ({
  __esModule: true,
  getSubagent: jest.fn(),
}))
jest.mock("@/lib/ai/agent/agent-team", () => ({
  __esModule: true,
  agentTeamManager: {
    get: jest.fn(),
    create: jest.fn(),
    start: jest.fn(async () => undefined),
  },
}))

const externalExecute = jest.fn()
const externalGetAllAgents = jest.fn<unknown[], unknown[]>(() => [])
const externalAddAgent = jest.fn()
jest.mock("@/lib/ai/agent/external/manager", () => ({
  __esModule: true,
  getExternalAgentManager: () => ({
    execute: (...a: unknown[]) => externalExecute(...a),
    getAllAgents: (...a: unknown[]) => externalGetAllAgents(...a),
    addAgent: (...a: unknown[]) => externalAddAgent(...a),
  }),
}))
const externalCreatePreset = jest.fn()
const externalIsFromPreset = jest.fn<string | null, unknown[]>(() => null)
jest.mock("@/lib/ai/agent/external/presets", () => ({
  __esModule: true,
  createAgentFromPreset: (...a: unknown[]) => externalCreatePreset(...a),
  isFromPreset: (...a: unknown[]) => externalIsFromPreset(...a),
}))
const externalSupported = jest.fn<boolean, unknown[]>(() => true)
jest.mock("@/lib/ai/agent/external/agent-transport", () => ({
  __esModule: true,
  supportsExternalAgents: (...a: unknown[]) => externalSupported(...a),
}))
const externalResolveMcp = jest.fn(async (..._a: unknown[]) => [] as unknown[])
jest.mock("@/lib/ai/agent/external/resolve-acp-mcp-servers", () => ({
  __esModule: true,
  resolveAcpMcpServers: (...a: unknown[]) => externalResolveMcp(...a),
}))

const mockExecute = executeAgent as jest.MockedFunction<typeof executeAgent>
const mockGetSubagent = getSubagent as jest.MockedFunction<typeof getSubagent>
const mockTeam = agentTeamManager as unknown as {
  get: jest.Mock
  create: jest.Mock
  start: jest.Mock
}

const subagent: PluginSubagentDef = {
  id: "reviewer",
  name: "Reviewer",
  description: "Reviews code",
  prompt: "You review code.",
  tools: ["Read", "Grep"],
  model: "sonnet",
  maxTurns: 4,
}

beforeEach(() => {
  jest.clearAllMocks()
  mockRendererTurn.mockImplementation((...a: unknown[]) =>
    jest
      .requireActual("@/lib/ai/agent/execution/agent-execution-service")
      .executeAgentTurnFromRenderer(...(a as [string, never, never]))
  )
  mockExecute.mockResolvedValue({
    text: "reviewed",
    channel: "sidecar",
    toolsAvailable: true,
    finishReason: "stop",
  } as never)
  mockTeam.start.mockResolvedValue(undefined)
  externalGetAllAgents.mockReturnValue([])
  externalIsFromPreset.mockReturnValue(null)
  externalSupported.mockReturnValue(true)
})

describe("dispatchSubagent", () => {
  it("maps an inline subagent def onto executeAgent and returns the result", async () => {
    const res = await dispatchSubagent(subagent, "review this PR")
    expect(mockExecute).toHaveBeenCalledWith("review this PR", {
      toolsEnabled: true,
      isDispatchedSubagent: true,
      systemPrompt: "You review code.",
      model: "sonnet",
      allowedTools: ["Read", "Grep"],
      maxSteps: 4,
    })
    expect(res).toMatchObject({
      text: "reviewed",
      channel: "sidecar",
      toolsAvailable: true,
      finishReason: "stop",
    })
    expect(res.runId).toEqual(expect.any(String))
  })

  it("forwards a cross-provider def.provider to executeAgent", async () => {
    await dispatchSubagent({ ...subagent, provider: "anthropic" }, "go")
    expect(mockExecute.mock.calls[0][1]).toMatchObject({ provider: "anthropic" })
  })

  it("routes through the unified authority with surface 'plugin' and forwards execution meta (ADR-0090)", async () => {
    mockRendererTurn.mockResolvedValueOnce({
      text: "authoritative",
      channel: "sidecar",
      toolsAvailable: true,
      runtime: "claude-agent-sdk",
      routeKind: "direct",
      degradedReason: "sidecar-unavailable",
    })
    const res = await dispatchSubagent(subagent, "go")
    expect(mockRendererTurn.mock.calls[0][2]).toEqual({ surface: "plugin" })
    expect(res).toMatchObject({
      text: "authoritative",
      runtime: "claude-agent-sdk",
      routeKind: "direct",
      degradedReason: "sidecar-unavailable",
    })
  })

  it("omits execution meta from the result when the turn ran without it (flag off)", async () => {
    const res = await dispatchSubagent(subagent, "go")
    expect(res).not.toHaveProperty("runtime")
    expect(res).not.toHaveProperty("routeKind")
    expect(res).not.toHaveProperty("degradedReason")
    expect(res).not.toHaveProperty("delegationMode")
  })

  it("classifies the delegation mode at runtime under the resolver flag (ADR-0090 P7)", async () => {
    process.env.NEXT_PUBLIC_AGENT_EXECUTION_RESOLVER_V2 = "1"
    try {
      mockRendererTurn.mockResolvedValue({
        text: "ok",
        channel: "sidecar",
        toolsAvailable: true,
        runtime: "claude-agent-sdk",
        routeKind: "direct",
      })
      // Same-runtime def (no provider pin) → NATIVE, no reasons.
      const native = await dispatchSubagent(subagent, "go")
      expect(native.delegationMode).toBe("native")
      expect(native.delegationReasons).toEqual([])

      // A cross-provider def legacy-maps to the ai-sdk runtime → ORCHESTRATED.
      const orchestrated = await dispatchSubagent({ ...subagent, provider: "openai" }, "go")
      expect(orchestrated.delegationMode).toBe("orchestrated")
      expect(orchestrated.delegationReasons).toContain("runtime-differs")
    } finally {
      delete process.env.NEXT_PUBLIC_AGENT_EXECUTION_RESOLVER_V2
    }
  })

  it("omits provider when the def names none", async () => {
    await dispatchSubagent(subagent, "go")
    expect(mockExecute.mock.calls[0][1]).not.toHaveProperty("provider")
  })

  it("resolves a registered subagent by id", async () => {
    mockGetSubagent.mockReturnValue(subagent)
    await dispatchSubagent("reviewer", "go")
    expect(mockGetSubagent).toHaveBeenCalledWith("reviewer")
    expect(mockExecute).toHaveBeenCalledTimes(1)
  })

  it("throws when the subagent id is not registered", async () => {
    mockGetSubagent.mockReturnValue(undefined)
    await expect(dispatchSubagent("missing", "go")).rejects.toThrow(/not registered/)
  })

  it("throws on an empty prompt", async () => {
    await expect(dispatchSubagent(subagent, "")).rejects.toThrow(/non-empty prompt/)
  })

  it("fails closed before execution when the prompt or subagent system prompt contains PII", async () => {
    await expect(dispatchSubagent(subagent, "Email alice@example.com")).rejects.toBeInstanceOf(
      PluginPiiError
    )
    await expect(
      dispatchSubagent({ ...subagent, prompt: "Use alice@example.com" }, "review this")
    ).rejects.toBeInstanceOf(PluginPiiError)
    expect(mockExecute).not.toHaveBeenCalled()
    expect(externalExecute).not.toHaveBeenCalled()
  })

  it("treats an explicit empty tools list as deny-all instead of inheriting tools", async () => {
    await dispatchSubagent({ ...subagent, tools: [] }, "go")
    expect(mockExecute.mock.calls[0][1]).toMatchObject({ allowedTools: [], toolsEnabled: false })
  })

  it("honors toolsEnabled=false (text-only dispatch)", async () => {
    await dispatchSubagent(subagent, "go", { toolsEnabled: false })
    expect(mockExecute.mock.calls[0][1]).toMatchObject({ toolsEnabled: false })
  })

  it("forwards the parent permission ceiling to executeAgent (clamps the child)", async () => {
    await dispatchSubagent(subagent, "go", {
      _permissionCeiling: { allowedTools: ["Read"], permissionMode: "plan" },
    })
    expect(mockExecute.mock.calls[0][1]).toMatchObject({
      permissionCeiling: { allowedTools: ["Read"], permissionMode: "plan" },
    })
  })

  it("omits permissionCeiling when the parent set none", async () => {
    await dispatchSubagent(subagent, "go")
    expect(mockExecute.mock.calls[0][1]).not.toHaveProperty("permissionCeiling")
  })

  it("always marks the run as a dispatched subagent (leaf-gate signal)", async () => {
    // Leaf def (no allowNesting): flagged, and no dispatchContext — build-options
    // withholds dispatch_agent from it instead of treating it as top-level.
    await dispatchSubagent(subagent, "go")
    expect(mockExecute.mock.calls[0][1]).toMatchObject({ isDispatchedSubagent: true })
    expect(mockExecute.mock.calls[0][1]).not.toHaveProperty("dispatchContext")
    // Nesting def: flagged AND carries a dispatchContext for its own children.
    await dispatchSubagent({ ...subagent, allowNesting: true }, "go", { _maxDepth: 2 })
    expect(mockExecute.mock.calls[1][1]).toMatchObject({
      isDispatchedSubagent: true,
      dispatchContext: expect.objectContaining({ depth: 1, maxDepth: 2 }),
    })
  })

  it("forwards the live-progress _onEvent sink to executeAgent as onEvent", async () => {
    const sink = jest.fn()
    await dispatchSubagent(subagent, "go", { _onEvent: sink })
    expect(mockExecute.mock.calls[0][1]).toMatchObject({ onEvent: sink })
  })

  it("omits onEvent when no sink was provided", async () => {
    await dispatchSubagent(subagent, "go")
    expect(mockExecute.mock.calls[0][1]).not.toHaveProperty("onEvent")
  })
})

describe("dispatchSubagent — nesting guards", () => {
  const nester: PluginSubagentDef = {
    id: "lead",
    name: "Lead",
    description: "Can dispatch",
    prompt: "Lead.",
    allowNesting: true,
  }

  it("rejects a cycle (this id already on the parent chain) without running", async () => {
    const res = await dispatchSubagent(nester, "go", {
      _parentChain: ["root", "lead"],
      _depth: 1,
      _maxDepth: 3,
    })
    expect(res.rejection?.reason).toBe("cycle")
    expect(res.text).toContain("root → lead → lead")
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it("rejects when the child would exceed maxDepth", async () => {
    const res = await dispatchSubagent(nester, "go", { _depth: 2, _maxDepth: 2 })
    expect(res.rejection?.reason).toBe("max-depth")
    expect(res.depthExhausted).toBe(true)
    expect(res.rejection?.attemptedDepth).toBe(3)
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it("threads a dispatchContext into the child when it opts into nesting and depth allows", async () => {
    await dispatchSubagent(nester, "go", { _depth: 0, _maxDepth: 2, _parentChain: [] })
    expect(mockExecute.mock.calls[0][1]).toMatchObject({
      dispatchContext: { depth: 1, maxDepth: 2, parentChain: ["lead"] },
    })
  })

  it("does NOT thread a dispatchContext for a leaf subagent (allowNesting unset)", async () => {
    await dispatchSubagent(subagent, "go", { _depth: 0, _maxDepth: 2 })
    expect(mockExecute.mock.calls[0][1]).not.toHaveProperty("dispatchContext")
  })

  it("narrows the child cap to min(def.maxDepth, app maxDepth)", async () => {
    await dispatchSubagent({ ...nester, maxDepth: 1 }, "go", { _depth: 0, _maxDepth: 5 })
    expect(mockExecute.mock.calls[0][1]).toMatchObject({
      dispatchContext: { maxDepth: 1 },
    })
  })
})

describe("dispatchSubagent — external backing (A2)", () => {
  const externalDef: PluginSubagentDef = {
    id: "coder",
    name: "External Coder",
    description: "Codes via an external CLI",
    prompt: "You write code.",
    externalPresetId: "claude-code",
  }

  it("spawns + executes the external agent and maps the result", async () => {
    externalCreatePreset.mockReturnValue({ id: "ext-1", metadata: { preset: "claude-code" } })
    externalExecute.mockResolvedValue({
      success: true,
      finalResponse: "done externally",
      tokenUsage: { promptTokens: 5, completionTokens: 6, totalTokens: 11 },
    })

    const res = await dispatchSubagent(externalDef, "build it", { cwd: "/repo" })

    expect(externalAddAgent).toHaveBeenCalledTimes(1)
    expect(externalExecute).toHaveBeenCalledWith(
      "ext-1",
      "build it",
      expect.objectContaining({ workingDirectory: "/repo", systemPrompt: "You write code." })
    )
    expect(res).toMatchObject({
      text: "done externally",
      channel: "external",
      toolsAvailable: true,
      usage: { inputTokens: 5, outputTokens: 6, totalTokens: 11 },
    })
    expect(res.runId).toEqual(expect.any(String))
    expect(mockExecute).not.toHaveBeenCalled() // built-in executor never ran
  })

  it("forwards the subagent's declared model to the external agent", async () => {
    // Regression: this call already spread `def.model`, but
    // ExternalAgentExecutionOptions had no `model` field, so it was dropped —
    // silently, because TypeScript's excess-property check doesn't apply to
    // spread members. The code read as if it worked and did nothing.
    externalCreatePreset.mockReturnValue({ id: "ext-3", metadata: { preset: "codex-app-server" } })
    externalExecute.mockResolvedValue({ success: true, finalResponse: "ok" })

    await dispatchSubagent({ ...externalDef, model: "gpt-5.6-sol" }, "build it", {})

    expect(externalExecute).toHaveBeenCalledWith(
      "ext-3",
      "build it",
      expect.objectContaining({ model: "gpt-5.6-sol" })
    )
  })

  it("preserves an explicit deny-all tool list for external agents", async () => {
    externalCreatePreset.mockReturnValue({ id: "ext-deny", metadata: { preset: "claude-code" } })
    externalExecute.mockResolvedValue({ success: true, finalResponse: "ok" })

    await dispatchSubagent({ ...externalDef, tools: [] }, "build it")

    expect(externalExecute).toHaveBeenCalledWith(
      "ext-deny",
      "build it",
      expect.objectContaining({ allowedTools: [] })
    )
  })

  it("forwards declared MCP servers into the external session", async () => {
    externalCreatePreset.mockReturnValue({ id: "ext-2", metadata: { preset: "claude-code" } })
    externalExecute.mockResolvedValue({ success: true, finalResponse: "ok" })
    externalResolveMcp.mockResolvedValue([{ name: "github", command: "gh-mcp", args: [] }])

    await dispatchSubagent({ ...externalDef, mcpServerIds: ["github"] }, "go", { cwd: "/repo" })

    expect(externalResolveMcp).toHaveBeenCalledWith(["github"])
    expect(externalExecute).toHaveBeenCalledWith(
      "ext-2",
      "go",
      expect.objectContaining({
        context: { custom: { mcpServers: [{ name: "github", command: "gh-mcp", args: [] }] } },
      })
    )
  })

  it("does not resolve MCP servers when the subagent declares none", async () => {
    externalCreatePreset.mockReturnValue({ id: "ext-3", metadata: { preset: "claude-code" } })
    externalExecute.mockResolvedValue({ success: true, finalResponse: "ok" })

    await dispatchSubagent(externalDef, "go")

    expect(externalResolveMcp).not.toHaveBeenCalled()
    expect(externalExecute.mock.calls[0][2]).not.toHaveProperty("context")
  })

  it("reuses a live agent already created from the preset", async () => {
    externalGetAllAgents.mockReturnValue([
      { config: { id: "live-9", metadata: { preset: "claude-code" } } },
    ])
    externalIsFromPreset.mockImplementation((...args: unknown[]) => {
      const cfg = args[0] as { metadata?: { preset?: string } }
      return cfg.metadata?.preset === "claude-code" ? "claude-code" : null
    })
    externalExecute.mockResolvedValue({ success: true, finalResponse: "ok" })

    await dispatchSubagent(externalDef, "go")

    expect(externalAddAgent).not.toHaveBeenCalled()
    expect(externalExecute).toHaveBeenCalledWith("live-9", "go", expect.any(Object))
  })

  it("options.externalAgentId overrides the def preset", async () => {
    externalCreatePreset.mockReturnValue({ id: "ext-2", metadata: { preset: "codex" } })
    externalExecute.mockResolvedValue({ success: true, finalResponse: "x" })

    await dispatchSubagent(subagent, "go", { externalAgentId: "codex" })

    expect(externalCreatePreset).toHaveBeenCalledWith("codex")
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it("throws when the external preset is unknown", async () => {
    externalCreatePreset.mockReturnValue(null)
    await expect(dispatchSubagent(externalDef, "go")).rejects.toThrow(/not registered/)
  })

  it("throws when the external agent returns success=false", async () => {
    externalCreatePreset.mockReturnValue({ id: "ext-3", metadata: { preset: "claude-code" } })
    externalExecute.mockResolvedValue({ success: false, error: "connect refused" })
    await expect(dispatchSubagent(externalDef, "go")).rejects.toThrow("connect refused")
  })

  it("fails loudly (never silently) when external agents are unsupported", async () => {
    externalSupported.mockReturnValue(false)
    await expect(dispatchSubagent(externalDef, "go")).rejects.toThrow(/desktop app/)
    expect(externalExecute).not.toHaveBeenCalled()
    expect(mockExecute).not.toHaveBeenCalled() // did NOT fall back to the built-in engine
  })

  it("derives the external permission mode from the parent ceiling", async () => {
    externalCreatePreset.mockReturnValue({ id: "ext-4", metadata: { preset: "claude-code" } })
    externalExecute.mockResolvedValue({ success: true, finalResponse: "ok" })
    await dispatchSubagent(externalDef, "go", {
      _permissionCeiling: { permissionMode: "plan" },
    })
    expect(externalExecute.mock.calls[0][2]).toMatchObject({ permissionMode: "plan" })
  })

  it("streams external protocol events into _onEvent as CaptureStreamEvents", async () => {
    externalCreatePreset.mockReturnValue({ id: "ext-5", metadata: { preset: "claude-code" } })
    externalExecute.mockImplementation(async (_id: unknown, _prompt: unknown, opts: unknown) => {
      const onEvent = (opts as { onEvent?: (e: unknown) => void }).onEvent
      onEvent?.({
        type: "message_delta",
        timestamp: new Date(),
        delta: { type: "text", text: "hi" },
      })
      onEvent?.({ type: "done", timestamp: new Date(), success: true })
      return { success: true, finalResponse: "hi" }
    })
    const sink = jest.fn()
    await dispatchSubagent(externalDef, "go", { _onEvent: sink })
    expect(sink).toHaveBeenCalledWith({ type: "text-delta", delta: "hi" })
    expect(sink).toHaveBeenCalledTimes(1) // `done` produces no capture event
  })
})

describe("runTeam", () => {
  it("starts an existing team by id and returns its terminal status", async () => {
    mockTeam.get.mockReturnValueOnce({ id: "t1" }).mockReturnValueOnce({
      id: "t1",
      status: "completed",
    })
    const res = await runTeam("t1", { ultracode: true })
    expect(mockTeam.start).toHaveBeenCalledWith("t1", { origin: "plugin", ultracode: true })
    expect(res).toEqual({ teamId: "t1", status: "completed" })
  })

  it("throws when the team id is not found", async () => {
    mockTeam.get.mockReturnValue(undefined)
    await expect(runTeam("nope")).rejects.toThrow(/not found/)
    expect(mockTeam.start).not.toHaveBeenCalled()
  })

  it("creates and starts an ad-hoc team config", async () => {
    mockTeam.get.mockReturnValue({ id: "adhoc", status: "completed" })
    const config = { id: "adhoc", name: "Ad-hoc" } as never
    const res = await runTeam(config)
    expect(mockTeam.create).toHaveBeenCalledWith(config)
    expect(mockTeam.start).toHaveBeenCalledWith("adhoc", { origin: "plugin" })
    expect(res.teamId).toBe("adhoc")
  })

  it("reports unknown status when the team row vanished post-run", async () => {
    mockTeam.get.mockReturnValueOnce({ id: "t1" }).mockReturnValueOnce(undefined)
    const res = await runTeam("t1")
    expect(res.status).toBe("unknown")
  })
})
