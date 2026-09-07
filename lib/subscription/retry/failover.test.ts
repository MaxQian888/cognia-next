import { createRotationState } from "./account-pool"
import { BREAKER_SCOPES, SubscriptionBreaker, credentialKey } from "./breaker"
import { clearCredentialBlocks, handleSubscriptionFailure } from "./failover"

import type { FailoverDeps } from "./failover"
import type { SubscriptionFailure } from "./failure-class"
import type { AccountSummary, ProviderId } from "@/types/subscription"

const NOW = 1_000_000
const noJitter = () => 0

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

const quota: SubscriptionFailure = {
  reason: "account-quota",
  retryable: true,
  rotatable: true,
  permanent: false,
}
const throttle: SubscriptionFailure = {
  reason: "throttled",
  retryable: true,
  rotatable: false,
  permanent: false,
}
const revoked: SubscriptionFailure = {
  reason: "auth-revoked",
  retryable: false,
  rotatable: true,
  permanent: true,
}

interface Harness {
  deps: FailoverDeps
  breaker: SubscriptionBreaker
  switched: Array<[ProviderId, string]>
  activated: Array<[ProviderId, string]>
}

function harness(accounts: AccountSummary[], activeId: string | null = "a"): Harness {
  const breaker = new SubscriptionBreaker()
  const switched: Array<[ProviderId, string]> = []
  const activated: Array<[ProviderId, string]> = []
  return {
    breaker,
    switched,
    activated,
    deps: {
      listAccounts: async () => accounts,
      getActiveAccountId: async () => activeId,
      setActiveAccount: async (provider, accountId) => {
        activated.push([provider, accountId])
      },
      breaker,
      now: () => NOW,
      random: noJitter,
      onSwitched: (provider, accountId) => {
        switched.push([provider, accountId])
      },
    },
  }
}

describe("handleSubscriptionFailure", () => {
  it("blocks the credential and switches to a sibling on an account quota", async () => {
    const h = harness([account("a"), account("b")])
    const outcome = await handleSubscriptionFailure({
      provider: "anthropic",
      accountId: "a",
      failure: quota,
      failoverEnabled: true,
      deps: h.deps,
    })
    expect(outcome).toMatchObject({ kind: "switched", fromAccountId: "a", toAccountId: "b" })
    expect(h.activated).toEqual([["anthropic", "b"]])
    expect(h.switched).toEqual([["anthropic", "b"]])
    expect(
      h.breaker.shouldAttempt(credentialKey("anthropic", "a", BREAKER_SCOPES.usage), NOW).allowed
    ).toBe(false)
  })

  it("blocks without rotating when the failure is transient", async () => {
    const h = harness([account("a"), account("b")])
    const outcome = await handleSubscriptionFailure({
      provider: "anthropic",
      accountId: "a",
      failure: throttle,
      failoverEnabled: true,
      deps: h.deps,
    })
    expect(outcome.kind).toBe("blocked-only")
    expect(h.activated).toEqual([])
  })

  it("blocks without rotating when the user has not opted in", async () => {
    const h = harness([account("a"), account("b")])
    const outcome = await handleSubscriptionFailure({
      provider: "anthropic",
      accountId: "a",
      failure: quota,
      failoverEnabled: false,
      deps: h.deps,
    })
    expect(outcome.kind).toBe("failover-disabled")
    expect(h.activated).toEqual([])
    // The block is still armed. Opting out of failover is not opting out of
    // backing off.
    expect(
      h.breaker.shouldAttempt(credentialKey("anthropic", "a", BREAKER_SCOPES.usage), NOW).allowed
    ).toBe(false)
  })

  it("does not move the pointer when the failing account is not the active one", async () => {
    const h = harness([account("a"), account("b")], "a")
    const outcome = await handleSubscriptionFailure({
      provider: "anthropic",
      accountId: "b",
      failure: quota,
      failoverEnabled: true,
      deps: h.deps,
    })
    expect(outcome.kind).toBe("not-active")
    expect(h.activated).toEqual([])
  })

  it("reports no-candidate when the provider has a single account", async () => {
    const h = harness([account("a")])
    const outcome = await handleSubscriptionFailure({
      provider: "anthropic",
      accountId: "a",
      failure: quota,
      failoverEnabled: true,
      deps: h.deps,
    })
    expect(outcome).toMatchObject({ kind: "no-candidate", reason: "no-siblings" })
  })

  it("reports no-candidate when every sibling is already blocked", async () => {
    const h = harness([account("a"), account("b")])
    h.breaker.recordFailure(
      credentialKey("anthropic", "b", BREAKER_SCOPES.usage),
      quota,
      NOW,
      noJitter
    )
    const outcome = await handleSubscriptionFailure({
      provider: "anthropic",
      accountId: "a",
      failure: quota,
      failoverEnabled: true,
      deps: h.deps,
    })
    expect(outcome).toMatchObject({ kind: "no-candidate", reason: "all-blocked" })
    expect(h.activated).toEqual([])
  })

  it("latches a revoked credential permanently while still failing over", async () => {
    const h = harness([account("a"), account("b")])
    const outcome = await handleSubscriptionFailure({
      provider: "anthropic",
      accountId: "a",
      failure: revoked,
      failoverEnabled: true,
      deps: h.deps,
    })
    expect(outcome.kind).toBe("switched")
    const decision = h.breaker.shouldAttempt(
      credentialKey("anthropic", "a", BREAKER_SCOPES.usage),
      NOW + 30 * 24 * 60 * 60_000
    )
    expect(decision.permanent).toBe(true)
  })

  it("never selects the account that just failed, even if the caller forgot it", async () => {
    const h = harness([account("a"), account("b")])
    // A rotation state that has not recorded "a" would otherwise be free to
    // hand it straight back, which is an immediate loop.
    const state = createRotationState()
    const outcome = await handleSubscriptionFailure({
      provider: "anthropic",
      accountId: "a",
      failure: quota,
      failoverEnabled: true,
      rotationState: state,
      deps: h.deps,
    })
    expect(outcome).toMatchObject({ toAccountId: "b" })
    expect(state.attempted.has("a")).toBe(true)
  })

  it("walks the pool once across successive failures, then stops", async () => {
    const accounts = [account("a"), account("b"), account("c")]
    const h = harness(accounts, "a")
    const state = createRotationState("a")
    const run = (accountId: string) =>
      handleSubscriptionFailure({
        provider: "anthropic",
        accountId,
        failure: quota,
        failoverEnabled: true,
        rotationState: state,
        deps: {
          ...h.deps,
          getActiveAccountId: async () => accountId,
        },
      })

    expect(await run("a")).toMatchObject({ toAccountId: "b" })
    expect(await run("b")).toMatchObject({ toAccountId: "c" })
    expect((await run("c")).kind).toBe("no-candidate")
  })
})

describe("clearCredentialBlocks", () => {
  it("drops every scope so a re-authenticated account is usable again", () => {
    const breaker = new SubscriptionBreaker()
    for (const scope of Object.values(BREAKER_SCOPES)) {
      breaker.recordFailure(credentialKey("anthropic", "a", scope), revoked, NOW, noJitter)
    }
    clearCredentialBlocks("anthropic", "a", breaker)
    for (const scope of Object.values(BREAKER_SCOPES)) {
      expect(breaker.shouldAttempt(credentialKey("anthropic", "a", scope), NOW).allowed).toBe(true)
    }
  })
})

describe("recordBlock: false", () => {
  it("rotates without counting the failure a second time", async () => {
    const h = harness([account("a"), account("b")])
    const key = credentialKey("anthropic", "a", BREAKER_SCOPES.usage)
    // The caller (the coalescer) already folded this failure into the ledger.
    h.breaker.recordFailure(key, quota, NOW, noJitter)
    const armed = h.breaker.peek(key)

    const outcome = await handleSubscriptionFailure({
      provider: "anthropic",
      accountId: "a",
      failure: quota,
      failoverEnabled: true,
      recordBlock: false,
      deps: h.deps,
    })

    expect(outcome).toMatchObject({ kind: "switched", toAccountId: "b" })
    const after = h.breaker.peek(key)
    expect(after.consecutiveFailures).toBe(armed.consecutiveFailures)
    expect(after.blockedUntil).toBe(armed.blockedUntil)
    expect(outcome.kind === "switched" || outcome.kind === "no-candidate").toBe(true)
  })

  it("still reports the standing block on a non-rotatable failure", async () => {
    const h = harness([account("a"), account("b")])
    const key = credentialKey("anthropic", "a", BREAKER_SCOPES.usage)
    const armed = h.breaker.recordFailure(key, throttle, NOW, noJitter)
    const outcome = await handleSubscriptionFailure({
      provider: "anthropic",
      accountId: "a",
      failure: throttle,
      failoverEnabled: true,
      recordBlock: false,
      deps: h.deps,
    })
    expect(outcome).toEqual({ kind: "blocked-only", blockedUntil: armed })
  })
})
