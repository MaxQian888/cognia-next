import { test } from "node:test"
import assert from "node:assert/strict"
import { extractHttpErrorMeta, parseRetryAfterMs, providerForbidsRetry } from "./http-error-meta.ts"

test("parseRetryAfterMs: integer delta-seconds → ms", () => {
  assert.equal(parseRetryAfterMs("30"), 30_000)
  assert.equal(parseRetryAfterMs("0.5"), 500)
})

test("parseRetryAfterMs: HTTP-date relative to a fixed clock", () => {
  const now = () => Date.parse("Mon, 01 Jan 2030 00:00:00 GMT")
  assert.equal(parseRetryAfterMs("Mon, 01 Jan 2030 00:00:45 GMT", now), 45_000)
  // Past date → undefined
  assert.equal(parseRetryAfterMs("Mon, 01 Jan 2020 00:00:00 GMT", now), undefined)
})

test("parseRetryAfterMs: garbage / empty / nullish → undefined", () => {
  assert.equal(parseRetryAfterMs(""), undefined)
  assert.equal(parseRetryAfterMs("soon"), undefined)
  assert.equal(parseRetryAfterMs(undefined), undefined)
  assert.equal(parseRetryAfterMs(null), undefined)
})

test("extractHttpErrorMeta: Anthropic APIError shape (.status + .headers object)", () => {
  const meta = extractHttpErrorMeta({
    status: 429,
    headers: { "retry-after": "12", "x-other": "1" },
    message: "rate_limit_error",
  })
  assert.deepEqual(meta, { httpStatus: 429, retryAfterMs: 12_000 })
})

test("extractHttpErrorMeta: ai-sdk APICallError shape (.statusCode + .responseHeaders Headers)", () => {
  const headers = new Headers({ "Retry-After": "5" })
  const meta = extractHttpErrorMeta({ statusCode: 503, responseHeaders: headers })
  assert.deepEqual(meta, { httpStatus: 503, retryAfterMs: 5_000 })
})

test("extractHttpErrorMeta: status without a retry-after header omits retryAfterMs", () => {
  assert.deepEqual(extractHttpErrorMeta({ status: 500 }), { httpStatus: 500 })
})

test("extractHttpErrorMeta: non-object / plain string error → empty object", () => {
  assert.deepEqual(extractHttpErrorMeta("boom"), {})
  assert.deepEqual(extractHttpErrorMeta(null), {})
})

test("structured JSON errors expose only code and resetAt", () => {
  for (const [statusCode, code] of [
    [503, "model_access_unavailable"],
    [429, "member_usage_cap_reached"],
    [403, "host_surface_forbidden"],
  ] as const) {
    assert.deepEqual(
      extractHttpErrorMeta({
        statusCode,
        responseBody: JSON.stringify({
          error: { code, resetAt: 123, secret: "private", message: "private" },
        }),
      }),
      { httpStatus: statusCode, code, resetAt: 123 }
    )
  }
  assert.deepEqual(
    extractHttpErrorMeta({ responseBody: { code: "any_provider_code", resetAt: "2030-01-01" } }),
    { code: "any_provider_code", resetAt: "2030-01-01" }
  )
  assert.deepEqual(extractHttpErrorMeta({ responseBody: "not json" }), {})
  assert.deepEqual(extractHttpErrorMeta({ data: { error: { code: "other", resetAt: {} } } }), {
    code: "other",
  })
})

test("SDK retry wrappers retain the final structured failure and bound cyclic causes", () => {
  assert.deepEqual(
    extractHttpErrorMeta({
      lastError: {
        statusCode: 429,
        responseBody: JSON.stringify({ error: { code: "quota", resetAt: 123 } }),
      },
    }),
    { httpStatus: 429, code: "quota", resetAt: 123 }
  )
  const cycle: { cause?: unknown } = {}
  cycle.cause = cycle
  assert.deepEqual(extractHttpErrorMeta(cycle), {})
})

test("providerForbidsRetry: the x-should-retry header and a retryable:false body both say no", () => {
  assert.equal(
    providerForbidsRetry({ statusCode: 429, responseHeaders: { "X-Should-Retry": "false" } }),
    true
  )
  assert.equal(
    providerForbidsRetry({
      statusCode: 429,
      responseBody: JSON.stringify({
        error: { code: "member_usage_cap_reached", retryable: false },
      }),
    }),
    true
  )
  // Through a RetryError's last error, as the AI SDK wraps it.
  assert.equal(
    providerForbidsRetry({
      lastError: { statusCode: 429, responseHeaders: new Headers({ "x-should-retry": "false" }) },
    }),
    true
  )
})

test("providerForbidsRetry: an ordinary rate limit, or a header saying true, may be retried", () => {
  assert.equal(
    providerForbidsRetry({ statusCode: 429, responseHeaders: { "retry-after": "2" } }),
    false
  )
  assert.equal(
    providerForbidsRetry({ statusCode: 429, responseHeaders: { "x-should-retry": "true" } }),
    false
  )
  assert.equal(providerForbidsRetry({ statusCode: 503, responseBody: "not json" }), false)
  assert.equal(providerForbidsRetry(undefined), false)
})
