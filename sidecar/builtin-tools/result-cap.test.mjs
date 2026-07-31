import { test } from "node:test"
import assert from "node:assert/strict"
import {
  capToolCallResult,
  wrapHandlerWithResultCap,
  wrapDefsWithResultCap,
} from "./result-cap.mjs"

test("capToolCallResult truncates an over-budget text block and marks it", () => {
  const result = { content: [{ type: "text", text: "x".repeat(100) }] }
  const capped = capToolCallResult(result, 40)
  assert.notEqual(capped, result, "a new result is returned when truncated")
  assert.ok(capped.content[0].text.startsWith("x".repeat(40)))
  assert.match(capped.content[0].text, /truncated to fit the context window/)
})

test("capToolCallResult returns the same ref when under budget", () => {
  const result = { content: [{ type: "text", text: "short" }] }
  assert.equal(capToolCallResult(result, 40), result)
})

test("capToolCallResult leaves image blocks untouched (no base64 corruption)", () => {
  const result = {
    content: [
      { type: "text", text: "y".repeat(100) },
      { type: "image", data: "QUJD".repeat(50), mimeType: "image/png" },
    ],
  }
  const capped = capToolCallResult(result, 40)
  // Text capped…
  assert.ok(capped.content[0].text.length < 100)
  // …image block preserved byte-for-byte.
  assert.deepEqual(capped.content[1], result.content[1])
})

test("capToolCallResult preserves the isError flag", () => {
  const result = { content: [{ type: "text", text: "z".repeat(100) }], isError: true }
  const capped = capToolCallResult(result, 40)
  assert.equal(capped.isError, true)
})

test("capToolCallResult passes through a non-CallToolResult shape", () => {
  assert.equal(capToolCallResult(undefined, 40), undefined)
  assert.equal(capToolCallResult("plain", 40), "plain")
  const noContent = { foo: 1 }
  assert.equal(capToolCallResult(noContent, 40), noContent)
})

test("wrapHandlerWithResultCap caps an async handler's returned text", async () => {
  const def = {
    name: "bash",
    handler: async () => ({ content: [{ type: "text", text: "a".repeat(100) }] }),
  }
  const wrapped = wrapHandlerWithResultCap(def, 40)
  const out = await wrapped.handler({}, {})
  assert.ok(out.content[0].text.length < 100)
  assert.match(out.content[0].text, /truncated/)
})

test("wrapHandlerWithResultCap caps a sync-returning handler too", async () => {
  const def = {
    name: "read",
    handler: () => ({ content: [{ type: "text", text: "b".repeat(80) }] }),
  }
  const wrapped = wrapHandlerWithResultCap(def, 20)
  const out = await wrapped.handler({}, {})
  assert.ok(out.content[0].text.startsWith("b".repeat(20)))
})

test("wrapHandlerWithResultCap returns the def untouched for a non-positive cap", () => {
  const def = { name: "x", handler: async () => ({ content: [] }) }
  assert.equal(wrapHandlerWithResultCap(def, 0), def)
  assert.equal(wrapHandlerWithResultCap(def, NaN), def)
  assert.equal(wrapHandlerWithResultCap({ name: "y" }, 40).handler, undefined)
})

test("wrapDefsWithResultCap is a no-op (same array ref) when disabled", () => {
  const defs = [{ name: "a", handler: async () => ({ content: [] }) }]
  assert.equal(wrapDefsWithResultCap(defs, undefined), defs)
  assert.equal(wrapDefsWithResultCap(defs, 0), defs)
})

test("wrapDefsWithResultCap converts a token budget to a char budget (≈4/token)", async () => {
  const defs = [
    { name: "bash", handler: async () => ({ content: [{ type: "text", text: "c".repeat(100) }] }) },
  ]
  // 10 tokens ≈ 40 chars.
  const wrapped = wrapDefsWithResultCap(defs, 10)
  const out = await wrapped[0].handler({}, {})
  assert.ok(out.content[0].text.startsWith("c".repeat(40)))
  assert.ok(!out.content[0].text.startsWith("c".repeat(41)))
})
