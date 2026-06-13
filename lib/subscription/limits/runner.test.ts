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
