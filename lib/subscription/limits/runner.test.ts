import { queryAccountLimits } from "./runner"

import {
  __resetLimitsSourcesForTesting,
  registerLimitsSource,
} from "@/lib/plugin/registries/limits-source-registry"

import type { Account, LimitsSourceContext, ProviderPreset } from "@/types/subscription"
import { authedRequest } from "@/lib/subscription/core/transport"
import {
  AnthropicReauthenticationRequiredError,
  refreshAndPersistAnthropicAccount,
} from "@/lib/subscription/anthropic/refresh"
import {
  CodexReauthenticationRequiredError,
  refreshCodexAccountIfStale,
} from "@/lib/subscription/codex/refresh"

jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: { getState: () => ({ unlockedAccountId: "local-test" }) },
}))

jest.mock("@/lib/subscription/anthropic/refresh", () => ({
  ...jest.requireActual("@/lib/subscription/anthropic/refresh"),
  refreshAndPersistAnthropicAccount: jest.fn(async () => null),
}))
jest.mock("@/lib/subscription/codex/refresh", () => ({
  ...jest.requireActual("@/lib/subscription/codex/refresh"),
  refreshCodexAccountIfStale: jest.fn(async () => null),
}))

jest.mock("@/lib/subscription/core/transport", () => ({
  getAccount: jest.fn(),
  listPresets: jest.fn(),
  getProviderPreset: jest.fn(async () => null),
  authedRequest: jest.fn(),
}))

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
  it.each([false, true])(
    "stops quota requests after a Codex identity failure (reactive: %s)",
    async (reactive) => {
      const authedGet = jest.fn(async () => "{}")
      const lifecycleError = new CodexReauthenticationRequiredError("external_login_unverified")
      const fetch = jest.fn(async (ctx: LimitsSourceContext) => {
        if (reactive) await ctx.refreshToken?.()
        await ctx.authedGet("https://example.invalid/quota")
        return null
      })
      registerLimitsSource(
        "stub:identity",
        {
          id: "stub:identity",
          key: "codex",
          matches: () => true,
          fetch,
        },
        { pluginId: "stub" }
      )

      await expect(
        queryAccountLimits("codex", "acc-3", {
          getAccount: async () => codexChatgptAccount(),
          listPresets: async () => [],
          authedGet,
          isCodexFresh: () => reactive,
          refreshCodexToken: async () => {
            throw lifecycleError
          },
        })
      ).rejects.toBe(lifecycleError)
      expect(authedGet).not.toHaveBeenCalled()
      if (!reactive) expect(fetch).not.toHaveBeenCalled()
    }
  )

  it.each(["get", "post"])(
    "blocks %s even if a quota source catches the identity error",
    async (method) => {
      const lifecycleError = new CodexReauthenticationRequiredError("external_login_changed")
      const authedGet = jest.fn(async () => "{}")
      const request = jest.fn(async () => ({ status: 200, headers: [], body: "{}" }))
      registerLimitsSource(
        "stub:swallow",
        {
          id: "stub:swallow",
          key: "codex",
          matches: () => true,
          fetch: async (ctx) => {
            await ctx.refreshToken?.().catch(() => null)
            if (method === "get") await ctx.authedGet("https://example.invalid/quota")
            else await ctx.authedRequest?.({ url: "https://example.invalid/quota", method: "POST" })
            return null
          },
        },
        { pluginId: "stub" }
      )
      await expect(
        queryAccountLimits("codex", "acc-3", {
          getAccount: async () => codexChatgptAccount(),
          listPresets: async () => [],
          authedGet,
          authedRequest: request,
          isCodexFresh: () => true,
          refreshCodexToken: async () => {
            throw lifecycleError
          },
        })
      ).rejects.toBe(lifecycleError)
      expect(authedGet).not.toHaveBeenCalled()
      expect(request).not.toHaveBeenCalled()
    }
  )

  it("forwards authenticated POST requests when no lifecycle error exists", async () => {
    jest.mocked(authedRequest).mockResolvedValueOnce({ status: 200, headers: [], body: "{}" })
    registerLimitsSource(
      "stub:post",
      {
        id: "stub:post",
        key: "codex",
        matches: () => true,
        fetch: async (ctx) => {
          await ctx.authedRequest?.({ url: "https://example.invalid/quota", method: "POST" })
          return null
        },
      },
      { pluginId: "stub" }
    )
    await queryAccountLimits("codex", "acc-3", {
      getAccount: async () => codexChatgptAccount(),
      listPresets: async () => [],
      isCodexFresh: () => true,
    })
    expect(authedRequest).toHaveBeenCalledWith({
      url: "https://example.invalid/quota",
      method: "POST",
    })
  })

  it("does not query an account already marked as requiring reauthentication", async () => {
    const authedGet = jest.fn()
    await expect(
      queryAccountLimits("codex", "acc-3", {
        getAccount: async () =>
          codexChatgptAccount({
            authMetadata: { reauthRequiredAtMs: 1, reauthReason: "external_login_changed" },
          }),
        listPresets: async () => [],
        authedGet,
        isCodexFresh: () => true,
      })
    ).rejects.toMatchObject({ code: "reauth_required" })
    expect(authedGet).not.toHaveBeenCalled()
  })

  it.each([200, 401])("uses the native status-preserving transport for HTTP %s", async (status) => {
    jest.mocked(authedRequest).mockResolvedValueOnce({
      status,
      headers: [],
      body: JSON.stringify({ code: 0, data: { available_balance: 12 } }),
    })
    const result = await queryAccountLimits("codex", "acc-2", {
      getAccount: async () => codexRelayAccount(),
      listPresets: async () => [moonshotPreset],
    })
    expect(result).toMatchObject({ provider: "codex", sourceId: "moonshot" })
    if (status === 200) expect(result?.meters[0].remaining).toBe(12)
    else expect(result?.error).toContain("401")
  })

  it.each([true, false])(
    "refreshes stale OAuth accounts without activating them (token available: %s)",
    async (available) => {
      jest
        .mocked(refreshAndPersistAnthropicAccount)
        .mockResolvedValueOnce(available ? ({ accessToken: "fresh" } as never) : null)
      jest
        .mocked(refreshCodexAccountIfStale)
        .mockResolvedValueOnce(available ? ({ accessToken: "fresh" } as never) : null)
      registerLimitsSource(
        "stub:oauth",
        {
          id: "stub:oauth",
          key: "oauth",
          matches: () => true,
          fetch: async (ctx) => ({
            provider: ctx.provider,
            fetchedAt: ctx.now,
            meters: [],
            error: ctx.token ?? "empty",
          }),
        },
        { pluginId: "stub" }
      )
      const anthropic = await queryAccountLimits("anthropic", "acc-1", {
        getAccount: async () => anthropicAccount(),
        listPresets: async () => [],
        isCredentialFresh: () => false,
      })
      const codex = await queryAccountLimits("codex", "acc-3", {
        getAccount: async () => codexChatgptAccount(),
        listPresets: async () => [],
        isCodexFresh: () => false,
      })
      expect(anthropic?.error).toBe(available ? "fresh" : "sk-ant")
      expect(codex?.error).toBe(available ? "fresh" : "sk-stale")
      expect(refreshAndPersistAnthropicAccount).toHaveBeenCalledWith("acc-1", { reactivate: false })
      expect(refreshCodexAccountIfStale).toHaveBeenCalledWith("acc-3", { reactivate: false })
    }
  )

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
    expect(snap).toMatchObject({ provider: "codex", sourceId: "moonshot", accountId: "acc-2" })
    expect(snap?.meters[0]).toMatchObject({ id: "credit", remaining: 12.5 })
  })

  it.each([undefined, "missing"])(
    "resolves the real default for unbound relay %s",
    async (presetId) => {
      const authedGet = jest.fn(async () =>
        JSON.stringify({
          usage: { remaining: 75, limit: 100 },
        })
      )
      const preset: ProviderPreset = {
        id: "p-kimi",
        label: "Kimi Coding",
        templateId: "kimi-coding",
        baseUrl: "https://api.kimi.com/coding/",
      }
      const result = await queryAccountLimits("codex", "acc-2", {
        getAccount: async () => ({ ...codexRelayAccount(), presetId }),
        listPresets: async () => [moonshotPreset, preset],
        getProviderPreset: async () => preset,
        authedGet,
      })
      expect(authedGet).toHaveBeenCalledWith(
        "https://api.kimi.com/coding/v1/usages",
        expect.any(Object)
      )
      expect(result).toMatchObject({
        provider: "codex",
        sourceId: "kimi-coding",
        accountId: "acc-2",
        meters: [expect.objectContaining({ usedPct: 25 })],
      })
    }
  )

  it("keeps account identity for source errors and plugin results", async () => {
    registerLimitsSource(
      "stub:relay",
      {
        id: "stub:relay",
        key: "relay",
        matches: () => true,
        fetch: async () => ({
          provider: "relay",
          accountId: "wrong",
          fetchedAt: 1,
          meters: [],
          error: "401",
        }),
      },
      { pluginId: "stub" }
    )
    expect(
      await queryAccountLimits("codex", "acc-2", {
        getAccount: async () => codexRelayAccount(),
        listPresets: async () => [moonshotPreset],
      })
    ).toMatchObject({ provider: "codex", sourceId: "relay", accountId: "acc-2", error: "401" })
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

  it("reuses one refresh result across proactive and reactive retry paths", async () => {
    let reactiveToken: string | null | undefined
    registerLimitsSource(
      "stub:anthropic",
      {
        id: "stub:anthropic",
        key: "anthropic",
        matches: (q) => q.provider === "anthropic",
        fetch: async (ctx) => {
          reactiveToken = await ctx.refreshToken?.()
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
      isCredentialFresh: () => false,
    })

    expect(reactiveToken).toBe("fresh-token")
    expect(refreshAnthropicToken).toHaveBeenCalledTimes(1)
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

it("stops a limits query if the local account switches during preset resolution", async () => {
  let scope = "local-a"
  const authedGet = jest.fn()
  await expect(
    queryAccountLimits("anthropic", "acc-1", {
      getLocalAccountId: () => scope,
      getAccount: async () => anthropicAccount(),
      isCredentialFresh: () => true,
      listPresets: async () => {
        scope = "local-b"
        return []
      },
      authedGet,
    })
  ).rejects.toThrow("local account changed")
  expect(authedGet).not.toHaveBeenCalled()
})

it("blocks cached requests when the local account changes inside a source", async () => {
  let scope = "local-a"
  const authedGet = jest.fn()
  registerLimitsSource(
    "stub:scope-change",
    {
      id: "stub:scope-change",
      key: "anthropic",
      matches: (q) => q.provider === "anthropic",
      fetch: async (ctx) => {
        scope = "local-b"
        await expect(
          Promise.resolve().then(() => ctx.authedGet("https://example.invalid"))
        ).rejects.toThrow("local account changed")
        return null
      },
    },
    { pluginId: "stub" }
  )
  await expect(
    queryAccountLimits("anthropic", "acc-1", {
      getLocalAccountId: () => scope,
      getAccount: async () => anthropicAccount(),
      isCredentialFresh: () => true,
      listPresets: async () => [],
      authedGet,
    })
  ).rejects.toThrow("local account changed")
  expect(authedGet).not.toHaveBeenCalled()
})

it("rejects a changed linked Claude login before using a still-fresh cached bearer", async () => {
  const account = anthropicAccount()
  if (account.credential.provider !== "anthropic") throw new Error("fixture")
  account.credential.originalSource = "keyring"
  const authedGet = jest.fn()
  await expect(
    queryAccountLimits("anthropic", account.id, {
      getAccount: async () => account,
      isCredentialFresh: () => true,
      refreshAnthropicToken: async () => {
        throw new AnthropicReauthenticationRequiredError("external_login_changed")
      },
      authedGet,
    })
  ).rejects.toThrow("external_login_changed")
  expect(authedGet).not.toHaveBeenCalled()
})

it("blocks cached Claude requests even when a source catches its refresh failure", async () => {
  const authedGet = jest.fn()
  const authedRequest = jest.fn()
  registerLimitsSource(
    "stub:claude-lifecycle",
    {
      id: "stub:claude-lifecycle",
      key: "anthropic",
      matches: (q) => q.provider === "anthropic",
      fetch: async (ctx) => {
        await ctx.refreshToken?.().catch(() => null)
        expect(() =>
          ctx.authedGet("https://example.invalid", { Authorization: "Bearer cached" })
        ).toThrow("external_login_unavailable")
        expect(() => ctx.authedRequest({} as never)).toThrow("external_login_unavailable")
        return null
      },
    },
    { pluginId: "stub" }
  )
  await expect(
    queryAccountLimits("anthropic", "acc-1", {
      getAccount: async () => anthropicAccount(),
      isCredentialFresh: () => true,
      listPresets: async () => [],
      refreshAnthropicToken: async () => {
        throw new AnthropicReauthenticationRequiredError("external_login_unavailable")
      },
      authedGet,
      authedRequest,
    })
  ).rejects.toThrow("external_login_unavailable")
  expect(authedGet).not.toHaveBeenCalled()
  expect(authedRequest).not.toHaveBeenCalled()
})
