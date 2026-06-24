import { test } from "node:test"
import assert from "node:assert/strict"
import { extractHttpErrorMeta, parseRetryAfterMs } from "./http-error-meta.mjs"

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
