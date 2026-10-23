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

import { writeClaudeSettingsEnv, writeOpencodeAuthEnv } from "./client"
import { listAccounts, getActiveAccount, setActiveAccount } from "@/lib/subscription/core/transport"
import {
  discoverAnthropicAuth,
  adoptAndActivateDiscoveredAuth,
} from "@/lib/subscription/anthropic/discovery"
import {
  applySwitch,
  ccswitchProviderRefId,
  detectActive,
  isOfficialClaudeProvider,
  planSwitch,
} from "./switch"
import { useSettingsStore } from "@/stores/settings/settings-store"
import type { CcswitchProvider } from "@/types/ccswitch"
import { ANTHROPIC_FALLBACK_MODEL_ID } from "@cognia/provider-types/built-in-provider-catalog"

const mIsTauri = isTauri as jest.Mock
const mSetProviderEnv = setProviderEnv as jest.Mock
const mRestart = restartSidecar as jest.Mock
const mSave = saveSettings as jest.Mock
const mGet = getSettings as jest.Mock
const mWriteClaude = writeClaudeSettingsEnv as jest.Mock
const mWriteOpencode = writeOpencodeAuthEnv as jest.Mock
const mListAccounts = listAccounts as jest.Mock
const mGetActive = getActiveAccount as jest.Mock
const mSetActive = setActiveAccount as jest.Mock
const mDiscover = discoverAnthropicAuth as jest.Mock
const mAdoptActivate = adoptAndActivateDiscoveredAuth as jest.Mock

function provider(overrides: Partial<CcswitchProvider>): CcswitchProvider {
  return {
    id: "p1",
    kind: "claude",
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
      activeProviderId: "ccswitch:claude:p1",
      defaultProvider: "anthropic",
      defaultModel: ANTHROPIC_FALLBACK_MODEL_ID,
      providerSettings: {
        anthropic: {
          providerId: "anthropic",
          enabled: true,
          apiKey: "sk-ant-x",
          baseURL: "https://api.anthropic.com",
          customHeaders: {},
          defaultModel: ANTHROPIC_FALLBACK_MODEL_ID,
          enabledModels: undefined,
          discoveredModels: [],
          discoveredModelsLastFetched: expect.any(Number),
        },
      },
    })
    expect(mSetProviderEnv).toHaveBeenCalledWith("sk-ant-x", "https://api.anthropic.com", {})
    expect(mRestart).toHaveBeenCalled()
    expect(mWriteClaude).toHaveBeenCalledWith({
      ANTHROPIC_AUTH_TOKEN: null,
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
    expect(mWriteOpencode).not.toHaveBeenCalled()
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
      provider({ apiKey: undefined, baseUrl: undefined, kind: "claude" }),
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
      provider({ apiKey: undefined, baseUrl: undefined, kind: "claude" }),
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
      provider({ apiKey: undefined, baseUrl: undefined, kind: "claude" }),
      { cognia: true, agents: [] },
      {}
    )
    const result = await applySwitch(plan)
    expect(result.subscription).toEqual({ activated: false, error: "none-found" })
    // Failed activation must preserve current credentials.
    expect(result.cogniaApplied).toBe(false)
    expect(mSave).not.toHaveBeenCalled()
    expect(mSetProviderEnv).not.toHaveBeenCalled()
  })

  it("official provider: activation errors are captured, not thrown", async () => {
    mListAccounts.mockRejectedValue(new Error("vault sealed"))
    const plan = planSwitch(
      provider({ apiKey: undefined, baseUrl: undefined, kind: "claude" }),
      { cognia: true, agents: [] },
      {}
    )
    const result = await applySwitch(plan)
    expect(result.subscription).toEqual({ activated: false, error: "vault sealed" })
    expect(result.cogniaApplied).toBe(false)
    expect(mSave).not.toHaveBeenCalled()
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
      provider({ apiKey: undefined, baseUrl: undefined, kind: "claude" }),
      { cognia: true, agents: [] },
      {}
    )
    const result = await applySwitch(plan)
    expect(result.subscription).toBeUndefined()
    expect(mListAccounts).not.toHaveBeenCalled()
  })

  it.each(["gemini", "codex"] as const)(
    "rejects incompatible %s propagation without writing credentials",
    async (agentId) => {
      const plan = planSwitch(provider({}), { cognia: true, agents: [agentId] }, {})
      const result = await applySwitch(plan)
      expect(result.agentResults).toEqual([expect.objectContaining({ agentId, ok: false })])
      expect(mWriteClaude).not.toHaveBeenCalled()
      expect(mWriteOpencode).not.toHaveBeenCalled()
    }
  )

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

  it("surfaces drift_detected from a supported OpenCode write", async () => {
    mWriteOpencode.mockRejectedValue(new Error("drift_detected"))
    const result = await applySwitch(
      planSwitch(provider({}), { cognia: true, agents: ["opencode"] }, {})
    )
    expect(result.agentResults[0]).toMatchObject({
      agentId: "opencode",
      ok: false,
      error: "drift_detected",
    })
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

describe("current CC Switch identities and protocol boundaries", () => {
  it("qualifies provider references by app type", () => {
    expect(ccswitchProviderRefId(provider({ id: "default", kind: "claude" }))).toBe(
      "ccswitch:claude:default"
    )
    expect(ccswitchProviderRefId(provider({ id: "default", kind: "codex" }))).toBe(
      "ccswitch:codex:default"
    )
  })

  it("never treats a keyless managed OAuth card as Anthropic official", () => {
    expect(
      isOfficialClaudeProvider(
        provider({ kind: "claude", apiKey: undefined, providerType: "github_copilot" })
      )
    ).toBe(false)
    expect(
      isOfficialClaudeProvider(
        provider({ kind: "claude", apiKey: undefined, baseUrl: "https://relay.test" })
      )
    ).toBe(false)
  })

  it("blocks a non-Anthropic provider before any settings or credential writes", async () => {
    const plan = planSwitch(provider({ kind: "agy" }), { cognia: true, agents: [] }, {})
    await expect(applySwitch(plan)).rejects.toThrow(/protocol/i)
    expect(mSave).not.toHaveBeenCalled()
    expect(mSetProviderEnv).not.toHaveBeenCalled()
  })

  it("clears the competing Claude auth token during explicit API-key propagation", () => {
    const plan = planSwitch(
      provider({ kind: "claude" }),
      { cognia: true, agents: ["claude-code"] },
      {}
    )
    expect(plan.agentChanges[0].envUpdates).toContainEqual({
      key: "ANTHROPIC_AUTH_TOKEN",
      value: null,
    })
  })

  it("does not mark another app with the same id as active", async () => {
    mGet.mockResolvedValue({ apiKey: "sk-ant-x", apiBaseUrl: "https://api.anthropic.com" })
    const state = await detectActive([provider({ kind: "codex" }), provider({ kind: "claude" })])
    expect(state.cognia).toBe("ccswitch:claude:p1")
  })
})

it("rejects managed OAuth cards even when they carry placeholder API keys", async () => {
  const plan = planSwitch(
    provider({ providerType: "github_copilot" }),
    { cognia: true, agents: ["claude-code"] },
    {}
  )
  await expect(applySwitch(plan)).rejects.toThrow(/managed authentication/)
  expect(mSetProviderEnv).not.toHaveBeenCalled()
  expect(mWriteClaude).not.toHaveBeenCalled()
})
