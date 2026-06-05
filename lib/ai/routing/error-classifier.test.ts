import { classifyProviderError, isTransientErrorClass } from "./error-classifier"

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
