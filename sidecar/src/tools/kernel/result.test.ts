import { test } from "node:test"
import assert from "node:assert/strict"

import { toolError, toolText } from "./result.ts"
import type { ToolResult } from "./result.ts"

/** The text of a result's first block. */
function textOf(result: ToolResult): string {
  const block = result.content[0]
  return block?.type === "text" ? block.text : ""
}

test("toolText wraps a string in MCP content shape", () => {
  const r = toolText("hello")
  assert.deepEqual(r, { content: [{ type: "text", text: "hello" }] })
})

test("toolText JSON-serialises non-string payloads", () => {
  const r = toolText({ a: 1 })
  assert.match(textOf(r), /"a":\s*1/)
})

test("toolText sets isError when requested", () => {
  const r = toolText("oops", { isError: true })
  assert.equal(r.isError, true)
})

test("toolError formats Error instances, with its kind and retry guidance", () => {
  const r = toolError(new Error("boom"), "ctx")
  assert.equal(r.isError, true)
  // The message the caller wrote still leads; the classification follows it.
  assert.match(textOf(r), /^ctx: boom\n/)
  assert.match(textOf(r), /\[execution-failed\]/)
  assert.equal(r._meta?.["cognia/failure"].kind, "execution-failed")
})

test("toolError formats plain strings", () => {
  const r = toolError("nope")
  assert.equal(r.isError, true)
  assert.match(textOf(r), /^nope\n/)
})

test("toolError handles unknown error shapes", () => {
  const r = toolError(42)
  assert.equal(r.isError, true)
  assert.match(textOf(r), /^42\n/)
})

test("toolError tells the model when a repeat cannot help", () => {
  const r = toolError(Object.assign(new Error("no room"), { code: "ENOSPC" }), "write")
  assert.equal(r._meta?.["cognia/failure"].retryable, false)
  assert.match(textOf(r), /\[resource-exhausted\]/)
})
