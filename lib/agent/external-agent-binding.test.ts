/**
 * @jest-environment jsdom
 */
import { resolveExternalAgentForBinding } from "./external-agent-binding"
import { ExternalAgentBindingError } from "@/lib/ai/agent/external/config/agent-binding"

type Config = {
  id: string
  enabled: boolean
  metadata?: Record<string, unknown>
  createdAt?: string | Date
  cogniaModel?: unknown
}

const storeState: {
  agents: Record<string, Config>
  connectionStatus: Record<string, string>
} = { agents: {}, connectionStatus: {} }
jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: { getState: () => storeState },
}))

const ensureReady = jest.fn()
jest.mock("@/lib/agent/ensure-external-agent-ready", () => ({
  ensureExternalAgentReady: (...a: unknown[]) => ensureReady(...a),
}))

let liveInstances: Array<{ config: Config; connectionStatus: string }> = []
jest.mock("@/lib/ai/agent/external/manager", () => ({
  getExternalAgentManager: () => ({
    getAllAgents: () => liveInstances,
    getAgent: (id: string) => liveInstances.find((i) => i.config.id === id),
  }),
}))

// Registered presets only, like the real `isFromPreset`.
const REGISTERED = new Set(["codex", "codex-app-server", "gemini-cli"])
jest.mock("@/lib/ai/agent/external/config/presets", () => ({
  isFromPreset: (config: Config) => {
    const preset = config.metadata?.preset
    return typeof preset === "string" && REGISTERED.has(preset) ? preset : null
  },
}))

function config(id: string, preset: string, extra: Partial<Config> = {}): Config {
  return { id, enabled: true, metadata: { preset }, ...extra }
}

beforeEach(() => {
  jest.clearAllMocks()
  storeState.agents = {}
  storeState.connectionStatus = {}
  liveInstances = []
  ensureReady.mockResolvedValue({ ok: true, alreadyConnected: false })
})

describe("resolveExternalAgentForBinding", () => {
  it("picks among live configs deterministically when only a preset is given", async () => {
    liveInstances = [
      {
        config: config("late", "codex", { createdAt: new Date("2026-03-01") }),
        connectionStatus: "disconnected",
      },
      {
        config: config("early", "codex", { createdAt: new Date("2025-03-01") }),
        connectionStatus: "disconnected",
      },
      {
        config: config("bound", "codex", { cogniaModel: { providerId: "p", modelId: "m" } }),
        connectionStatus: "connected",
      },
    ]
    await expect(resolveExternalAgentForBinding({ presetId: "codex" })).resolves.toEqual({
      kind: "preset",
      agentId: "early",
    })
    expect(ensureReady).not.toHaveBeenCalled()
  })

  it("does not reuse a live agent whose preset is no longer registered", async () => {
    liveInstances = [{ config: config("orphan", "gone-plugin"), connectionStatus: "connected" }]
    await expect(resolveExternalAgentForBinding({ presetId: "gone-plugin" })).resolves.toEqual({
      kind: "preset",
      agentId: null,
    })
  })

  it("runs a pinned stored config, registering it with the manager first", async () => {
    liveInstances = [{ config: config("lenient", "codex"), connectionStatus: "connected" }]
    storeState.agents = {
      lenient: config("lenient", "codex"),
      strict: config("strict", "codex-app-server"),
    }
    await expect(
      resolveExternalAgentForBinding({ presetId: "codex", configId: "strict" })
    ).resolves.toEqual({ kind: "pinned", agentId: "strict" })
    expect(ensureReady).toHaveBeenCalledWith("strict", { deferConnect: true })
  })

  it("does not re-register a pinned config the manager already holds", async () => {
    liveInstances = [{ config: config("strict", "codex"), connectionStatus: "connected" }]
    storeState.agents = { strict: config("strict", "codex") }
    await resolveExternalAgentForBinding({ presetId: "codex", configId: "strict" })
    expect(ensureReady).not.toHaveBeenCalled()
  })

  it("accepts a pin that only the manager knows (plugin- or host-mounted)", async () => {
    liveInstances = [{ config: config("mounted", "gemini-cli"), connectionStatus: "connected" }]
    await expect(
      resolveExternalAgentForBinding({ presetId: "gemini-cli", configId: "mounted" })
    ).resolves.toEqual({ kind: "pinned", agentId: "mounted" })
  })

  it.each([
    ["missing", {}],
    ["disabled", { strict: config("strict", "codex", { enabled: false }) }],
    ["preset-mismatch", { strict: config("strict", "gemini-cli") }],
  ] as const)("throws for a %s pin and never falls back to a sibling", async (problem, agents) => {
    liveInstances = [{ config: config("lenient", "codex"), connectionStatus: "connected" }]
    storeState.agents = { ...agents, lenient: config("lenient", "codex") }
    const attempt = resolveExternalAgentForBinding({ presetId: "codex", configId: "strict" })
    await expect(attempt).rejects.toBeInstanceOf(ExternalAgentBindingError)
    await expect(attempt).rejects.toMatchObject({ problem, configId: "strict" })
    expect(ensureReady).not.toHaveBeenCalled()
  })

  it("throws unavailable with the readiness detail when registration fails", async () => {
    storeState.agents = { strict: config("strict", "codex") }
    ensureReady.mockResolvedValue({ ok: false, reason: "blocked", detail: "binary missing" })
    await expect(
      resolveExternalAgentForBinding({ presetId: "codex", configId: "strict" })
    ).rejects.toMatchObject({ problem: "unavailable", detail: "binary missing" })
  })

  it("throws missing when the config vanished between the check and registration", async () => {
    storeState.agents = { strict: config("strict", "codex") }
    ensureReady.mockResolvedValue({ ok: false, reason: "unknown-agent" })
    await expect(
      resolveExternalAgentForBinding({ presetId: "codex", configId: "strict" })
    ).rejects.toMatchObject({ problem: "missing" })
  })

  it("treats a blank pin as no pin", async () => {
    liveInstances = [{ config: config("only", "codex"), connectionStatus: "connected" }]
    await expect(
      resolveExternalAgentForBinding({ presetId: "codex", configId: "  " })
    ).resolves.toEqual({ kind: "preset", agentId: "only" })
  })
})
