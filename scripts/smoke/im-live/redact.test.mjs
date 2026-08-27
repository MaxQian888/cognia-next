import test from "node:test"
import assert from "node:assert/strict"

import { createRedactor } from "./redact.mjs"

test("registered secrets are replaced by their label", () => {
  const r = createRedactor()
  r.register("super-secret-app-secret", "larkAppSecret")
  assert.equal(
    r.redactString("failed with super-secret-app-secret at the end"),
    "failed with «larkAppSecret» at the end"
  )
})

test("short values are not registered — they would shred unrelated text", () => {
  const r = createRedactor()
  r.register("abc", "tiny")
  assert.deepEqual(r.labels, [])
  assert.equal(r.redactString("abc def abc"), "abc def abc")
})

test("longer secrets win when one contains another", () => {
  const r = createRedactor()
  r.register("token-abcdefgh", "short")
  r.register("token-abcdefgh-extended", "long")
  assert.equal(r.redactString("token-abcdefgh-extended"), "«long»")
})

test("registering the same value twice keeps one entry", () => {
  const r = createRedactor()
  r.register("value-that-is-long", "a")
  r.register("value-that-is-long", "b")
  assert.deepEqual(r.labels, ["a"])
})

test("a Telegram token in a URL is caught without being registered", () => {
  const r = createRedactor()
  const url =
    "https://api.telegram.org/bot8123456789:AAH1zQxYbCdEfGhIjKlMnOpQrStUvWxYz01/sendMessage"
  const out = r.redactString(`request failed: ${url}`)
  assert.ok(!out.includes("AAH1zQxYbCdEfGhIjKlMnOpQrStUvWxYz01"), out)
  assert.ok(out.includes("«telegram-token»"), out)
})

test("Slack, Matrix and Lark token shapes are caught unregistered", () => {
  const r = createRedactor()
  const out = r.redactString(
    "xoxp-1234567890-abcdef and syt_dXNlcg_AbCdEfGhIjKl_0a1b2c and t-g204xxxxYYYYYzzzzz111122223333"
  )
  assert.ok(out.includes("«slack-token»"), out)
  assert.ok(out.includes("«matrix-token»"), out)
  assert.ok(out.includes("«lark-token»"), out)
  assert.ok(!/xoxp-1234567890/.test(out), out)
})

test("Authorization headers are scrubbed but the scheme survives", () => {
  const r = createRedactor()
  const out = r.redactString("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature")
  assert.equal(out, "Authorization: Bearer «redacted»")
})

test("redact walks arrays and plain objects", () => {
  const r = createRedactor()
  r.register("my-registered-secret", "botToken")
  const out = r.redact({
    ok: true,
    count: 2,
    nested: { header: "Bearer my-registered-secret", list: ["my-registered-secret", "clean"] },
  })
  assert.deepEqual(out, {
    ok: true,
    count: 2,
    nested: { header: "Bearer «botToken»", list: ["«botToken»", "clean"] },
  })
})

test("an Error carrying a secret is flattened and scrubbed", () => {
  const r = createRedactor()
  r.register("leaked-token-value", "appToken")
  const out = r.redact(new Error("call failed for leaked-token-value"))
  assert.equal(out, "Error: call failed for «appToken»")
})

test("null, undefined and primitives pass through untouched", () => {
  const r = createRedactor()
  assert.equal(r.redact(null), null)
  assert.equal(r.redact(undefined), undefined)
  assert.equal(r.redact(7), 7)
  assert.equal(r.redact(false), false)
})

test("a cycle is named rather than followed", () => {
  const redactor = createRedactor()
  redactor.register("super-secret-token", "driverToken")

  const payload = { note: "super-secret-token", child: {} }
  payload.child.parent = payload
  payload.child.self = payload.child

  const out = redactor.redact(payload)
  assert.equal(out.note, "«driverToken»")
  assert.equal(out.child.parent, "«circular»")
  assert.equal(out.child.self, "«circular»")

  // A repeat that is NOT a cycle is still walked — two fields pointing at one
  // object is an ordinary shape, not a loop.
  const shared = { token: "super-secret-token" }
  const twice = redactor.redact({ a: shared, b: shared })
  assert.deepEqual(twice, { a: { token: "«driverToken»" }, b: { token: "«driverToken»" } })
})

test("redact works when it is pulled off the redactor", () => {
  // It is handed around as a bare function in places; reaching the scrubber
  // through `this` would throw in the one call that must never fail.
  const { redact } = createRedactor()
  assert.deepEqual(redact({ a: ["x", 1, null] }), { a: ["x", 1, null] })
})
