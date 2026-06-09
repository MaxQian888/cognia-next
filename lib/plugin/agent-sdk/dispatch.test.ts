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
    expect(res).toEqual({
      text: "reviewed",
      channel: "sidecar",
      toolsAvailable: true,
      finishReason: "stop",
    })
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
