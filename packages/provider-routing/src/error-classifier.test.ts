import {
  classifyProviderError,
  classifyProviderErrorInfo,
  extractRetryAfterMs,
  isTransientErrorClass,
} from "./error-classifier"

describe("classifyProviderError", () => {
  it.each([
    // [message, expected class]
    ["prompt is too long: 224864 tokens > 200000 maximum", "context-window-exceeded"],
    ["This model's maximum context length is 128000 tokens", "context-window-exceeded"],
    [
      "400 Bad Request: input length and max_tokens exceed context limit",
      "context-window-exceeded",
    ],
    ["request exceeds the context window", "context-window-exceeded"],
    ["blocked by content_policy", "content-policy"],
    ["Your request was rejected: policy violation detected", "content-policy"],
    ["response flagged by moderation", "content-policy"],
    ["Azure content management policy triggered", "content-policy"],
    ["401 Unauthorized", "auth"],
    ["invalid_api_key provided", "auth"],
    ["403 forbidden", "auth"],
    ["HTTPError 429: rate_limit_error", "rate-limit"],
    ["too many requests, slow down", "rate-limit"],
    ["quota exceeded for this billing period", "rate-limit"],
    ["Request timed out after 30000ms", "timeout"],
    ["connect ETIMEDOUT 1.2.3.4:443", "timeout"],
    ["network error: ECONNRESET", "network"],
    ["fetch failed", "network"],
    ["502 Bad Gateway", "server-error"],
    ["upstream provider_error", "server-error"],
    ["model is overloaded, try again later", "server-error"],
    ["invalid_request: unknown parameter", "invalid-request"],
    ["something inexplicable happened", "unknown"],
  ])("%s → %s", (message, expected) => {
    expect(classifyProviderError(message)).toBe(expected)
  })

  it("special classes win over embedded status codes", () => {
    // A context overflow surfaced as a 400 must NOT classify as invalid-request.
    expect(classifyProviderError("400: prompt is too long for the context window")).toBe(
      "context-window-exceeded"
    )
    // A content filter surfaced as a 400 must NOT classify as invalid-request.
    expect(classifyProviderError("400: blocked by content filter")).toBe("content-policy")
  })
})

describe("isTransientErrorClass", () => {
  it("marks only retry-worthy classes transient", () => {
    expect(isTransientErrorClass("rate-limit")).toBe(true)
    expect(isTransientErrorClass("timeout")).toBe(true)
    expect(isTransientErrorClass("network")).toBe(true)
    expect(isTransientErrorClass("server-error")).toBe(true)
    expect(isTransientErrorClass("context-window-exceeded")).toBe(false)
    expect(isTransientErrorClass("content-policy")).toBe(false)
    expect(isTransientErrorClass("auth")).toBe(false)
    expect(isTransientErrorClass("invalid-request")).toBe(false)
    expect(isTransientErrorClass("unknown")).toBe(false)
  })
})

describe("extractRetryAfterMs", () => {
  it.each([
    // [message, expected ms]
    ["429: retry-after: 30", 30_000],
    ['rate limited. {"retry_after": 12}', 12_000],
    ["Retry-After: 5 seconds", 5_000],
    ["Please try again in 20s", 20_000],
    ["please retry in 1500ms", 1_500],
    ["try again in 2 minutes", 120_000],
    ['google rpc: "retryDelay": "7s"', 7_000],
    ["retryDelay: 250ms", 250],
  ])("%s → %d", (message, expected) => {
    expect(extractRetryAfterMs(message)).toBe(expected)
  })

  it("parses an http-date Retry-After against the injected clock", () => {
    const base = Date.parse("Mon, 08 Jun 2026 12:00:00 GMT")
    const msg = "429 Too Many Requests, Retry-After: Mon, 08 Jun 2026 12:00:45 GMT"
    expect(extractRetryAfterMs(msg, () => base)).toBe(45_000)
    // A date already in the past yields no hint.
    expect(extractRetryAfterMs(msg, () => base + 60_000)).toBeUndefined()
  })

  it("ignores arbitrary numbers without a retry phrase", () => {
    expect(extractRetryAfterMs("HTTPError 429: rate_limit_error")).toBeUndefined()
    expect(extractRetryAfterMs("model is overloaded, try again later")).toBeUndefined()
    expect(extractRetryAfterMs("502 Bad Gateway after 30000ms")).toBeUndefined()
  })
})

describe("classifyProviderErrorInfo", () => {
  it("attaches the hint for rate-limit errors", () => {
    const info = classifyProviderErrorInfo("429 rate limit exceeded, retry-after: 10")
    expect(info.errorClass).toBe("rate-limit")
    expect(info.retryAfterMs).toBe(10_000)
  })

  it("attaches the hint for server errors", () => {
    const info = classifyProviderErrorInfo("503 service unavailable, try again in 30s")
    expect(info.errorClass).toBe("server-error")
    expect(info.retryAfterMs).toBe(30_000)
  })

  it("never attaches a hint to non-retryable classes", () => {
    // The message contains a retry phrase but the class is auth → no hint.
    const info = classifyProviderErrorInfo("401 Unauthorized, retry-after: 60")
    expect(info.errorClass).toBe("auth")
    expect(info.retryAfterMs).toBeUndefined()
  })

  it("omits the hint when none is present", () => {
    expect(classifyProviderErrorInfo("HTTPError 429: rate_limit_error")).toEqual({
      errorClass: "rate-limit",
    })
  })

  describe("structured HTTP metadata", () => {
    it("rescues classification from httpStatus when the message is unhelpful", () => {
      // The message matches no pattern, but the real status says 429.
      const info = classifyProviderErrorInfo("upstream connect error", { httpStatus: 429 })
      expect(info.errorClass).toBe("rate-limit")
    })

    it("maps 5xx status to server-error and 401 to auth", () => {
      expect(classifyProviderErrorInfo("boom", { httpStatus: 503 }).errorClass).toBe("server-error")
      expect(classifyProviderErrorInfo("boom", { httpStatus: 401 }).errorClass).toBe("auth")
    })

    it("never lets status OVERRIDE a message-derived special class", () => {
      // A context-window error is usually HTTP 400; the message must win so it
      // routes to the dedicated chain, not get demoted to invalid-request.
      const info = classifyProviderErrorInfo("prompt is too long: 300000 tokens", {
        httpStatus: 400,
      })
      expect(info.errorClass).toBe("context-window-exceeded")
    })

    it("prefers a real retryAfterMs over the string-extracted one", () => {
      const info = classifyProviderErrorInfo("429 rate limit, retry-after: 10", {
        retryAfterMs: 2500,
      })
      expect(info.errorClass).toBe("rate-limit")
      expect(info.retryAfterMs).toBe(2500)
    })

    it("ignores retryAfterMs for a non-retryable class", () => {
      const info = classifyProviderErrorInfo("invalid api key", {
        httpStatus: 401,
        retryAfterMs: 9000,
      })
      expect(info.errorClass).toBe("auth")
      expect(info.retryAfterMs).toBeUndefined()
    })
  })
})
