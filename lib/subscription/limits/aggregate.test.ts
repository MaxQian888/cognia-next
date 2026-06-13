import { queryAllConfiguredLimits } from "./aggregate"

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
  }
}

function limits(provider: string, accountId: string): ProviderLimits {
  return { provider, accountId, fetchedAt: 0, meters: [] }
}

describe("queryAllConfiguredLimits", () => {
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
})
