import { queryAccountLimits } from "./runner"

import {
  __resetLimitsSourcesForTesting,
  registerLimitsSource,
} from "@/lib/plugin/registries/limits-source-registry"

import type { Account, ProviderPreset } from "@/types/subscription"

afterEach(() => __resetLimitsSourcesForTesting())

function anthropicAccount(over: Partial<Account> = {}): Account {
  return {
    id: "acc-1",
    label: "Max",
    credential: {
      provider: "anthropic",
      accessToken: "sk-ant",
      refreshToken: "",
      expiresAtMs: 0,
      mode: "subscription",
      storedAtMs: 0,
    },
    createdAtMs: 0,
    lastUsedAtMs: 0,
    ...over,
  }
}

/** A real ChatGPT-login codex account (refreshable, unlike the api_key relay). */
function codexChatgptAccount(over: Partial<Account> = {}): Account {
  return {
    id: "acc-3",
    label: "ChatGPT Plus",
    credential: {
      provider: "codex",
      accessToken: "sk-stale",
      refreshToken: "rt-1",
      idTokenRaw: "",
      expiresAtMs: 1_000,
      authMode: "chatgpt",
      storedAtMs: 0,
    },
    createdAtMs: 0,
    lastUsedAtMs: 0,
    ...over,
  }
}

function codexRelayAccount(): Account {
  return {
    id: "acc-2",
    label: "Kimi relay",
    credential: {
      provider: "codex",
      accessToken: "sk-kimi",
      refreshToken: "",
      idTokenRaw: "",
      expiresAtMs: 0,
      authMode: "api_key",
      storedAtMs: 0,
    },
    createdAtMs: 0,
    lastUsedAtMs: 0,
    presetId: "p-moonshot",
  }
}

const moonshotPreset: ProviderPreset = {
  id: "p-moonshot",
  label: "Kimi",
  baseUrl: "https://api.moonshot.cn/v1",
  templateId: "moonshot",
}

describe("queryAccountLimits", () => {
  it("returns null when the account is missing", async () => {
    const snap = await queryAccountLimits("anthropic", "x", {
      getAccount: async () => null,
      listPresets: async () => [],
      authedGet: async () => "",
    })
    expect(snap).toBeNull()
  })

  it("resolves an anthropic account through a plugin-overridable source", async () => {
    // Register a stub anthropic source so the runner never hits the network.
    registerLimitsSource(
      "stub:anthropic",
      {
        id: "stub:anthropic",
        key: "anthropic",
        matches: (q) => q.provider === "anthropic",
        fetch: async (ctx) => ({
          provider: "anthropic",
          accountId: ctx.accountId,
          fetchedAt: ctx.now,
          meters: [{ id: "session", kind: "window", usedPct: 21, status: "ok" }],
        }),
      },
      { pluginId: "stub" }
    )
    const snap = await queryAccountLimits("anthropic", "acc-1", {
      getAccount: async () => anthropicAccount(),
      listPresets: async () => [],
      authedGet: async () => "",
      now: () => 5,
    })
    expect(snap?.provider).toBe("anthropic")
    expect(snap?.meters[0].usedPct).toBe(21)
  })

  it("falls through a non-applicable window source to the balance credit meter", async () => {
    const authedGet = jest.fn(async () =>
      JSON.stringify({ code: 0, data: { available_balance: 12.5 } })
    )
    const snap = await queryAccountLimits("codex", "acc-2", {
      getAccount: async () => codexRelayAccount(),
      listPresets: async () => [moonshotPreset],
      authedGet,
      now: () => 7,
    })
    // codex window source doesn't match a moonshot relay → balance meter.
    expect(snap?.provider).toBe("moonshot")
    expect(snap?.meters[0]).toMatchObject({ id: "credit", remaining: 12.5 })
  })

  it("returns null when no source matches", async () => {
    const snap = await queryAccountLimits("opencode", "acc-3", {
      getAccount: async () =>
        anthropicAccount({
          id: "acc-3",
          credential: {
            provider: "opencode-zen",
            accessToken: "z",
            storedAtMs: 0,
          },
          presetId: "p-groq",
        }),
      listPresets: async () => [
        {
          id: "p-groq",
          label: "Groq",
          baseUrl: "https://api.groq.com/openai/v1",
          templateId: "groq",
        },
      ],
      authedGet: async () => "",
    })
    expect(snap).toBeNull()
  })

  it("refreshes a stale anthropic token before fetching and injects a retry callback", async () => {
    let seenToken: string | null = null
    let sawRefreshCb = false
    registerLimitsSource(
      "stub:anthropic",
      {
        id: "stub:anthropic",
        key: "anthropic",
        matches: (q) => q.provider === "anthropic",
        fetch: async (ctx) => {
          seenToken = ctx.token
          sawRefreshCb = typeof ctx.refreshToken === "function"
          return {
            provider: "anthropic",
            accountId: ctx.accountId,
            fetchedAt: ctx.now,
            meters: [{ id: "session", kind: "window", usedPct: 1, status: "ok" }],
          }
        },
      },
      { pluginId: "stub" }
    )
    const refreshAnthropicToken = jest.fn(async () => "fresh-token")
    const snap = await queryAccountLimits("anthropic", "acc-1", {
      getAccount: async () => anthropicAccount(),
      listPresets: async () => [],
      authedGet: async () => "",
      refreshAnthropicToken,
      isCredentialFresh: () => false,
      now: () => 5,
    })
    expect(refreshAnthropicToken).toHaveBeenCalledWith("acc-1")
    expect(seenToken).toBe("fresh-token")
    expect(sawRefreshCb).toBe(true)
    expect(snap?.meters[0].usedPct).toBe(1)
  })

  it("does not refresh a fresh anthropic token", async () => {
    let seenToken: string | null = null
    registerLimitsSource(
      "stub:anthropic",
      {
        id: "stub:anthropic",
        key: "anthropic",
        matches: (q) => q.provider === "anthropic",
        fetch: async (ctx) => {
          seenToken = ctx.token
          return {
            provider: "anthropic",
            accountId: ctx.accountId,
            fetchedAt: ctx.now,
            meters: [{ id: "session", kind: "window", usedPct: 1, status: "ok" }],
          }
        },
      },
      { pluginId: "stub" }
    )
    const refreshAnthropicToken = jest.fn(async () => "fresh-token")
    await queryAccountLimits("anthropic", "acc-1", {
      getAccount: async () => anthropicAccount(),
      listPresets: async () => [],
      authedGet: async () => "",
      refreshAnthropicToken,
      isCredentialFresh: () => true,
    })
    expect(refreshAnthropicToken).not.toHaveBeenCalled()
    expect(seenToken).toBe("sk-ant")
  })

  it("falls through with the stale token when the refresh throws", async () => {
    let seenToken: string | null = null
    registerLimitsSource(
      "stub:anthropic",
      {
        id: "stub:anthropic",
        key: "anthropic",
        matches: (q) => q.provider === "anthropic",
        fetch: async (ctx) => {
          seenToken = ctx.token
          return {
            provider: "anthropic",
            accountId: ctx.accountId,
            fetchedAt: ctx.now,
            meters: [{ id: "session", kind: "window", usedPct: 2, status: "ok" }],
          }
        },
      },
      { pluginId: "stub" }
    )
    const snap = await queryAccountLimits("anthropic", "acc-1", {
      getAccount: async () => anthropicAccount(),
      listPresets: async () => [],
      authedGet: async () => "",
      refreshAnthropicToken: async () => {
        throw new Error("net")
      },
      isCredentialFresh: () => false,
    })
    expect(seenToken).toBe("sk-ant")
    expect(snap?.meters[0].usedPct).toBe(2)
  })

  it("exposes a working ctx.refreshToken callback that returns the refreshed token", async () => {
    let seen: string | null | undefined
    registerLimitsSource(
      "stub:anthropic",
      {
        id: "stub:anthropic",
        key: "anthropic",
        matches: (q) => q.provider === "anthropic",
        fetch: async (ctx) => {
          seen = await ctx.refreshToken?.()
          return {
            provider: "anthropic",
            accountId: ctx.accountId,
            fetchedAt: ctx.now,
            meters: [{ id: "session", kind: "window", usedPct: 1, status: "ok" }],
          }
        },
      },
      { pluginId: "stub" }
    )
    await queryAccountLimits("anthropic", "acc-1", {
      getAccount: async () => anthropicAccount(),
      listPresets: async () => [],
      authedGet: async () => "",
      // Fresh so the proactive path is skipped; the callback drives the refresh.
      isCredentialFresh: () => true,
      refreshAnthropicToken: async () => "cb-token",
    })
    expect(seen).toBe("cb-token")
  })

  it("ctx.refreshToken returns null when the refresh throws", async () => {
    let seen: string | null | undefined = "unset"
    registerLimitsSource(
      "stub:anthropic",
      {
        id: "stub:anthropic",
        key: "anthropic",
        matches: (q) => q.provider === "anthropic",
        fetch: async (ctx) => {
          seen = await ctx.refreshToken?.()
          return {
            provider: "anthropic",
            accountId: ctx.accountId,
            fetchedAt: ctx.now,
            meters: [{ id: "session", kind: "window", usedPct: 1, status: "ok" }],
          }
        },
      },
      { pluginId: "stub" }
    )
    await queryAccountLimits("anthropic", "acc-1", {
      getAccount: async () => anthropicAccount(),
      listPresets: async () => [],
      authedGet: async () => "",
      isCredentialFresh: () => true,
      refreshAnthropicToken: async () => {
        throw new Error("boom")
      },
    })
    expect(seen).toBeNull()
  })

  it("passes the preset's extraHeaders through to the source context", async () => {
    let seenHeaders: Record<string, string> | undefined
    registerLimitsSource(
      "stub:codex",
      {
        id: "stub:codex",
        key: "codex",
        matches: (q) => q.provider === "codex",
        fetch: async (ctx) => {
          seenHeaders = ctx.presetHeaders
          return {
            provider: "codex",
            accountId: ctx.accountId,
            fetchedAt: ctx.now,
            meters: [{ id: "session", kind: "window", usedPct: 1, status: "ok" }],
          }
        },
      },
      { pluginId: "stub" }
    )
    await queryAccountLimits("codex", "acc-2", {
      getAccount: async () => codexRelayAccount(),
      listPresets: async () => [
        { ...moonshotPreset, extraHeaders: { "x-cognia-volc-ak": "AKID" } },
      ],
      authedGet: async () => "",
    })
    expect(seenHeaders).toEqual({ "x-cognia-volc-ak": "AKID" })
  })

  it("provides no refresh callback for an api_key codex relay", async () => {
    let sawRefreshCb = true
    registerLimitsSource(
      "stub:codex",
      {
        id: "stub:codex",
        key: "codex",
        matches: (q) => q.provider === "codex",
        fetch: async (ctx) => {
          sawRefreshCb = typeof ctx.refreshToken === "function"
          return {
            provider: "codex",
            accountId: ctx.accountId,
            fetchedAt: ctx.now,
            meters: [{ id: "session", kind: "window", usedPct: 3, status: "ok" }],
          }
        },
      },
      { pluginId: "stub" }
    )
    const refreshAnthropicToken = jest.fn(async () => "fresh-token")
    await queryAccountLimits("codex", "acc-2", {
      getAccount: async () => codexRelayAccount(),
      listPresets: async () => [moonshotPreset],
      authedGet: async () => "",
      refreshAnthropicToken,
    })
    expect(sawRefreshCb).toBe(false)
    expect(refreshAnthropicToken).not.toHaveBeenCalled()
  })

  // The Anthropic path has refreshed proactively for ages; Codex never did, so
  // an aged-out ChatGPT bearer 401'd and the panel silently froze.
  it("proactively refreshes a stale chatgpt codex bearer before fetching", async () => {
    let sawToken: string | null = null
    registerLimitsSource(
      "stub:codex-token",
      {
        id: "stub:codex-token",
        key: "codex",
        matches: (q) => q.provider === "codex",
        fetch: async (ctx) => {
          sawToken = ctx.token
          return {
            provider: "codex",
            accountId: ctx.accountId,
            fetchedAt: ctx.now,
            meters: [{ id: "session", kind: "window", usedPct: 3, status: "ok" }],
          }
        },
      },
      { pluginId: "stub" }
    )
    const refreshCodexToken = jest.fn(async () => "sk-fresh")
    await queryAccountLimits("codex", "acc-3", {
      getAccount: async () => codexChatgptAccount(),
      listPresets: async () => [],
      authedGet: async () => "",
      refreshCodexToken,
      isCodexFresh: () => false,
    })
    expect(refreshCodexToken).toHaveBeenCalledWith("acc-3")
    expect(sawToken).toBe("sk-fresh")
  })

  it("does not refresh a fresh chatgpt codex bearer", async () => {
    registerLimitsSource(
      "stub:codex-fresh",
      {
        id: "stub:codex-fresh",
        key: "codex",
        matches: (q) => q.provider === "codex",
        fetch: async (ctx) => ({
          provider: "codex",
          accountId: ctx.accountId,
          fetchedAt: ctx.now,
          meters: [{ id: "session", kind: "window", usedPct: 3, status: "ok" }],
        }),
      },
      { pluginId: "stub" }
    )
    const refreshCodexToken = jest.fn(async () => "sk-fresh")
    await queryAccountLimits("codex", "acc-3", {
      getAccount: async () => codexChatgptAccount(),
      listPresets: async () => [],
      authedGet: async () => "",
      refreshCodexToken,
      isCodexFresh: () => true,
    })
    expect(refreshCodexToken).not.toHaveBeenCalled()
  })

  // Sources need `authMode`/`accountId` that a bare bearer can't carry.
  it("passes the account credential to the source", async () => {
    let seen: unknown
    registerLimitsSource(
      "stub:codex-cred",
      {
        id: "stub:codex-cred",
        key: "codex",
        matches: (q) => q.provider === "codex",
        fetch: async (ctx) => {
          seen = ctx.credential
          return null
        },
      },
      { pluginId: "stub" }
    )
    await queryAccountLimits("codex", "acc-3", {
      getAccount: async () => codexChatgptAccount(),
      listPresets: async () => [],
      authedGet: async () => "",
      isCodexFresh: () => true,
    })
    expect(seen).toMatchObject({ provider: "codex", authMode: "chatgpt" })
  })

  it("swallows a throwing source and falls through", async () => {
    registerLimitsSource(
      "stub:boom",
      {
        id: "stub:boom",
        key: "anthropic",
        matches: (q) => q.provider === "anthropic",
        fetch: async () => {
          throw new Error("kaboom")
        },
      },
      { pluginId: "stub" }
    )
    // Only the throwing source matches anthropic (real one would too, but no
    // token path is exercised); with no other match it yields null.
    const snap = await queryAccountLimits("anthropic", "acc-1", {
      getAccount: async () =>
        anthropicAccount({
          credential: {
            provider: "anthropic",
            accessToken: "",
            refreshToken: "",
            expiresAtMs: 0,
            mode: "subscription",
            storedAtMs: 0,
          },
        }),
      listPresets: async () => [],
      authedGet: async () => "",
    })
    expect(snap).toBeNull()
  })
})
