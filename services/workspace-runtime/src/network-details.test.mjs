import assert from "node:assert/strict"
import test from "node:test"

import {
  NETWORK_BODY_LIMIT_BYTES,
  REDACTED_HEADERS,
  encodeBody,
  redactHeaders,
} from "./network-details.mjs"

test("redacts credential headers case-insensitively and keeps the rest", () => {
  assert.deepEqual(
    redactHeaders({
      Authorization: "Bearer abc",
      cookie: "sid=1",
      "Set-Cookie": "sid=2",
      "proxy-authorization": "Basic xyz",
      "content-type": "text/html",
    }),
    {
      Authorization: "[REDACTED]",
      cookie: "[REDACTED]",
      "Set-Cookie": "[REDACTED]",
      "proxy-authorization": "[REDACTED]",
      "content-type": "text/html",
    }
  )
  assert.deepEqual(redactHeaders(undefined), {})
})

test("redacts API-key, auth-token and CSRF headers in any casing", () => {
  assert.deepEqual(
    redactHeaders({
      "X-API-Key": "k",
      "x-auth-token": "t",
      "X-CSRF-Token": "c",
      "X-XSRF-TOKEN": "x",
      PROXY_AUTHORIZATION_LIKE: "kept",
      accept: "*/*",
    }),
    {
      "X-API-Key": "[REDACTED]",
      "x-auth-token": "[REDACTED]",
      "X-CSRF-Token": "[REDACTED]",
      "X-XSRF-TOKEN": "[REDACTED]",
      PROXY_AUTHORIZATION_LIKE: "kept",
      accept: "*/*",
    }
  )
})

test("the redacted header set matches the tool surface's set in lib/browser/protocol.ts", () => {
  assert.deepEqual([...REDACTED_HEADERS].sort(), [
    "authorization",
    "cookie",
    "proxy-authorization",
    "set-cookie",
    "x-api-key",
    "x-auth-token",
    "x-csrf-token",
    "x-xsrf-token",
  ])
})

test("truncates bodies at 64 KB and picks utf8 or base64 by content type", () => {
  const big = Buffer.alloc(NETWORK_BODY_LIMIT_BYTES + 10, "a")
  const text = encodeBody(big, "application/json; charset=utf-8")
  assert.equal(text.truncated, true)
  assert.equal(text.bodyEncoding, "utf8")
  assert.equal(text.body.length, NETWORK_BODY_LIMIT_BYTES)
  assert.equal(text.bodyBytes, NETWORK_BODY_LIMIT_BYTES + 10)

  const binary = encodeBody(Buffer.from([1, 2, 3]), "image/png")
  assert.deepEqual(binary, {
    body: Buffer.from([1, 2, 3]).toString("base64"),
    bodyEncoding: "base64",
    truncated: false,
    bodyBytes: 3,
  })
  assert.deepEqual(encodeBody(null, "text/plain"), {
    body: null,
    bodyEncoding: null,
    truncated: false,
    bodyBytes: 0,
  })
})

test("drops a multi-byte character split by truncation", () => {
  const bytes = Buffer.from("ab€", "utf8")
  const result = encodeBody(bytes, "text/plain", 3)
  assert.equal(result.body, "ab")
  assert.equal(result.truncated, true)
})
