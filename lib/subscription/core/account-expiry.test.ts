import {
  ACCOUNT_EXPIRY_GRACE_MS,
  accountExpiryState,
  type AccountExpiryState,
} from "./account-expiry"

const NOW = 1_700_000_000_000

describe("accountExpiryState", () => {
  it("reports notApplicable for the documented 0 sentinel", () => {
    // `AccountSummary.expiresAtMs` is "0 when not applicable (api_key /
    // opencode-zen)" — those logins must never render as expired.
    expect(accountExpiryState(0, NOW)).toBe<AccountExpiryState>("notApplicable")
  })

  it("treats a negative or non-finite expiry as notApplicable, not as long-expired", () => {
    expect(accountExpiryState(-1, NOW)).toBe("notApplicable")
    expect(accountExpiryState(Number.NaN, NOW)).toBe("notApplicable")
    expect(accountExpiryState(Number.POSITIVE_INFINITY, NOW)).toBe("notApplicable")
  })

  it("is valid while the token has more than the grace window left", () => {
    expect(accountExpiryState(NOW + ACCOUNT_EXPIRY_GRACE_MS + 1, NOW)).toBe("valid")
    expect(accountExpiryState(NOW + 8 * 60 * 60 * 1000, NOW)).toBe("valid")
  })

  it("is stale once elapsed", () => {
    expect(accountExpiryState(NOW - 1, NOW)).toBe("stale")
    expect(accountExpiryState(NOW - 86_400_000, NOW)).toBe("stale")
  })

  // The 60s grace mirrors `isAnthropicCredentialFresh`, so the list badge and
  // the "logged in?" badge can't disagree right at the boundary.
  it("flips to stale inside the 60s grace, matching isAnthropicCredentialFresh", () => {
    expect(accountExpiryState(NOW + ACCOUNT_EXPIRY_GRACE_MS - 1, NOW)).toBe("stale")
    expect(accountExpiryState(NOW + ACCOUNT_EXPIRY_GRACE_MS, NOW)).toBe("stale")
  })

  it("honours a caller-supplied grace", () => {
    expect(accountExpiryState(NOW + 5_000, NOW, 1_000)).toBe("valid")
    expect(accountExpiryState(NOW + 5_000, NOW, 10_000)).toBe("stale")
  })
})
