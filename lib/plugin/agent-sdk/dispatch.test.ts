import { dispatchSubagent, runTeam } from "./dispatch"
import { executeAgent } from "@/lib/ai/agent/agent-executor"
import { getSubagent } from "@/lib/plugin/registries/subagent-registry"
import { agentTeamManager } from "@/lib/ai/agent/agent-team"
import type { PluginSubagentDef } from "@/types/plugin/plugin-subagent"

jest.mock("@/lib/ai/agent/agent-executor", () => ({
  __esModule: true,
  executeAgent: jest.fn(),
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
const externalGetAllAgents = jest.fn<unknown[], []>(() => [])
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
  mockExecute.mockResolvedValue({
    text: "reviewed",
    channel: "sidecar",
    toolsAvailable: true,
    finishReason: "stop",
  } as never)
  mockTeam.start.mockResolvedValue(undefined)
  externalGetAllAgents.mockReturnValue([])
  externalIsFromPreset.mockReturnValue(null)
})

describe("dispatchSubagent", () => {
  it("maps an inline subagent def onto executeAgent and returns the result", async () => {
    const res = await dispatchSubagent(subagent, "review this PR")
    expect(mockExecute).toHaveBeenCalledWith("review this PR", {
      toolsEnabled: true,
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

  it("honors toolsEnabled=false (text-only dispatch)", async () => {
    await dispatchSubagent(subagent, "go", { toolsEnabled: false })
    expect(mockExecute.mock.calls[0][1]).toMatchObject({ toolsEnabled: false })
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

  it("reuses a live agent already created from the preset", async () => {
    externalGetAllAgents.mockReturnValue([
      { config: { id: "live-9", metadata: { preset: "claude-code" } } },
    ])
    externalIsFromPreset.mockImplementation((cfg: { metadata?: { preset?: string } }) =>
      cfg.metadata?.preset === "claude-code" ? "claude-code" : null
    )
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
})

describe("runTeam", () => {
  it("starts an existing team by id and returns its terminal status", async () => {
    mockTeam.get.mockReturnValueOnce({ id: "t1" }).mockReturnValueOnce({
      id: "t1",
      status: "completed",
    })
    const res = await runTeam("t1", { ultracode: true })
    expect(mockTeam.start).toHaveBeenCalledWith("t1", { ultracode: true })
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
    expect(mockTeam.start).toHaveBeenCalledWith("adhoc", {})
    expect(res.teamId).toBe("adhoc")
  })

  it("reports unknown status when the team row vanished post-run", async () => {
    mockTeam.get.mockReturnValueOnce({ id: "t1" }).mockReturnValueOnce(undefined)
    const res = await runTeam("t1")
    expect(res.status).toBe("unknown")
  })
})
