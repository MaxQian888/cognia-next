import { resolveTeammatePresetId, resolveTeammateExternalAgent } from "./resolve-external-backing"
import type { AgentTeammate, ResolvedCapabilities } from "@/types/agent/agent-team"
import type { TeamRunContext } from "./team-run-context"

const EMPTY_CAPS: ResolvedCapabilities = {
  mcpServerIds: [],
  skillIds: [],
  nativeAnthropicToolIds: [],
  characterPackIds: [],
  externalAgentPresetIds: [],
  subagentIds: [],
  a2uiTemplateIds: [],
}

function teammate(overrides: Partial<AgentTeammate> = {}): AgentTeammate {
  return {
    id: "tm1",
    name: "Worker",
    role: "worker",
    status: "idle",
    ...overrides,
  } as AgentTeammate
}

const addAgent = jest.fn()
const getAllAgents = jest.fn()
const createAgentFromPreset = jest.fn()
const isFromPreset = jest.fn()
const resolvePreferredCodex = jest.fn<Promise<string>, []>(async () => "codex")

jest.mock("@/lib/ai/agent/external/manager", () => ({
  getExternalAgentManager: () => ({ addAgent, getAllAgents }),
}))
jest.mock("@/lib/ai/agent/external/presets", () => ({
  createAgentFromPreset: (...args: unknown[]) => createAgentFromPreset(...args),
  isFromPreset: (...args: unknown[]) => isFromPreset(...args),
  resolvePreferredCodexExecutablePresetId: () => resolvePreferredCodex(),
}))

function ctx(): TeamRunContext {
  return { externalAgentInstances: new Map<string, string>() } as unknown as TeamRunContext
}

beforeEach(() => {
  addAgent.mockReset()
  getAllAgents.mockReset().mockReturnValue([])
  createAgentFromPreset.mockReset()
  isFromPreset.mockReset().mockReturnValue(null)
  resolvePreferredCodex.mockReset().mockResolvedValue("codex")
})

describe("resolveTeammatePresetId", () => {
  it("returns null for the default claude runtime with no preset caps", () => {
    expect(resolveTeammatePresetId(teammate(), EMPTY_CAPS)).toBeNull()
  })

  it("maps a non-claude runtime directly to its preset id", () => {
    expect(resolveTeammatePresetId(teammate({ config: { runtime: "codex" } }), EMPTY_CAPS)).toBe(
      "codex"
    )
  })

  it("falls back to the first resolved external preset id for a claude runtime", () => {
    expect(
      resolveTeammatePresetId(teammate(), {
        ...EMPTY_CAPS,
        externalAgentPresetIds: ["claude-code"],
      })
    ).toBe("claude-code")
  })
})

describe("resolveTeammateExternalAgent", () => {
  it("returns null for the default path", async () => {
    expect(await resolveTeammateExternalAgent(teammate(), EMPTY_CAPS, ctx())).toBeNull()
  })

  it("spawns and registers a new agent from the preset, caching per-run", async () => {
    createAgentFromPreset.mockReturnValue({ id: "agent-1", metadata: { preset: "codex" } })
    const c = ctx()
    const id = await resolveTeammateExternalAgent(
      teammate({ config: { runtime: "codex" } }),
      EMPTY_CAPS,
      c
    )
    expect(id).toBe("agent-1")
    expect(addAgent).toHaveBeenCalledTimes(1)
    expect(c.externalAgentInstances.get("codex")).toBe("agent-1")

    // Second call hits the cache — no second spawn.
    const again = await resolveTeammateExternalAgent(
      teammate({ config: { runtime: "codex" } }),
      EMPTY_CAPS,
      c
    )
    expect(again).toBe("agent-1")
    expect(addAgent).toHaveBeenCalledTimes(1)
  })

  it("reuses a live agent already created from the preset", async () => {
    getAllAgents.mockReturnValue([{ config: { id: "live-7", metadata: { preset: "gemini-cli" } } }])
    isFromPreset.mockImplementation((cfg: { metadata?: { preset?: string } }) =>
      cfg.metadata?.preset === "gemini-cli" ? "gemini-cli" : null
    )
    const id = await resolveTeammateExternalAgent(
      teammate({ config: { runtime: "gemini-cli" } }),
      EMPTY_CAPS,
      ctx()
    )
    expect(id).toBe("live-7")
    expect(addAgent).not.toHaveBeenCalled()
    expect(createAgentFromPreset).not.toHaveBeenCalled()
  })

  it("upgrades runtime 'codex' to the native app-server when the codex CLI is present", async () => {
    resolvePreferredCodex.mockResolvedValue("codex-app-server")
    createAgentFromPreset.mockReturnValue({
      id: "agent-x",
      metadata: { preset: "codex-app-server" },
    })
    const c = ctx()
    const id = await resolveTeammateExternalAgent(
      teammate({ config: { runtime: "codex" } }),
      EMPTY_CAPS,
      c
    )
    expect(id).toBe("agent-x")
    expect(createAgentFromPreset).toHaveBeenCalledWith("codex-app-server")
    expect(c.externalAgentInstances.get("codex-app-server")).toBe("agent-x")
  })

  it("does not upgrade a non-codex runtime", async () => {
    createAgentFromPreset.mockReturnValue({ id: "g1", metadata: { preset: "gemini-cli" } })
    await resolveTeammateExternalAgent(
      teammate({ config: { runtime: "gemini-cli" } }),
      EMPTY_CAPS,
      ctx()
    )
    expect(resolvePreferredCodex).not.toHaveBeenCalled()
    expect(createAgentFromPreset).toHaveBeenCalledWith("gemini-cli")
  })

  it("returns null when the preset is unknown (caller falls back)", async () => {
    createAgentFromPreset.mockReturnValue(null)
    const id = await resolveTeammateExternalAgent(
      teammate({ config: { runtime: "codex" } }),
      EMPTY_CAPS,
      ctx()
    )
    expect(id).toBeNull()
    expect(addAgent).not.toHaveBeenCalled()
  })
})
