// Mock IPC + Dexie so the orchestrator runs in pure JS-land.

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(),
}))

jest.mock("@/lib/claude/ipc", () => ({
  hasApiKey: jest.fn(),
  restartSidecar: jest.fn(),
  setProviderEnv: jest.fn(),
}))

jest.mock("@/lib/db/settings", () => ({
  saveSettings: jest.fn(),
  getSettings: jest.fn(),
}))

jest.mock("./client", () => ({
  writeClaudeSettingsEnv: jest.fn(),
  writeCodexAuthEnv: jest.fn(),
  writeGeminiSettingsEnv: jest.fn(),
  writeOpencodeAuthEnv: jest.fn(),
}))

import { restartSidecar, setProviderEnv } from "@/lib/claude/ipc"
import { saveSettings, getSettings } from "@/lib/db/settings"
import { isTauri } from "@/lib/tauri"

import {
  writeClaudeSettingsEnv,
  writeCodexAuthEnv,
  writeGeminiSettingsEnv,
  writeOpencodeAuthEnv,
} from "./client"
import { applySwitch, ccswitchProviderRefId, detectActive, planSwitch, _internals } from "./switch"
import type { CcswitchProvider, SwitchScope } from "@/types/ccswitch"

const mIsTauri = isTauri as jest.Mock
const mSetProviderEnv = setProviderEnv as jest.Mock
const mRestart = restartSidecar as jest.Mock
const mSave = saveSettings as jest.Mock
const mGet = getSettings as jest.Mock
const mWriteClaude = writeClaudeSettingsEnv as jest.Mock
const mWriteCodex = writeCodexAuthEnv as jest.Mock
const mWriteGemini = writeGeminiSettingsEnv as jest.Mock
const mWriteOpencode = writeOpencodeAuthEnv as jest.Mock

function provider(overrides: Partial<CcswitchProvider>): CcswitchProvider {
  return {
    id: "p1",
    name: "Anthropic Official",
    apiKey: "sk-ant-x",
    baseUrl: "https://api.anthropic.com",
    ...overrides,
  }
}

beforeEach(() => {
  jest.resetAllMocks()
  mIsTauri.mockReturnValue(true)
})

describe("ccswitchProviderRefId", () => {
  it("prefixes the id", () => {
    expect(ccswitchProviderRefId(provider({ id: "abc" }))).toBe("ccswitch:abc")
  })
})

describe("planSwitch", () => {
  it("targets cognia-next and a supported agent", () => {
    const p = provider({})
    const scope: SwitchScope = { cognia: true, agents: ["claude-code"] }
    const plan = planSwitch(p, scope, {
      apiKey: "old-key",
      apiBaseUrl: "https://old",
      activeProviderId: "ccswitch:other",
    })

    expect(plan.cogniaChanges.apiKeyAfter).toBe("sk-ant-x")
    expect(plan.cogniaChanges.baseUrlAfter).toBe("https://api.anthropic.com")
    expect(plan.cogniaChanges.activeProviderIdAfter).toBe("ccswitch:p1")
    expect(plan.cogniaChanges.restartSidecar).toBe(true)

    expect(plan.agentChanges).toHaveLength(1)
    const ac = plan.agentChanges[0]
    expect(ac.agentId).toBe("claude-code")
    expect(ac.unsupported).toBe(false)
    expect(ac.envUpdates).toEqual([
      { key: "ANTHROPIC_API_KEY", value: "sk-ant-x" },
      { key: "ANTHROPIC_BASE_URL", value: "https://api.anthropic.com" },
    ])
  })

  it("marks unsupported agents (claude-desktop)", () => {
    const plan = planSwitch(provider({}), { cognia: true, agents: ["claude-desktop"] }, {})
    expect(plan.agentChanges[0].unsupported).toBe(true)
    expect(plan.agentChanges[0].envUpdates).toEqual([])
  })

  it("emits gemini-specific env updates for the gemini agent", () => {
    const p = provider({ apiKey: "g-key", baseUrl: "https://proxy" })
    const plan = planSwitch(p, { cognia: true, agents: ["gemini"] }, {})
    const ac = plan.agentChanges[0]
    expect(ac.agentId).toBe("gemini")
    expect(ac.unsupported).toBe(false)
    expect(ac.targetPath).toBe("~/.gemini/settings.json")
    expect(ac.envUpdates).toEqual([
      { key: "GEMINI_API_KEY", value: "g-key" },
      { key: "GOOGLE_GEMINI_BASE_URL", value: "https://proxy" },
    ])
  })

  it("emits opencode env updates with a derived __provider for the opencode agent", () => {
    const p = provider({ apiKey: "sk-ant-x", kind: "claude" })
    const plan = planSwitch(p, { cognia: true, agents: ["opencode"] }, {})
    const ac = plan.agentChanges[0]
    expect(ac.agentId).toBe("opencode")
    expect(ac.unsupported).toBe(false)
    expect(ac.targetPath).toBe("~/.local/share/opencode/auth.json")
    expect(ac.envUpdates).toEqual([
      { key: "OPENCODE_API_KEY", value: "sk-ant-x" },
      { key: "__provider", value: "anthropic" },
    ])
  })

  it("maps codex-kind providers to the openai opencode entry", () => {
    const p = provider({ apiKey: "sk-oa", kind: "codex" })
    const plan = planSwitch(p, { cognia: true, agents: ["opencode"] }, {})
    expect(plan.agentChanges[0].envUpdates).toContainEqual({ key: "__provider", value: "openai" })
  })

  it("emits codex-specific env updates for the codex agent", () => {
    const p = provider({ apiKey: "sk-openai-x", baseUrl: "https://api.openai.com" })
    const plan = planSwitch(p, { cognia: true, agents: ["codex"] }, {})
    const ac = plan.agentChanges[0]
    expect(ac.agentId).toBe("codex")
    expect(ac.unsupported).toBe(false)
    expect(ac.targetPath).toBe("~/.codex/auth.json")
    expect(ac.envUpdates).toEqual([{ key: "OPENAI_API_KEY", value: "sk-openai-x" }])
  })

  it("codex agent emits null when provider has no api key", () => {
    const plan = planSwitch(
      provider({ apiKey: undefined }),
      { cognia: true, agents: ["codex"] },
      {}
    )
    expect(plan.agentChanges[0].envUpdates).toEqual([{ key: "OPENAI_API_KEY", value: null }])
  })

  it("emits null env values when the provider has no key/url", () => {
    const plan = planSwitch(
      provider({ apiKey: undefined, baseUrl: undefined }),
      { cognia: true, agents: ["claude-code"] },
      {}
    )
    expect(plan.agentChanges[0].envUpdates).toEqual([
      { key: "ANTHROPIC_API_KEY", value: null },
      { key: "ANTHROPIC_BASE_URL", value: null },
    ])
  })

  it("flags restartSidecar=false when nothing changes", () => {
    const p = provider({})
    const plan = planSwitch(
      p,
      { cognia: true, agents: [] },
      {
        apiKey: p.apiKey,
        apiBaseUrl: p.baseUrl,
      }
    )
    expect(plan.cogniaChanges.restartSidecar).toBe(false)
  })
})

describe("applySwitch", () => {
  it("commits to Dexie + sidecar and writes claude-code settings", async () => {
    mWriteClaude.mockResolvedValue({
      path: "/u/.claude/settings.json",
      backupPath: "/u/.claude/settings.json.bak.1",
    })
    const plan = planSwitch(
      provider({}),
      { cognia: true, agents: ["claude-code"] },
      { apiKey: "old", apiBaseUrl: undefined }
    )
    const result = await applySwitch(plan)

    expect(result.cogniaApplied).toBe(true)
    expect(mSave).toHaveBeenCalledWith({
      apiKey: "sk-ant-x",
      apiBaseUrl: "https://api.anthropic.com",
      activeProviderId: "ccswitch:p1",
    })
    expect(mSetProviderEnv).toHaveBeenCalledWith("sk-ant-x", "https://api.anthropic.com")
    expect(mRestart).toHaveBeenCalled()
    expect(mWriteClaude).toHaveBeenCalledWith({
      ANTHROPIC_API_KEY: "sk-ant-x",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    })
    expect(result.agentResults).toEqual([
      {
        agentId: "claude-code",
        ok: true,
        path: "/u/.claude/settings.json",
        backupPath: "/u/.claude/settings.json.bak.1",
      },
    ])
  })

  it("skips sidecar IPC outside Tauri", async () => {
    mIsTauri.mockReturnValue(false)
    const plan = planSwitch(provider({}), { cognia: true, agents: [] }, {})
    await applySwitch(plan)
    expect(mSetProviderEnv).not.toHaveBeenCalled()
    expect(mRestart).not.toHaveBeenCalled()
    expect(mSave).toHaveBeenCalled()
  })

  it("does not restart when the plan says nothing changed", async () => {
    const p = provider({})
    const plan = planSwitch(
      p,
      { cognia: true, agents: [] },
      {
        apiKey: p.apiKey,
        apiBaseUrl: p.baseUrl,
      }
    )
    await applySwitch(plan)
    expect(mRestart).not.toHaveBeenCalled()
  })

  it("reports per-agent failures without aborting", async () => {
    mWriteClaude.mockRejectedValue(new Error("boom"))
    const plan = planSwitch(provider({}), { cognia: true, agents: ["claude-code"] }, {})
    const result = await applySwitch(plan)

    // Cognia-side still applied — that's the point of partial-success semantics.
    expect(result.cogniaApplied).toBe(true)
    expect(result.agentResults[0]).toEqual({
      agentId: "claude-code",
      ok: false,
      error: "boom",
    })
  })

  it("records unsupported agents as not-ok rather than failing", async () => {
    const plan = planSwitch(provider({}), { cognia: true, agents: ["claude-desktop"] }, {})
    const result = await applySwitch(plan)
    expect(result.agentResults[0]).toMatchObject({
      agentId: "claude-desktop",
      ok: false,
    })
    expect(mWriteClaude).not.toHaveBeenCalled()
    expect(mWriteCodex).not.toHaveBeenCalled()
  })

  it("commits to ~/.gemini/settings.json when gemini is selected", async () => {
    mWriteGemini.mockResolvedValue({
      path: "/u/.gemini/settings.json",
      backupPath: "/u/.gemini/settings.json.bak.1",
    })
    const p = provider({ apiKey: "g-key", baseUrl: "https://proxy" })
    const plan = planSwitch(p, { cognia: true, agents: ["gemini"] }, {})
    const result = await applySwitch(plan)

    expect(mWriteGemini).toHaveBeenCalledWith({
      GEMINI_API_KEY: "g-key",
      GOOGLE_GEMINI_BASE_URL: "https://proxy",
    })
    expect(mWriteClaude).not.toHaveBeenCalled()
    expect(result.agentResults[0]).toEqual({
      agentId: "gemini",
      ok: true,
      path: "/u/.gemini/settings.json",
      backupPath: "/u/.gemini/settings.json.bak.1",
    })
  })

  it("commits to opencode auth.json with the derived provider", async () => {
    mWriteOpencode.mockResolvedValue({
      path: "/u/.local/share/opencode/auth.json",
    })
    const p = provider({ apiKey: "sk-ant-x", kind: "claude" })
    const plan = planSwitch(p, { cognia: true, agents: ["opencode"] }, {})
    const result = await applySwitch(plan)

    expect(mWriteOpencode).toHaveBeenCalledWith({
      OPENCODE_API_KEY: "sk-ant-x",
      __provider: "anthropic",
    })
    expect(result.agentResults[0]).toMatchObject({ agentId: "opencode", ok: true })
  })

  it("surfaces drift_detected from the gemini write as an error", async () => {
    mWriteGemini.mockRejectedValue(new Error("drift_detected"))
    const plan = planSwitch(provider({}), { cognia: true, agents: ["gemini"] }, {})
    const result = await applySwitch(plan)
    expect(result.agentResults[0]).toMatchObject({
      agentId: "gemini",
      ok: false,
      error: "drift_detected",
    })
  })

  it("commits to ~/.codex/auth.json when codex is selected", async () => {
    mWriteCodex.mockResolvedValue({
      path: "/u/.codex/auth.json",
      backupPath: "/u/.codex/auth.json.bak.1",
    })
    const p = provider({ apiKey: "sk-openai-x", baseUrl: "https://api.openai.com" })
    const plan = planSwitch(p, { cognia: true, agents: ["codex"] }, {})
    const result = await applySwitch(plan)

    expect(mWriteCodex).toHaveBeenCalledWith({ OPENAI_API_KEY: "sk-openai-x" })
    expect(mWriteClaude).not.toHaveBeenCalled()
    expect(result.agentResults[0]).toEqual({
      agentId: "codex",
      ok: true,
      path: "/u/.codex/auth.json",
      backupPath: "/u/.codex/auth.json.bak.1",
    })
  })

  it("surfaces drift_detected from the codex write as an error", async () => {
    mWriteCodex.mockRejectedValue(new Error("drift_detected"))
    const plan = planSwitch(provider({}), { cognia: true, agents: ["codex"] }, {})
    const result = await applySwitch(plan)
    expect(result.agentResults[0]).toMatchObject({
      agentId: "codex",
      ok: false,
      error: "drift_detected",
    })
  })
})

describe("detectActive", () => {
  it("matches cognia by (apiKey, baseUrl) tuple", async () => {
    mGet.mockResolvedValue({
      id: "singleton",
      apiKey: "sk-ant-x",
      apiBaseUrl: "https://api.anthropic.com",
      alwaysAllowTools: [],
      builtinTools: {},
    })
    const providers = [provider({ id: "a" }), provider({ id: "b", apiKey: "other" })]
    const state = await detectActive(providers)
    expect(state.cognia).toBe("a")
    expect(state.drift).toBe(false)
  })

  it("returns undefined cognia when no provider matches", async () => {
    mGet.mockResolvedValue({
      id: "singleton",
      apiKey: "unknown",
      apiBaseUrl: undefined,
      alwaysAllowTools: [],
      builtinTools: {},
    })
    const state = await detectActive([provider({ id: "a" })])
    expect(state.cognia).toBeUndefined()
  })

  it("flags drift when cognia and an agent disagree", async () => {
    mGet.mockResolvedValue({
      id: "singleton",
      apiKey: "sk-ant-x",
      apiBaseUrl: "https://api.anthropic.com",
      alwaysAllowTools: [],
      builtinTools: {},
    })
    const providers = [
      provider({ id: "a" }),
      provider({ id: "b", apiKey: "sk-moon", baseUrl: "https://moon" }),
    ]
    const state = await detectActive(providers, {
      agentReaders: {
        "claude-code": async () => ({ apiKey: "sk-moon", baseUrl: "https://moon" }),
      },
    })
    expect(state.cognia).toBe("a")
    expect(state.agents["claude-code"]).toBe("b")
    expect(state.drift).toBe(true)
  })

  it("treats unreadable agents as having no active provider", async () => {
    mGet.mockResolvedValue({
      id: "singleton",
      apiKey: undefined,
      alwaysAllowTools: [],
      builtinTools: {},
    })
    const state = await detectActive([provider({ id: "a" })], {
      agentReaders: {
        "claude-code": async () => {
          throw new Error("permission denied")
        },
      },
    })
    expect(state.agents["claude-code"]).toBeUndefined()
    expect(state.drift).toBe(false)
  })
})

describe("internals", () => {
  it("matchProvider trims whitespace", () => {
    const p = provider({ apiKey: "sk-x", baseUrl: "https://e" })
    expect(_internals.matchProvider([p], { apiKey: "  sk-x ", baseUrl: " https://e" })).toBe(p)
  })

  it("matchProvider returns undefined when both fields empty", () => {
    expect(_internals.matchProvider([provider({})], {})).toBeUndefined()
  })

  it("detectDrift treats undefined-cognia as non-drift when all agents also undefined", () => {
    expect(_internals.detectDrift(undefined, { "claude-code": undefined })).toBe(false)
  })

  it("envUpdatesForProvider strips whitespace-only fields to null (claude-code)", () => {
    const updates = _internals.envUpdatesForProvider(
      "claude-code",
      provider({ apiKey: "  ", baseUrl: "" })
    )
    expect(updates).toEqual([
      { key: "ANTHROPIC_API_KEY", value: null },
      { key: "ANTHROPIC_BASE_URL", value: null },
    ])
  })

  it("envUpdatesForProvider emits OPENAI_API_KEY only for codex", () => {
    const updates = _internals.envUpdatesForProvider(
      "codex",
      provider({ apiKey: "sk-openai", baseUrl: "https://api.openai.com" })
    )
    expect(updates).toEqual([{ key: "OPENAI_API_KEY", value: "sk-openai" }])
  })

  it("envUpdatesForProvider emits opencode key + derived provider", () => {
    const updates = _internals.envUpdatesForProvider(
      "opencode",
      provider({ apiKey: "sk-x", kind: "gemini" })
    )
    expect(updates).toEqual([
      { key: "OPENCODE_API_KEY", value: "sk-x" },
      { key: "__provider", value: "google" },
    ])
  })

  it("SUPPORTED_AGENTS contains claude-code, codex, gemini, opencode in v3", () => {
    expect(_internals.SUPPORTED_AGENTS.has("claude-code")).toBe(true)
    expect(_internals.SUPPORTED_AGENTS.has("codex")).toBe(true)
    expect(_internals.SUPPORTED_AGENTS.has("gemini")).toBe(true)
    expect(_internals.SUPPORTED_AGENTS.has("opencode")).toBe(true)
    expect(_internals.SUPPORTED_AGENTS.has("claude-desktop")).toBe(false)
  })
})
