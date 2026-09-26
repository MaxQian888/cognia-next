import {
  resolveTeammatePinnedConfigId,
  resolveTeammatePresetId,
  resolveTeammateExternalAgent,
} from "./resolve-external-backing"
import { ExternalAgentBindingError } from "@/lib/ai/agent/external/config/agent-binding"
import type { AgentTeammate, ResolvedCapabilities } from "@/types/agent/agent-team"
import type { TeamRunContext } from "../team-run-context"

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
const supportsExternalAgents = jest.fn(() => true)

const getAgent = jest.fn()
jest.mock("@/lib/ai/agent/external/manager", () => ({
  getExternalAgentManager: () => ({ addAgent, getAllAgents, getAgent }),
}))
const storeState: { agents: Record<string, unknown>; connectionStatus: Record<string, string> } = {
  agents: {},
  connectionStatus: {},
}
jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: { getState: () => storeState },
}))
const ensureReady = jest.fn()
jest.mock("@/lib/agent/ensure-external-agent-ready", () => ({
  ensureExternalAgentReady: (...a: unknown[]) => ensureReady(...a),
}))
jest.mock("@/lib/ai/agent/external/agent-transport", () => ({
  supportsExternalAgents: () => supportsExternalAgents(),
}))
jest.mock("@/lib/ai/agent/external/config/presets", () => ({
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
  supportsExternalAgents.mockReset().mockReturnValue(true)
  getAgent.mockReset().mockReturnValue(undefined)
  ensureReady.mockReset().mockResolvedValue({ ok: true, alreadyConnected: false })
  storeState.agents = {}
  storeState.connectionStatus = {}
})

describe("resolveTeammatePinnedConfigId", () => {
  it("reads the pin only for an external runtime", () => {
    expect(
      resolveTeammatePinnedConfigId(
        teammate({ config: { runtime: "codex", externalAgentConfigId: "strict" } })
      )
    ).toBe("strict")
    expect(
      resolveTeammatePinnedConfigId(
        teammate({ config: { runtime: "claude", externalAgentConfigId: "strict" } })
      )
    ).toBeUndefined()
    expect(
      resolveTeammatePinnedConfigId(
        teammate({ config: { runtime: "codex", externalAgentConfigId: " " } })
      )
    ).toBeUndefined()
  })
})

describe("resolveTeammateExternalAgent with a pinned config", () => {
  const presetOf = (cfg: { metadata?: { preset?: string } }) => cfg.metadata?.preset ?? null

  it("runs exactly the pinned config instead of the preset's first live one", async () => {
    isFromPreset.mockImplementation(presetOf)
    getAllAgents.mockReturnValue([
      {
        config: { id: "lenient", enabled: true, metadata: { preset: "codex" } },
        connectionStatus: "connected",
      },
    ])
    storeState.agents = {
      lenient: { id: "lenient", enabled: true, metadata: { preset: "codex" } },
      strict: { id: "strict", enabled: true, metadata: { preset: "codex-app-server" } },
    }
    const c = ctx()
    const id = await resolveTeammateExternalAgent(
      teammate({ config: { runtime: "codex", externalAgentConfigId: "strict" } }),
      EMPTY_CAPS,
      c
    )
    expect(id).toBe("strict")
    expect(ensureReady).toHaveBeenCalledWith("strict", { deferConnect: true })
    // No Codex surface rewrite, no spawn, nothing cached under the preset.
    expect(resolvePreferredCodex).not.toHaveBeenCalled()
    expect(createAgentFromPreset).not.toHaveBeenCalled()
    expect(addAgent).not.toHaveBeenCalled()
    expect(c.externalAgentInstances.size).toBe(0)
  })

  it("fails loudly for a missing pin rather than spawning or borrowing a config", async () => {
    isFromPreset.mockImplementation(presetOf)
    getAllAgents.mockReturnValue([
      {
        config: { id: "lenient", enabled: true, metadata: { preset: "codex" } },
        connectionStatus: "connected",
      },
    ])
    createAgentFromPreset.mockReturnValue({ id: "fresh" })
    await expect(
      resolveTeammateExternalAgent(
        teammate({ config: { runtime: "codex", externalAgentConfigId: "deleted" } }),
        EMPTY_CAPS,
        ctx()
      )
    ).rejects.toBeInstanceOf(ExternalAgentBindingError)
    expect(createAgentFromPreset).not.toHaveBeenCalled()
    expect(addAgent).not.toHaveBeenCalled()
  })

  it("ignores a stale pin on a claude teammate whose preset comes from capabilities", async () => {
    isFromPreset.mockImplementation(presetOf)
    getAllAgents.mockReturnValue([
      {
        config: { id: "cc", enabled: true, metadata: { preset: "claude-code" } },
        connectionStatus: "connected",
      },
    ])
    const id = await resolveTeammateExternalAgent(
      teammate({ config: { runtime: "claude", externalAgentConfigId: "deleted" } }),
      { ...EMPTY_CAPS, externalAgentPresetIds: ["claude-code"] },
      ctx()
    )
    expect(id).toBe("cc")
  })
})

describe("resolveTeammateExternalAgent preset fallback order", () => {
  it("picks the earliest-created enabled config, whatever order the manager lists them in", async () => {
    isFromPreset.mockImplementation(
      (cfg: { metadata?: { preset?: string } }) => cfg.metadata?.preset ?? null
    )
    getAllAgents.mockReturnValue([
      {
        config: {
          id: "newer",
          enabled: true,
          metadata: { preset: "gemini-cli" },
          createdAt: new Date("2026-02-01"),
        },
        connectionStatus: "disconnected",
      },
      {
        config: {
          id: "disabled",
          enabled: false,
          metadata: { preset: "gemini-cli" },
          createdAt: new Date("2020-01-01"),
        },
        connectionStatus: "connected",
      },
      {
        config: {
          id: "older",
          enabled: true,
          metadata: { preset: "gemini-cli" },
          createdAt: new Date("2025-02-01"),
        },
        connectionStatus: "disconnected",
      },
    ])
    const id = await resolveTeammateExternalAgent(
      teammate({ config: { runtime: "gemini-cli" } }),
      EMPTY_CAPS,
      ctx()
    )
    expect(id).toBe("older")
  })
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

  it("does not reuse a saved agent's unrelated gateway account and defers native login for bound tasks", async () => {
    const cogniaModel = {
      providerId: "plugin:kimi:subscription",
      modelId: "kimi-for-coding",
      accountId: "team-account",
    }
    getAllAgents.mockReturnValue([
      { config: { id: "saved", cogniaModel: { ...cogniaModel, accountId: "private-account" } } },
    ])
    isFromPreset.mockReturnValue("codex")
    createAgentFromPreset.mockReturnValue({ id: "team-agent" })
    const id = await resolveTeammateExternalAgent(
      teammate({ config: { runtime: "codex", cogniaModel } }),
      EMPTY_CAPS,
      ctx()
    )
    expect(id).toBe("team-agent")
    expect(addAgent).toHaveBeenCalledWith({ id: "team-agent" }, { connect: false })
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

  it("returns null on hosts without external-agent support (browser shell)", async () => {
    supportsExternalAgents.mockReturnValue(false)
    const tm = teammate({ config: { runtime: "codex" } } as Partial<AgentTeammate>)
    const result = await resolveTeammateExternalAgent(tm, EMPTY_CAPS, ctx())
    expect(result).toBeNull()
    // Never reaches the manager — no addAgent, no connect-time throw.
    expect(addAgent).not.toHaveBeenCalled()
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
