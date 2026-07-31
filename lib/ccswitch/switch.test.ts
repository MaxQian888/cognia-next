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

// Subscription activation path (official OAuth providers). The orchestrator
// pulls these in via dynamic import; jest's module registry mocks those too.
jest.mock("@/lib/subscription/core/transport", () => ({
  listAccounts: jest.fn(),
  getActiveAccount: jest.fn(),
  setActiveAccount: jest.fn(),
}))

jest.mock("@/lib/subscription/anthropic/discovery", () => ({
  discoverAnthropicAuth: jest.fn(),
  adoptAndActivateDiscoveredAuth: jest.fn(),
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
import { listAccounts, getActiveAccount, setActiveAccount } from "@/lib/subscription/core/transport"
import {
  discoverAnthropicAuth,
  adoptAndActivateDiscoveredAuth,
} from "@/lib/subscription/anthropic/discovery"
import { applySwitch, ccswitchProviderRefId, detectActive, planSwitch, _internals } from "./switch"
import { useSettingsStore } from "@/stores/settings/settings-store"
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
const mListAccounts = listAccounts as jest.Mock
const mGetActive = getActiveAccount as jest.Mock
const mSetActive = setActiveAccount as jest.Mock
const mDiscover = discoverAnthropicAuth as jest.Mock
const mAdoptActivate = adoptAndActivateDiscoveredAuth as jest.Mock

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

  it("flags an official claude provider (no key) as a subscription switch", () => {
    const p = provider({ apiKey: undefined, baseUrl: undefined, kind: "claude" })
    const plan = planSwitch(p, { cognia: true, agents: [] }, {})
    expect(plan.cogniaChanges.useSubscription).toBe(true)
    // The bearer is read at spawn — a subscription switch always restarts.
    expect(plan.cogniaChanges.restartSidecar).toBe(true)
  })

  it("keyed claude providers and keyless non-claude kinds are not subscription switches", () => {
    expect(
      planSwitch(provider({}), { cognia: true, agents: [] }, {}).cogniaChanges.useSubscription
    ).toBe(false)
    expect(
      planSwitch(provider({ apiKey: undefined, kind: "gemini" }), { cognia: true, agents: [] }, {})
        .cogniaChanges.useSubscription
    ).toBe(false)
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
    expect(mSetProviderEnv).toHaveBeenCalledWith("sk-ant-x", "https://api.anthropic.com", {})
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

  it("official provider: re-activates the vault's active anthropic account", async () => {
    mListAccounts.mockResolvedValue([{ id: "acc-1" }, { id: "acc-2" }])
    mGetActive.mockResolvedValue({ activeAccountId: "acc-2", env: [] })
    const plan = planSwitch(
      provider({ apiKey: undefined, baseUrl: undefined, kind: "claude" }),
      { cognia: true, agents: [] },
      { apiKey: "old-relay-key" }
    )
    const result = await applySwitch(plan)

    expect(result.subscription).toEqual({ activated: true, source: "vault" })
    expect(mSetActive).toHaveBeenCalledWith("anthropic", "acc-2")
    expect(mAdoptActivate).not.toHaveBeenCalled()
    // The relay key is still cleared from the sidecar env (bearer wins at spawn).
    expect(mSetProviderEnv).toHaveBeenCalledWith(null, null, {})
  })

  it("official provider: falls back to the first vault account when none is active", async () => {
    mListAccounts.mockResolvedValue([{ id: "acc-1" }, { id: "acc-2" }])
    mGetActive.mockResolvedValue({ activeAccountId: undefined, env: [] })
    const plan = planSwitch(
      provider({ apiKey: undefined, kind: "claude" }),
      { cognia: true, agents: [] },
      {}
    )
    const result = await applySwitch(plan)
    expect(result.subscription).toEqual({ activated: true, source: "vault" })
    expect(mSetActive).toHaveBeenCalledWith("anthropic", "acc-1")
  })

  it("official provider: adopts the local Claude Code login when the vault is empty", async () => {
    mListAccounts.mockResolvedValue([])
    mDiscover.mockResolvedValue({ accessToken: "oat", refreshToken: "ort" })
    mAdoptActivate.mockResolvedValue({ id: "acc-new" })
    const plan = planSwitch(
      provider({ apiKey: undefined, kind: "claude" }),
      { cognia: true, agents: [] },
      {}
    )
    const result = await applySwitch(plan)
    expect(result.subscription).toEqual({ activated: true, source: "adopted" })
    expect(mAdoptActivate).toHaveBeenCalledWith({ accessToken: "oat", refreshToken: "ort" })
    expect(mSetActive).not.toHaveBeenCalled()
  })

  it("official provider: reports none-found when neither vault nor CLI has a login", async () => {
    mListAccounts.mockResolvedValue([])
    mDiscover.mockResolvedValue(null)
    const plan = planSwitch(
      provider({ apiKey: undefined, kind: "claude" }),
      { cognia: true, agents: [] },
      {}
    )
    const result = await applySwitch(plan)
    expect(result.subscription).toEqual({ activated: false, error: "none-found" })
    // The switch itself still commits — the user just gets the hint.
    expect(result.cogniaApplied).toBe(true)
  })

  it("official provider: activation errors are captured, not thrown", async () => {
    mListAccounts.mockRejectedValue(new Error("vault sealed"))
    const plan = planSwitch(
      provider({ apiKey: undefined, kind: "claude" }),
      { cognia: true, agents: [] },
      {}
    )
    const result = await applySwitch(plan)
    expect(result.subscription).toEqual({ activated: false, error: "vault sealed" })
    expect(result.cogniaApplied).toBe(true)
  })

  it("keyed provider switch never touches the subscription module", async () => {
    const plan = planSwitch(provider({}), { cognia: true, agents: [] }, {})
    const result = await applySwitch(plan)
    expect(result.subscription).toBeUndefined()
    expect(mListAccounts).not.toHaveBeenCalled()
  })

  it("official provider outside Tauri skips subscription activation", async () => {
    mIsTauri.mockReturnValue(false)
    const plan = planSwitch(
      provider({ apiKey: undefined, kind: "claude" }),
      { cognia: true, agents: [] },
      {}
    )
    const result = await applySwitch(plan)
    expect(result.subscription).toBeUndefined()
    expect(mListAccounts).not.toHaveBeenCalled()
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

describe("buildProviderRegistration", () => {
  const kimi = (): CcswitchProvider =>
    provider({
      id: "kimi",
      name: "Kimi",
      kind: "claude",
      apiKey: "sk-moon",
      baseUrl: "https://api.moonshot.cn/anthropic",
      model: "kimi-k2-0905",
      opusModel: "kimi-k2-thinking",
      sonnetModel: "kimi-k2-0905",
      haikuModel: "kimi-k2-turbo",
      smallFastModel: "kimi-k2-turbo",
      customHeaders: { "anthropic-beta": "context-1m-2025-08-07" },
    })

  it("registers the relay's tier models under the anthropic provider", () => {
    const reg = _internals.buildProviderRegistration(kimi(), {})
    expect(reg).not.toBeNull()
    const a = reg!.providerSettings.anthropic
    expect(a.enabled).toBe(true)
    expect(a.apiKey).toBe("sk-moon")
    // Deduped by id, priority order preserved (opus, sonnet(dupe id dropped),
    // haiku, small-fast(dupe id dropped), primary(dupe id dropped)).
    expect(a.enabledModels).toEqual(["kimi-k2-thinking", "kimi-k2-0905", "kimi-k2-turbo"])
    expect(reg!.defaultProvider).toBe("anthropic")
    // Primary = ANTHROPIC_MODEL.
    expect(reg!.defaultModel).toBe("kimi-k2-0905")
  })

  it("stamps a 1M context window on every tier when the beta header is present", () => {
    const reg = _internals.buildProviderRegistration(kimi(), {})
    const models = reg!.providerSettings.anthropic.discoveredModels ?? []
    expect(models).toHaveLength(3)
    expect(models.every((m) => m.contextLength === 1_000_000)).toBe(true)
    expect(models[0]).toMatchObject({ id: "kimi-k2-thinking", name: "Kimi · Opus" })
    expect(reg!.customHeaders).toEqual({ "anthropic-beta": "context-1m-2025-08-07" })
  })

  it("does not stamp 1M without a context-1m header", () => {
    const reg = _internals.buildProviderRegistration({ ...kimi(), customHeaders: undefined }, {})
    const models = reg!.providerSettings.anthropic.discoveredModels ?? []
    expect(models.every((m) => m.contextLength === undefined)).toBe(true)
    expect(reg!.customHeaders).toEqual({})
  })

  it("preserves other providers when merging the anthropic slot", () => {
    const reg = _internals.buildProviderRegistration(kimi(), {
      providerSettings: {
        openai: { providerId: "openai", defaultModel: "gpt-4o", enabled: true },
      },
    })
    expect(reg!.providerSettings.openai).toBeDefined()
    expect(reg!.providerSettings.anthropic).toBeDefined()
  })

  it("is provider-agnostic — a GLM coding-plan relay registers identically", () => {
    // Same code path as Kimi, keyed off env shape not provider identity: GLM's
    // Anthropic-compatible coding endpoint declares its own tier models + 1M
    // header and must surface with zero provider-specific handling.
    const glm = provider({
      id: "glm",
      name: "GLM Coding",
      kind: "claude",
      apiKey: "glm-key",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      model: "glm-4.6",
      sonnetModel: "glm-4.6",
      haikuModel: "glm-4.5-air",
      customHeaders: { "anthropic-beta": "context-1m-2025-08-07" },
    })
    const reg = _internals.buildProviderRegistration(glm, {})
    expect(reg).not.toBeNull()
    expect(reg!.providerSettings.anthropic.enabledModels).toEqual(["glm-4.6", "glm-4.5-air"])
    expect(reg!.defaultModel).toBe("glm-4.6")
    const models = reg!.providerSettings.anthropic.discoveredModels ?? []
    expect(models.every((m) => m.contextLength === 1_000_000)).toBe(true)
    expect(models.map((m) => m.name)).toEqual(["GLM Coding · Sonnet", "GLM Coding · Haiku"])
  })

  it("registers a single-model relay that only declares ANTHROPIC_MODEL", () => {
    // Many coding plans set just ANTHROPIC_MODEL (no tier overrides) — still
    // must produce a one-model registration, not an empty group.
    const reg = _internals.buildProviderRegistration(
      provider({ id: "solo", name: "Solo Plan", kind: "claude", model: "some-coder-model" }),
      {}
    )
    expect(reg!.providerSettings.anthropic.enabledModels).toEqual(["some-coder-model"])
    expect(reg!.defaultModel).toBe("some-coder-model")
  })

  it("returns null for non-claude kinds", () => {
    expect(_internals.buildProviderRegistration(provider({ kind: "codex" }), {})).toBeNull()
    expect(_internals.buildProviderRegistration(provider({ kind: "gemini" }), {})).toBeNull()
  })

  it("returns null when the relay declares no models", () => {
    expect(
      _internals.buildProviderRegistration(provider({ kind: "claude", model: undefined }), {})
    ).toBeNull()
  })

  it("treats an absent kind as a claude relay", () => {
    expect(_internals.isClaudeRelayKind(undefined)).toBe(true)
    expect(_internals.isClaudeRelayKind("claude")).toBe(true)
    expect(_internals.isClaudeRelayKind("codex")).toBe(false)
  })
})

describe("applySwitch — relay model registration", () => {
  it("persists the registered models + default and forwards the 1M header", async () => {
    mGet.mockResolvedValue({
      id: "singleton",
      providerSettings: { openai: { providerId: "openai", defaultModel: "gpt-4o", enabled: true } },
    })
    const p = provider({
      id: "kimi",
      name: "Kimi",
      kind: "claude",
      apiKey: "sk-moon",
      baseUrl: "https://api.moonshot.cn/anthropic",
      opusModel: "kimi-k2-thinking",
      sonnetModel: "kimi-k2-0905",
      customHeaders: { "anthropic-beta": "context-1m-2025-08-07" },
    })
    const plan = planSwitch(p, { cognia: true, agents: [] }, { apiKey: "old" })
    await applySwitch(plan)

    const saved = mSave.mock.calls[0][0]
    expect(saved.defaultProvider).toBe("anthropic")
    expect(saved.defaultModel).toBe("kimi-k2-0905")
    expect(saved.providerSettings.anthropic.enabledModels).toEqual([
      "kimi-k2-thinking",
      "kimi-k2-0905",
    ])
    // Untouched sibling provider survives the merge.
    expect(saved.providerSettings.openai).toBeDefined()
    expect(mSetProviderEnv).toHaveBeenCalledWith("sk-moon", "https://api.moonshot.cn/anthropic", {
      "anthropic-beta": "context-1m-2025-08-07",
    })
    expect(mRestart).toHaveBeenCalled()
  })

  it("clears prior relay headers when switching to a plain provider", async () => {
    mGet.mockResolvedValue({ id: "singleton" })
    const plan = planSwitch(
      provider({ kind: "claude", model: "claude-3-opus" }),
      { cognia: true, agents: [] },
      { apiKey: "old" }
    )
    await applySwitch(plan)
    // Third arg is an explicit {} — replaces (clears) any previous headers.
    const call = mSetProviderEnv.mock.calls[0]
    expect(call[2]).toEqual({})
  })

  it("re-seeds the settings store so provider surfaces see the switch without a reload", async () => {
    // Regression: applySwitch used to call `saveSettings` directly, so Dexie
    // held the new relay while the store — what Settings → Providers and the
    // model picker render from — kept the pre-switch settings. `load()`
    // early-returns once `loaded` is true, so the stale list survived until
    // an app restart.
    const stale = {
      id: "singleton" as const,
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
      providerSettings: { openai: { providerId: "openai", enabled: true } },
    }
    useSettingsStore.setState({ settings: stale as never, loaded: true })
    mGet.mockResolvedValue(stale)
    // Mirror the real `saveSettings`: merge the patch over current and return it.
    mSave.mockImplementation(async (patch: Record<string, unknown>) => ({ ...stale, ...patch }))

    const p = provider({
      id: "kimi",
      name: "Kimi",
      kind: "claude",
      apiKey: "sk-moon",
      baseUrl: "https://api.moonshot.cn/anthropic",
      sonnetModel: "kimi-k2-0905",
    })
    await applySwitch(planSwitch(p, { cognia: true, agents: [] }, { apiKey: "old" }))

    const settings = useSettingsStore.getState().settings
    expect(settings?.defaultProvider).toBe("anthropic")
    expect(settings?.defaultModel).toBe("kimi-k2-0905")
    expect(settings?.providerSettings?.anthropic?.enabledModels).toEqual(["kimi-k2-0905"])
    expect(settings?.apiKey).toBe("sk-moon")
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
