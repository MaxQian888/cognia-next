import { createRotationState, orderCandidates, selectNextAccount } from "./account-pool"
import {
  BREAKER_SCOPES,
  MAX_ATTEMPTS_PER_OPERATION,
  SubscriptionBreaker,
  credentialKey,
} from "./breaker"

import type { SubscriptionFailure } from "./failure-class"
import type { AccountSummary } from "@/types/subscription"

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

const quotaFailure: SubscriptionFailure = {
  reason: "account-quota",
  retryable: true,
  rotatable: true,
  permanent: false,
}

describe("orderCandidates", () => {
  it("puts the least recently used account first", () => {
    const ordered = orderCandidates([
      account("recent", { lastUsedAtMs: 900 }),
      account("stale", { lastUsedAtMs: 100 }),
      account("middle", { lastUsedAtMs: 500 }),
    ])
    expect(ordered.map((a) => a.id)).toEqual(["stale", "middle", "recent"])
  })

  it("breaks ties on id so the order is deterministic", () => {
    const ordered = orderCandidates([account("b"), account("a"), account("c")])
    expect(ordered.map((a) => a.id)).toEqual(["a", "b", "c"])
  })

  it("does not mutate the input", () => {
    const input = [account("b"), account("a")]
    orderCandidates(input)
    expect(input.map((a) => a.id)).toEqual(["b", "a"])
  })
})

describe("selectNextAccount", () => {
  let breaker: SubscriptionBreaker

  beforeEach(() => {
    breaker = new SubscriptionBreaker()
  })

  const select = (candidates: AccountSummary[], state = createRotationState("a")) =>
    selectNextAccount({
      provider: "anthropic",
      candidates,
      state,
      breaker,
      now: NOW,
      scope: BREAKER_SCOPES.usage,
    })

  it("picks the least recently used healthy sibling", () => {
    const result = select([
      account("a"),
      account("b", { lastUsedAtMs: 500 }),
      account("c", { lastUsedAtMs: 100 }),
    ])
    expect(result.ok && result.selection.account.id).toBe("c")
  })

  it("reports how many siblings remain", () => {
    const result = select([account("a"), account("b"), account("c")])
    expect(result.ok && result.selection.remaining).toBe(1)
  })

  it("never revisits an account already tried in this operation", () => {
    const state = createRotationState("a")
    const candidates = [account("a"), account("b"), account("c")]
    const first = select(candidates, state)
    const second = select(candidates, state)
    const third = select(candidates, state)
    expect(first.ok && first.selection.account.id).toBe("b")
    expect(second.ok && second.selection.account.id).toBe("c")
    // Every candidate is spent. Without the attempted set this would cycle
    // forever, turning one exhausted account into unbounded request volume.
    expect(third.ok).toBe(false)
    expect(!third.ok && third.reason).toBe("all-blocked")
  })

  it("skips a sibling the breaker is holding", () => {
    breaker.recordFailure(
      credentialKey("anthropic", "b", BREAKER_SCOPES.usage),
      quotaFailure,
      NOW,
      () => 0
    )
    const result = select([account("a"), account("b"), account("c")])
    expect(result.ok && result.selection.account.id).toBe("c")
  })

  it("skips a sibling that needs re-authentication", () => {
    const result = select([
      account("a"),
      account("b", { health: "reauth_required" }),
      account("c", { health: "source_unavailable" }),
      account("d"),
    ])
    expect(result.ok && result.selection.account.id).toBe("d")
  })

  it("reports no-siblings when the provider has a single account", () => {
    const result = select([account("a")])
    expect(!result.ok && result.reason).toBe("no-siblings")
  })

  it("reports all-blocked when every sibling is held", () => {
    for (const id of ["b", "c"]) {
      breaker.recordFailure(
        credentialKey("anthropic", id, BREAKER_SCOPES.usage),
        quotaFailure,
        NOW,
        () => 0
      )
    }
    const result = select([account("a"), account("b"), account("c")])
    expect(!result.ok && result.reason).toBe("all-blocked")
  })

  it("stops at the attempt ceiling even with candidates left", () => {
    const state = createRotationState("a")
    state.attempts = MAX_ATTEMPTS_PER_OPERATION
    const result = select([account("a"), account("b")], state)
    expect(!result.ok && result.reason).toBe("attempts-exhausted")
  })

  it("counts the selection against the attempt budget", () => {
    const state = createRotationState("a")
    expect(state.attempts).toBe(1)
    select([account("a"), account("b")], state)
    expect(state.attempts).toBe(2)
  })

  it("considers a blocked sibling again once its block expires", () => {
    const key = credentialKey("anthropic", "b", BREAKER_SCOPES.usage)
    const until = breaker.recordFailure(key, quotaFailure, NOW, () => 0)
    const candidates = [account("a"), account("b")]
    expect(select(candidates).ok).toBe(false)
    const later = selectNextAccount({
      provider: "anthropic",
      candidates,
      state: createRotationState("a"),
      breaker,
      now: until,
      scope: BREAKER_SCOPES.usage,
    })
    expect(later.ok && later.selection.account.id).toBe("b")
  })
})
