import { queryAllConfiguredLimits } from "./aggregate"
import * as transport from "@/lib/subscription/core/transport"

jest.mock("@/lib/subscription/core/transport", () => ({
  ...jest.requireActual("@/lib/subscription/core/transport"),
  listAccounts: jest.fn(async () => []),
  listSubscriptionProviderIds: jest.fn(async () => [
    "anthropic",
    "codex",
    "opencode",
    "commandcode",
  ]),
  getActiveAccount: jest.fn(async () => ({ activeAccountId: undefined, env: [] })),
  getAccount: jest.fn(async () => null),
  authedGet: jest.fn(async () => '{"balance":8}'),
}))

import type {
  AccountSummary,
  ActiveSnapshot,
  ProviderId,
  ProviderLimits,
} from "@/types/subscription"

function summary(id: string, provider: ProviderId): AccountSummary {
  return {
    id,
    provider,
    variant: provider === "anthropic" ? "anthropic" : "codex",
    expiresAtMs: 0,
    createdAtMs: 0,
    lastUsedAtMs: 0,
    authMode: provider === "anthropic" ? "subscription" : "chatgpt",
    credentialSource: "managed",
    health: "ready",
    isExternal: false,
  }
}

function limits(provider: string, accountId: string): ProviderLimits {
  return { provider, accountId, fetchedAt: 0, meters: [] }
}

describe("queryAllConfiguredLimits", () => {
  it("uses the default vault and account runner and continues past missing accounts", async () => {
    jest.mocked(transport.listAccounts).mockResolvedValueOnce([summary("deleted", "anthropic")])
    expect(await queryAllConfiguredLimits()).toEqual([])
    expect(transport.getAccount).toHaveBeenCalledWith("anthropic", "deleted")
  })

  it("queries custom sources with the default transport and clock", async () => {
    const result = await queryAllConfiguredLimits({
      listCustomSources: () => [
        {
          id: "default-transport",
          name: "Custom",
          baseUrl: "https://relay.example.com",
          token: "test",
          enabled: true,
          request: { path: "/balance" },
          extract: { kind: "balance", remainingPath: "balance" },
        },
      ],
    })
    expect(result[0].meters[0].remaining).toBe(8)
    expect(result[0].fetchedAt).toBeGreaterThan(0)
  })

  it("isolates non-Error rejections and timestamps failures with the default clock", async () => {
    const result = await queryAllConfiguredLimits({
      listAccounts: async (provider) =>
        provider === "anthropic" ? Promise.reject("locked") : [summary("broken", provider)],
      getActiveAccount: async () => ({ activeAccountId: undefined, env: [] }),
      runAccount: async () => Promise.reject("failed"),
    })
    expect(result.map((row) => row.error)).toEqual(["failed", "failed", "failed", "locked"])
    expect(result.every((row) => row.fetchedAt > 0)).toBe(true)
  })

  const listAccounts = async (provider: ProviderId): Promise<AccountSummary[]> => {
    if (provider === "anthropic") return [summary("a1", "anthropic"), summary("a2", "anthropic")]
    if (provider === "codex") return [summary("c1", "codex")]
    return []
  }
  const getActiveAccount = async (provider: ProviderId): Promise<ActiveSnapshot> => ({
    activeAccountId: provider === "codex" ? "c1" : "a1",
    env: [],
  })

  it("queries every account and drops the ones with no usable snapshot", async () => {
    const runAccount = async (provider: ProviderId, accountId: string) =>
      accountId === "a2" ? null : limits(provider, accountId)
    const out = await queryAllConfiguredLimits({ listAccounts, getActiveAccount, runAccount })
    expect(out.map((r) => r.accountId)).toEqual(["a1", "c1"])
  })

  it("pins the active provider's active account first", async () => {
    const runAccount = async (provider: ProviderId, accountId: string) =>
      limits(provider, accountId)
    const out = await queryAllConfiguredLimits({
      listAccounts,
      getActiveAccount,
      runAccount,
      activeProvider: "codex",
    })
    // c1 (active codex) pinned first; the rest keep enumeration order.
    expect(out.map((r) => r.accountId)).toEqual(["c1", "a1", "a2"])
  })

  it("keeps enumeration order when no active provider is set", async () => {
    const runAccount = async (provider: ProviderId, accountId: string) =>
      limits(provider, accountId)
    const out = await queryAllConfiguredLimits({ listAccounts, getActiveAccount, runAccount })
    expect(out.map((r) => r.accountId)).toEqual(["a1", "a2", "c1"])
  })

  it("returns [] when there are no accounts", async () => {
    const out = await queryAllConfiguredLimits({
      listAccounts: async () => [],
      getActiveAccount,
      runAccount: async () => limits("x", "y"),
    })
    expect(out).toEqual([])
  })

  it("keeps healthy accounts and exposes one failed account", async () => {
    const out = await queryAllConfiguredLimits({
      listAccounts,
      getActiveAccount,
      now: () => 123,
      runAccount: async (provider, id) => {
        if (id === "a1") throw new Error("vault unavailable")
        return limits(provider, id)
      },
    })
    expect(out.map((r) => r.accountId)).toEqual(["a1", "a2", "c1"])
    expect(out[0]).toMatchObject({
      provider: "anthropic",
      error: "vault unavailable",
      fetchedAt: 123,
    })
  })

  it("keeps enumerated accounts when only the active-account lookup fails", async () => {
    const out = await queryAllConfiguredLimits({
      listAccounts,
      getActiveAccount: async () => {
        throw new Error("active unavailable")
      },
      runAccount: async (provider, id) => limits(provider, id),
    })
    expect(out.filter((r) => r.accountId).map((r) => r.accountId)).toEqual(["a1", "a2", "c1"])
  })

  it("keeps other providers and custom sources when one vault cannot enumerate", async () => {
    const out = await queryAllConfiguredLimits({
      listAccounts: async (provider) => {
        if (provider === "anthropic") throw new Error("vault locked")
        return listAccounts(provider)
      },
      getActiveAccount,
      runAccount: async (provider, id) => limits(provider, id),
      listCustomSources: () => [
        {
          id: "isolated",
          name: "Custom",
          baseUrl: "https://relay.example.com",
          token: "test",
          enabled: true,
          request: { path: "/balance" },
          extract: { kind: "balance", remainingPath: "balance" },
        },
      ],
      authedGet: async () => '{"balance":5}',
      now: () => 123,
    })
    expect(out.map((r) => r.provider)).toEqual(["codex", "anthropic", "custom:isolated"])
    expect(out[1]).toMatchObject({ error: "vault locked", meters: [] })
    expect(out[2].meters[0].remaining).toBe(5)
  })

  it("appends custom-source snapshots after the vault accounts", async () => {
    const runAccount = async (provider: ProviderId, accountId: string) =>
      limits(provider, accountId)
    const out = await queryAllConfiguredLimits({
      listAccounts,
      getActiveAccount,
      runAccount,
      listCustomSources: () => [
        {
          id: "relay1",
          name: "My Relay",
          baseUrl: "https://relay.example.com/v1",
          token: "tok",
          enabled: true,
          request: { path: "/balance" },
          extract: { kind: "balance", remainingPath: "data.balance", unit: "USD" },
        },
      ],
      authedGet: async () => JSON.stringify({ data: { balance: 9 } }),
      now: () => 0,
    })
    expect(out.map((r) => r.provider)).toEqual(["anthropic", "anthropic", "codex", "custom:relay1"])
    expect(out[3].meters[0]).toMatchObject({ remaining: 9 })
  })
})
