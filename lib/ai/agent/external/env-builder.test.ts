jest.mock("@/lib/subscription/core/transport", () => ({
  getActiveAccount: jest.fn(),
  getAccount: jest.fn(),
  setActiveAccount: jest.fn(),
  codexOauthDiscover: jest.fn(),
  refreshManagedCodexAccount: jest.fn(),
}))

jest.mock("@/lib/db/settings", () => ({
  getSettings: jest.fn(),
}))

import { getSettings } from "@/lib/db/settings"
import * as transportMod from "@/lib/subscription/core/transport"
import type { Account, ActiveSnapshot } from "@/types/subscription"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"

import { buildAgentEnv } from "./env-builder"

const mGetActive = transportMod.getActiveAccount as jest.Mock
const mGetAccount = transportMod.getAccount as jest.Mock
const mSetActive = transportMod.setActiveAccount as jest.Mock
const mDiscover = transportMod.codexOauthDiscover as jest.Mock
const mRefresh = transportMod.refreshManagedCodexAccount as jest.Mock
const mGetSettings = getSettings as jest.Mock

// Default: no codex settings persisted → env-builder uses the type defaults
// (autoRefreshNearExpiry true).
beforeEach(() => {
  mGetSettings.mockResolvedValue({})
  mGetAccount.mockReset()
  mGetAccount.mockResolvedValue(undefined)
  mDiscover.mockResolvedValue(null)
})

function codexConfig(overrides: Partial<ExternalAgentConfig> = {}): ExternalAgentConfig {
  return {
    id: "agent-codex",
    name: "Codex CLI",
    protocol: "acp",
    transport: "stdio",
    enabled: true,
    metadata: { preset: "codex" },
    ...overrides,
  } as ExternalAgentConfig
}

function claudeConfig(): ExternalAgentConfig {
  return {
    id: "agent-claude",
    name: "Claude Code",
    protocol: "acp",
    transport: "stdio",
    enabled: true,
    metadata: { preset: "claude-code" },
  } as ExternalAgentConfig
}

function snapshot(
  env: Array<[string, string]>,
  activeAccountId: string | undefined = "a1"
): ActiveSnapshot {
  return { activeAccountId, env }
}

beforeEach(() => {
  mGetActive.mockReset()
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe("buildAgentEnv — codex preset", () => {
  it("uses the active codex account's env when one is registered", async () => {
    mGetActive.mockResolvedValueOnce(snapshot([["CODEX_ACCESS_TOKEN", "oat-fresh"]]))
    const env = await buildAgentEnv(codexConfig())
    expect(env).toEqual({ CODEX_ACCESS_TOKEN: "oat-fresh" })
    expect(mGetActive).toHaveBeenCalledWith("codex")
  })

  it("supports api_key mode (multiple env pairs)", async () => {
    mGetActive.mockResolvedValueOnce(
      snapshot([
        ["OPENAI_API_KEY", "sk-fresh-1234"],
        ["CODEX_API_KEY", "sk-fresh-1234"],
      ])
    )
    const env = await buildAgentEnv(codexConfig())
    expect(env).toEqual({
      OPENAI_API_KEY: "sk-fresh-1234",
      CODEX_API_KEY: "sk-fresh-1234",
    })
  })

  it("returns base env unchanged when no active codex account is registered", async () => {
    mGetActive.mockResolvedValueOnce({ activeAccountId: undefined, env: [] })
    const env = await buildAgentEnv(codexConfig(), { CUSTOM_VAR: "x" })
    expect(env).toEqual({ CUSTOM_VAR: "x" })
  })

  it("returns base env unchanged when the active snapshot has no env pairs", async () => {
    mGetActive.mockResolvedValueOnce(snapshot([]))
    const env = await buildAgentEnv(codexConfig(), { K: "v" })
    expect(env).toEqual({ K: "v" })
  })

  it("base env wins on conflicting keys (user-provided override)", async () => {
    mGetActive.mockResolvedValueOnce(snapshot([["CODEX_ACCESS_TOKEN", "vault-token"]]))
    const env = await buildAgentEnv(codexConfig(), {
      CODEX_ACCESS_TOKEN: "user-override",
      OTHER: "kept",
    })
    expect(env.CODEX_ACCESS_TOKEN).toBe("user-override")
    expect(env.OTHER).toBe("kept")
  })

  it("swallows subscription_get_active failures and returns base env", async () => {
    mGetActive.mockRejectedValueOnce(new Error("transport offline"))
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    const env = await buildAgentEnv(codexConfig(), { K: "v" })
    expect(env).toEqual({ K: "v" })
    warn.mockRestore()
  })

  it("blocks spawn when the active account requires reauthentication", async () => {
    mGetActive.mockResolvedValueOnce(snapshot([["CODEX_ACCESS_TOKEN", "stale"]]))
    mGetAccount.mockResolvedValueOnce({
      id: "a1",
      credential: {
        provider: "codex",
        accessToken: "stale",
        refreshToken: "revoked",
        idTokenRaw: "",
        expiresAtMs: 1,
        authMode: "chatgpt",
        storedAtMs: 0,
      },
      createdAtMs: 1,
      lastUsedAtMs: 1,
      authMetadata: {
        reauthRequiredAtMs: 2,
        reauthReason: "refresh_token_revoked",
      },
    })

    await expect(buildAgentEnv(codexConfig())).rejects.toThrow(
      "requires reauthentication (refresh_token_revoked)"
    )
  })

  it("preserves insertion order from the Rust-side env pairs", async () => {
    mGetActive.mockResolvedValueOnce(
      snapshot([
        ["OPENAI_API_KEY", "k1"],
        ["CODEX_API_KEY", "k1"],
        ["OPENAI_BASE_URL", "https://example.com"],
      ])
    )
    const env = await buildAgentEnv(codexConfig())
    expect(Object.keys(env)).toEqual(["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"])
  })
})

describe("buildAgentEnv — codex credentials require explicit adoption", () => {
  // ADR-0025's stated contract (and this module's own header) is that discovery
  // is NOT a runtime fallback: a discovered credential is adopted explicitly via
  // the UI's "Reuse" flow. The code contradicted that — with no active account
  // it read the live `~/.codex/auth.json` and injected it, unasked, because
  // `preferDiscovered` defaulted true.
  //
  // That is not merely untidy. A codex-cli configured against a third-party
  // relay (`model_provider = "custom"` + a bare OPENAI_API_KEY in auth.json)
  // gets an env overlay it never asked for; injecting a *different* key from our
  // vault's discovery would silently break a working login, and the spawn never
  // clears env so the overlay reaches the child.
  it("never probes discovery when there is no active account", async () => {
    mGetActive.mockResolvedValueOnce({ activeAccountId: undefined, env: [] })

    const env = await buildAgentEnv(codexConfig(), { K: "v" })

    expect(env).toEqual({ K: "v" })
    expect(mDiscover).not.toHaveBeenCalled()
  })

  it("never probes discovery even with a legacy preferDiscovered:true persisted", async () => {
    // Old settings rows still carry the flag. It must be inert, not honoured.
    mGetSettings.mockResolvedValue({
      codexSubscriptionSettings: { preferDiscovered: true, autoRefreshNearExpiry: false },
    })
    mGetActive.mockResolvedValueOnce({ activeAccountId: undefined, env: [] })

    const env = await buildAgentEnv(codexConfig(), { K: "v" })

    expect(env).toEqual({ K: "v" })
    expect(mDiscover).not.toHaveBeenCalled()
  })

  it("still injects env from an actively adopted account", async () => {
    mGetActive.mockResolvedValueOnce(snapshot([["OPENAI_API_KEY", "sk-adopted"]]))

    const env = await buildAgentEnv(codexConfig())

    expect(env).toEqual({ OPENAI_API_KEY: "sk-adopted" })
    expect(mDiscover).not.toHaveBeenCalled()
  })

  it("leaves a third-party codex login untouched when nothing was adopted", async () => {
    // The child then inherits its own ~/.codex/auth.json + config.toml natively,
    // which is the whole point: no overlay, nothing to clobber.
    mGetActive.mockResolvedValueOnce({ activeAccountId: undefined, env: [] })

    const env = await buildAgentEnv(codexConfig())

    expect(env).toEqual({})
  })
})

describe("buildAgentEnv — codex autoRefreshNearExpiry", () => {
  function codexAccount(expiresAtMs: number, refreshToken = "r1"): Account {
    return {
      id: "a1",
      credential: {
        provider: "codex",
        accessToken: "stale",
        refreshToken,
        idTokenRaw: "",
        expiresAtMs,
        authMode: "chatgpt",
        storedAtMs: 0,
      },
      createdAtMs: 0,
      lastUsedAtMs: 0,
    }
  }

  it("refreshes a near-expiry chatgpt credential before spawn", async () => {
    mGetSettings.mockResolvedValue({
      codexSubscriptionSettings: { preferDiscovered: false, autoRefreshNearExpiry: true },
    })
    mGetActive
      .mockResolvedValueOnce(snapshot([["CODEX_ACCESS_TOKEN", "stale"]], "a1"))
      .mockResolvedValueOnce(snapshot([["CODEX_ACCESS_TOKEN", "new"]], "a1"))
    mGetAccount.mockResolvedValue(codexAccount(Date.now() - 1000, "r1"))
    mRefresh.mockResolvedValueOnce({
      accessToken: "new",
      refreshToken: "r2",
      idTokenRaw: "",
      expiresAtMs: Date.now() + 3_600_000,
      authMode: "chatgpt",
      storedAtMs: Date.now(),
    })

    const env = await buildAgentEnv(codexConfig())

    expect(mRefresh).toHaveBeenCalledWith("a1")
    expect(mSetActive).toHaveBeenCalledWith("codex", "a1")
    expect(env).toEqual({ CODEX_ACCESS_TOKEN: "new" })
  })

  it("does not refresh a still-fresh credential", async () => {
    mGetSettings.mockResolvedValue({
      codexSubscriptionSettings: { preferDiscovered: false, autoRefreshNearExpiry: true },
    })
    mGetActive.mockResolvedValueOnce(snapshot([["CODEX_ACCESS_TOKEN", "fresh"]], "a1"))
    mGetAccount.mockResolvedValue(codexAccount(Date.now() + 3_600_000, "r1"))

    const env = await buildAgentEnv(codexConfig())

    expect(mRefresh).not.toHaveBeenCalled()
    expect(env).toEqual({ CODEX_ACCESS_TOKEN: "fresh" })
  })

  it("skips refresh entirely when autoRefreshNearExpiry is off", async () => {
    mGetSettings.mockResolvedValue({
      codexSubscriptionSettings: { preferDiscovered: false, autoRefreshNearExpiry: false },
    })
    mGetActive.mockResolvedValueOnce(snapshot([["CODEX_ACCESS_TOKEN", "stale"]], "a1"))

    const env = await buildAgentEnv(codexConfig())

    expect(mGetAccount).toHaveBeenCalledWith("codex", "a1")
    expect(mRefresh).not.toHaveBeenCalled()
    expect(env).toEqual({ CODEX_ACCESS_TOKEN: "stale" })
  })

  it("keeps the stale env when the refresh call fails", async () => {
    mGetSettings.mockResolvedValue({
      codexSubscriptionSettings: { preferDiscovered: false, autoRefreshNearExpiry: true },
    })
    mGetActive.mockResolvedValueOnce(snapshot([["CODEX_ACCESS_TOKEN", "stale"]], "a1"))
    mGetAccount.mockResolvedValue(codexAccount(Date.now() - 1000, "r1"))
    mRefresh.mockRejectedValueOnce(new Error("refresh 401"))
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)

    const env = await buildAgentEnv(codexConfig())

    expect(env).toEqual({ CODEX_ACCESS_TOKEN: "stale" })
    warn.mockRestore()
  })
})

describe("buildAgentEnv — non-codex presets", () => {
  it("is a no-op for the claude-code preset", async () => {
    const env = await buildAgentEnv(claudeConfig(), { A: "1" })
    expect(env).toEqual({ A: "1" })
    expect(mGetActive).not.toHaveBeenCalled()
  })

  it("is a no-op when metadata.preset is missing", async () => {
    const cfg: ExternalAgentConfig = {
      id: "x",
      name: "Custom",
      protocol: "acp",
      transport: "stdio",
      enabled: true,
    } as ExternalAgentConfig
    const env = await buildAgentEnv(cfg, { K: "v" })
    expect(env).toEqual({ K: "v" })
    expect(mGetActive).not.toHaveBeenCalled()
  })
})
