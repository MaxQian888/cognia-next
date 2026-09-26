import { test } from "node:test"
import assert from "node:assert/strict"

import { TOOL_RESULT_PII_ERROR, assertModelSafeToolOutput } from "./tool-output.ts"

const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64")

test("output without PII passes through unchanged", () => {
  assert.equal(assertModelSafeToolOutput("3 files changed"), "3 files changed")
  const result = { content: [{ type: "text", text: "ok" }], isError: false }
  assert.deepEqual(assertModelSafeToolOutput(result), result)
  assert.equal(assertModelSafeToolOutput(null), null)
  assert.equal(assertModelSafeToolOutput(42), 42)
})

test("PII in plain text is replaced by placeholders", () => {
  assert.equal(assertModelSafeToolOutput("mail alice@example.com today"), "mail <EMAIL_001> today")
})

test("PII nested in a CallToolResult is redacted without changing its shape", () => {
  const result = assertModelSafeToolOutput({
    content: [{ type: "text", text: "Contact alice@example.com" }],
    isError: false,
  })
  assert.deepEqual(result, {
    content: [{ type: "text", text: "Contact <EMAIL_001>" }],
    isError: false,
  })
})

test("a JSON string stays valid JSON; only its string values are redacted", () => {
  const json = JSON.stringify({ at: 1767225600000, owner: "alice@example.com" })
  const safe = assertModelSafeToolOutput(json) as string
  assert.deepEqual(JSON.parse(safe), { at: 1767225600000, owner: "<EMAIL_001>" })
})

test("text that only starts with a brace is redacted as text", () => {
  assert.equal(assertModelSafeToolOutput("{not json} alice@example.com"), "{not json} <EMAIL_001>")
})

test("a textual resource blob is decoded, redacted and re-encoded", () => {
  const result = assertModelSafeToolOutput({
    content: [
      {
        type: "resource",
        resource: {
          uri: "file:///repo/contacts.txt",
          blob: base64("Contact alice@example.com"),
          mimeType: "application/json; charset=utf-8",
        },
      },
    ],
  }) as { content: { resource: { blob: string } }[] }
  const decoded = Buffer.from(result.content[0]!.resource.blob, "base64").toString("utf8")
  assert.equal(decoded, "Contact <EMAIL_001>")
})

test("a binary resource blob is left as it is", () => {
  const blob = base64("\u0000\u0001 alice@example.com")
  const output = {
    type: "resource",
    resource: { uri: "file:///repo/a.bin", blob, mimeType: "application/octet-stream" },
  }
  assert.deepEqual(assertModelSafeToolOutput(output), output)
})

test("a textual blob that is not canonical base64 of UTF-8 fails the gate", () => {
  const withBlob = (blob: string) => ({
    type: "resource",
    resource: { uri: "file:///repo/a.txt", blob, mimeType: "text/plain" },
  })
  assert.throws(() => assertModelSafeToolOutput(withBlob("not base64!")), {
    message: TOOL_RESULT_PII_ERROR,
  })
  // Valid alphabet, but a length no encoder produces.
  assert.throws(() => assertModelSafeToolOutput(withBlob("QUJDR")), {
    message: TOOL_RESULT_PII_ERROR,
  })
  // Canonical base64 of bytes that are not UTF-8.
  assert.throws(
    () => assertModelSafeToolOutput(withBlob(Buffer.from([0xff, 0xfe]).toString("base64"))),
    { message: TOOL_RESULT_PII_ERROR }
  )
})

test("maps, sets and dates survive; a cycle is cut", () => {
  const cyclic: Record<string, unknown> = { note: "alice@example.com" }
  cyclic.self = cyclic
  const at = new Date(0)
  const result = assertModelSafeToolOutput({
    cyclic,
    map: new Map([["owner", "alice@example.com"]]),
    set: new Set(["bob@example.com"]),
    at,
  }) as {
    cyclic: Record<string, unknown>
    map: Map<string, string>
    set: Set<string>
    at: Date
  }
  assert.equal(result.cyclic.note, "<EMAIL_001>")
  assert.equal(result.cyclic.self, "[circular tool output omitted]")
  assert.ok(result.map instanceof Map)
  assert.ok(result.set instanceof Set)
  assert.equal(result.at, at)
  assert.doesNotMatch(
    JSON.stringify([...result.map.values(), ...result.set.values()]),
    /@example\.com/
  )
})
