const settingsState: { settings: Record<string, unknown> | null } = { settings: null }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => settingsState },
}))

const notifyMock = jest.fn()
jest.mock("@/lib/subscription/core/subscription-events", () => ({
  notifySubscriptionChanged: () => notifyMock(),
}))

jest.mock("@/lib/subscription/core/transport", () => ({
  listAccounts: jest.fn(async () => []),
  getActiveAccount: jest.fn(async () => ({ activeAccountId: undefined, env: [] })),
  setActiveAccount: jest.fn(async () => undefined),
}))

import { SubscriptionBreaker, credentialKey } from "@/lib/subscription/retry/breaker"

import { isFailoverEnabled, runQuotaFailover } from "./quota-failover"

import type { FailoverDeps } from "@/lib/subscription/retry/failover"
import type { AccountSummary, ProviderId } from "@/types/subscription"

const NOW = 1_000_000

function account(id: string, over: Partial<AccountSummary> = {}): AccountSummary {
  return {
    id,
    provider: "anthropic",
    variant: "anthropic",
    expiresAtMs: 0,
    createdAtMs: 0,
    lastUsedAtMs: 0,
    authMode: "subscription",
    credentialSource: "oauth",
    health: "ready",
    isExternal: false,
    ...over,
  }
}

function deps(accounts: AccountSummary[], activeId: string | null) {
  const activated: Array<[ProviderId, string]> = []
  const partial: Partial<FailoverDeps> = {
    listAccounts: async () => accounts,
    getActiveAccountId: async () => activeId,
    setActiveAccount: async (provider, accountId) => {
      activated.push([provider, accountId])
    },
    breaker: new SubscriptionBreaker(),
    random: () => 0,
  }
  return { partial, activated }
}

beforeEach(() => {
  settingsState.settings = null
  notifyMock.mockReset()
})

describe("isFailoverEnabled", () => {
  it("is false when nothing is configured", () => {
    expect(isFailoverEnabled("anthropic")).toBe(false)
    expect(isFailoverEnabled("codex")).toBe(false)
  })

  it("reads the Anthropic and Codex toggles from their own settings blocks", () => {
    settingsState.settings = {
      subscriptionSettings: { autoFailoverEnabled: true },
      codexSubscriptionSettings: { autoFailoverEnabled: false },
    }
    expect(isFailoverEnabled("anthropic")).toBe(true)
    expect(isFailoverEnabled("codex")).toBe(false)
  })

  it("is false for a provider whose accounts are not interchangeable", () => {
    settingsState.settings = { subscriptionSettings: { autoFailoverEnabled: true } }
    expect(isFailoverEnabled("opencode")).toBe(false)
  })

  it("treats an older settings row with no field as off", () => {
    settingsState.settings = { subscriptionSettings: { probeEnabled: true } }
    expect(isFailoverEnabled("anthropic")).toBe(false)
  })
})

describe("runQuotaFailover", () => {
  it("switches to a sibling on an account quota when enabled", async () => {
    const d = deps([account("a"), account("b")], "a")
    const outcome = await runQuotaFailover({
      provider: "anthropic",
      accountId: "a",
      error: "429: usage_limit_reached",
      now: NOW,
      isEnabled: () => true,
      deps: d.partial,
    })
    expect(outcome).toMatchObject({ kind: "switched", toAccountId: "b" })
    expect(d.activated).toEqual([["anthropic", "b"]])
  })

  it("notifies the credential bus so the chat header re-reads auth", async () => {
    const d = deps([account("a"), account("b")], "a")
    await runQuotaFailover({
      provider: "anthropic",
      accountId: "a",
      error: "429: usage_limit_reached",
      now: NOW,
      isEnabled: () => true,
      // onSwitched is left at its default so the real notifier runs.
      deps: { ...d.partial, onSwitched: undefined },
    })
    expect(notifyMock).toHaveBeenCalledTimes(1)
  })

  it("does nothing for a transient throttle", async () => {
    const d = deps([account("a"), account("b")], "a")
    const outcome = await runQuotaFailover({
      provider: "anthropic",
      accountId: "a",
      error: "429: 5 requests per minute",
      now: NOW,
      isEnabled: () => true,
      deps: d.partial,
    })
    expect(outcome).toBeNull()
    expect(d.activated).toEqual([])
  })

  it("does nothing when the user has not opted in", async () => {
    const d = deps([account("a"), account("b")], "a")
    const outcome = await runQuotaFailover({
      provider: "anthropic",
      accountId: "a",
      error: "429: usage_limit_reached",
      now: NOW,
      isEnabled: () => false,
      deps: d.partial,
    })
    expect(outcome).toBeNull()
    expect(d.activated).toEqual([])
  })

  it("reads the opt-in from settings when no reader is injected", async () => {
    settingsState.settings = { subscriptionSettings: { autoFailoverEnabled: true } }
    const d = deps([account("a"), account("b")], "a")
    const outcome = await runQuotaFailover({
      provider: "anthropic",
      accountId: "a",
      error: "429: usage_limit_reached",
      now: NOW,
      deps: d.partial,
    })
    expect(outcome).toMatchObject({ kind: "switched" })
  })

  it("swallows a vault write failure rather than rejecting the caller", async () => {
    const d = deps([account("a"), account("b")], "a")
    const outcome = await runQuotaFailover({
      provider: "anthropic",
      accountId: "a",
      error: "429: usage_limit_reached",
      now: NOW,
      isEnabled: () => true,
      deps: {
        ...d.partial,
        setActiveAccount: async () => {
          throw new Error("keyring locked")
        },
      },
    })
    expect(outcome).toBeNull()
  })

  it("does not double-count the block the coalescer already armed", async () => {
    const breaker = new SubscriptionBreaker()
    const key = credentialKey("anthropic", "a", "usage")
    const d = deps([account("a"), account("b")], "a")
    // Stand in for the coalescer's record step.
    const armed = breaker.recordFailure(
      key,
      { reason: "account-quota", retryable: true, rotatable: true, permanent: false },
      NOW,
      () => 0
    )
    await runQuotaFailover({
      provider: "anthropic",
      accountId: "a",
      error: "429: usage_limit_reached",
      now: NOW,
      isEnabled: () => true,
      deps: { ...d.partial, breaker },
    })
    expect(breaker.peek(key).consecutiveFailures).toBe(1)
    expect(breaker.peek(key).blockedUntil).toBe(armed)
  })
})
