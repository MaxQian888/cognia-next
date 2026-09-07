import {
  classifySubscriptionFailure,
  classifyThrownFailure,
  isAccountQuotaText,
  isOpaqueBody,
} from "./failure-class"

const NOW = Date.parse("2026-09-01T00:00:00.000Z")

const classify = (status: number | undefined, body?: string) =>
  classifySubscriptionFailure({ status, body, now: NOW })

describe("classifySubscriptionFailure: the rotate-vs-wait split", () => {
  it("reads a per-minute throttle as transient on the SAME credential", () => {
    const failure = classify(429, "Rate limit exceeded: 5 requests per minute")
    expect(failure.reason).toBe("throttled")
    expect(failure.rotatable).toBe(false)
    expect(failure.retryable).toBe(true)
  })

  it("reads an account quota exhaustion as rotatable", () => {
    const failure = classify(429, "You have exhausted your capacity on this model")
    expect(failure.reason).toBe("account-quota")
    expect(failure.rotatable).toBe(true)
  })

  it("reads the Anthropic usage-limit body as an account quota", () => {
    const failure = classify(429, '{"type":"error","error":{"type":"usage_limit_reached"}}')
    expect(failure.reason).toBe("account-quota")
    expect(failure.rotatable).toBe(true)
  })

  it("reads a Simplified Chinese usage cap as an account quota", () => {
    const body = "已达到 5 小时的使用上限。您的限额将在 2026-09-01 02:00:00 重置。"
    const failure = classify(429, body)
    expect(failure.reason).toBe("account-quota")
    expect(failure.retryAfterMs).toBe(2 * 60 * 60_000)
  })

  it("does NOT read a Chinese per-minute cap as an account quota", () => {
    // 每分钟请求数已达上限 contains both 使用-adjacent wording and 上限, but it
    // is transient. Rotating here would burn a healthy sibling.
    const failure = classify(429, "每分钟请求数已达上限，请稍后重试")
    expect(failure.reason).toBe("throttled")
    expect(failure.rotatable).toBe(false)
  })

  it("treats an opaque 429 conservatively as an account quota", () => {
    // The server told us nothing. Guessing "transient" is the guess that keeps
    // hammering, so the conservative branch wins.
    expect(classify(429, "").reason).toBe("account-quota")
    expect(classify(429, undefined).reason).toBe("account-quota")
    expect(classify(429, "429 Too Many Requests").reason).toBe("account-quota")
  })

  it("treats 402 as a billing cap regardless of body", () => {
    expect(classify(402, "Insufficient Balance").reason).toBe("billing-cap")
    expect(classify(402, undefined).reason).toBe("billing-cap")
    expect(classify(402, "A subscription is required").rotatable).toBe(true)
  })

  it("reads an account-scoped 403 cap as a quota, but a bare 403 as auth", () => {
    expect(classify(403, "Reached overall message rate limit").reason).toBe("account-quota")
    expect(classify(403, "Forbidden").reason).toBe("auth-expired")
  })

  it("never rotates on a concurrency cap", () => {
    const failure = classify(429, "Too many concurrent requests")
    expect(failure.reason).toBe("concurrency")
    expect(failure.rotatable).toBe(false)
  })
})

describe("classifySubscriptionFailure: auth", () => {
  it("latches a revoked refresh token as permanent and non-retryable", () => {
    const failure = classify(400, '{"error":"invalid_grant"}')
    expect(failure.reason).toBe("auth-revoked")
    expect(failure.permanent).toBe(true)
    expect(failure.retryable).toBe(false)
  })

  it("latches an explicit reauthenticate demand", () => {
    expect(classify(401, "Please reauthenticate this account").permanent).toBe(true)
    expect(classify(403, "account is suspended").reason).toBe("auth-revoked")
  })

  it("treats a plain 401 as a refreshable expiry, not a rotation", () => {
    const failure = classify(401, "Unauthorized")
    expect(failure.reason).toBe("auth-expired")
    expect(failure.rotatable).toBe(false)
    expect(failure.permanent).toBe(false)
  })
})

describe("classifySubscriptionFailure: transient classes", () => {
  it("maps overload and 529 to capacity", () => {
    expect(classify(529, "Overloaded").reason).toBe("capacity")
    expect(classify(503, "Service Unavailable").reason).toBe("capacity")
  })

  it("maps other 5xx to a server error", () => {
    expect(classify(500, "Internal Server Error").reason).toBe("server-error")
    expect(classify(502, "Bad Gateway").reason).toBe("server-error")
  })

  it("maps 408 to a retryable network failure", () => {
    expect(classify(408, "Request Timeout").reason).toBe("network")
    expect(classify(408, "Request Timeout").retryable).toBe(true)
  })

  it("refuses to retry a malformed request", () => {
    const failure = classify(400, "invalid_request_error: bad model")
    expect(failure.reason).toBe("client-error")
    expect(failure.retryable).toBe(false)
  })

  it("falls back to the shared classifier when no status reached us", () => {
    expect(classify(undefined, "fetch failed").reason).toBe("network")
    expect(classify(undefined, "ECONNRESET").reason).toBe("network")
    expect(classify(undefined, "operation timed out").reason).toBe("network")
  })

  it("returns unknown, treated conservatively, for an unreadable failure", () => {
    const failure = classify(undefined, "???")
    expect(failure.reason).toBe("unknown")
    expect(failure.rotatable).toBe(false)
  })
})

describe("retry hints ride along with the classification", () => {
  it("carries the header hint onto the failure", () => {
    const failure = classifySubscriptionFailure({
      status: 429,
      body: "slow down",
      headers: { "retry-after": "42" },
      now: NOW,
    })
    expect(failure.retryAfterMs).toBe(42_000)
  })

  it("omits the field entirely when the server gave no hint", () => {
    expect(classify(500, "boom")).not.toHaveProperty("retryAfterMs")
  })
})

describe("classifyThrownFailure", () => {
  it("recovers the status from the transport's rejection string", () => {
    // `subscription_authed_get` rejects non-2xx as "{status}: {body}".
    const failure = classifyThrownFailure(new Error("429: usage_limit_reached"), NOW)
    expect(failure.status).toBe(429)
    expect(failure.reason).toBe("account-quota")
  })

  it("handles a bare string rejection from Tauri", () => {
    expect(classifyThrownFailure("503: Service Unavailable", NOW).reason).toBe("capacity")
  })

  it("classifies a statusless transport error as network", () => {
    expect(classifyThrownFailure(new Error("fetch failed"), NOW).reason).toBe("network")
  })
})

describe("isOpaqueBody", () => {
  it("is true for nothing, framing, and bare status digits", () => {
    expect(isOpaqueBody(undefined)).toBe(true)
    expect(isOpaqueBody("")).toBe(true)
    expect(isOpaqueBody("   ")).toBe(true)
    expect(isOpaqueBody("429")).toBe(true)
    expect(isOpaqueBody("HTTP 429")).toBe(true)
    expect(isOpaqueBody("{}")).toBe(true)
  })

  it("is false once the body carries something the classifier can read", () => {
    expect(isOpaqueBody("rate limit exceeded")).toBe(false)
    expect(isOpaqueBody("请求过于频繁")).toBe(false)
  })
})

describe("isAccountQuotaText", () => {
  it("accepts the account-local phrasings", () => {
    expect(isAccountQuotaText("Your account's rate limit was reached")).toBe(true)
    expect(isAccountQuotaText("Insufficient credits")).toBe(true)
    expect(isAccountQuotaText("free-models-per-day")).toBe(false)
    expect(isAccountQuotaText("spend limit reached")).toBe(true)
  })

  it("rejects the transient phrasings", () => {
    expect(isAccountQuotaText("3 requests per minute")).toBe(false)
    expect(isAccountQuotaText("Your subscription allows 60 requests per minute")).toBe(false)
  })
})
