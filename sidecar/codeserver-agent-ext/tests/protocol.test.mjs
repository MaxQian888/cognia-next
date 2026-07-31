import assert from "node:assert/strict"
import { test } from "node:test"

import {
  diagnosticSeverityName,
  editReflectionAction,
  eventFrame,
  helloFrame,
  notificationKind,
  parseRequest,
  responseFrame,
  shouldReflectEdit,
  splitFrames,
  toZeroBased,
} from "../src/protocol.mjs"

test("splitFrames returns complete lines and keeps the trailing partial", () => {
  const { lines, rest } = splitFrames('{"a":1}\n{"b":2}\n{"c":')
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}'])
  assert.equal(rest, '{"c":')
})

test("splitFrames drops blank lines and trims", () => {
  const { lines, rest } = splitFrames("  x  \n\n y \n")
  assert.deepEqual(lines, ["x", "y"])
  assert.equal(rest, "")
})

test("parseRequest accepts a well-formed req and defaults params", () => {
  assert.deepEqual(parseRequest('{"type":"req","id":5,"method":"openFile"}'), {
    id: 5,
    method: "openFile",
    params: {},
  })
  assert.deepEqual(
    parseRequest('{"type":"req","id":6,"method":"openFile","params":{"path":"/a"}}'),
    { id: 6, method: "openFile", params: { path: "/a" } }
  )
})

test("parseRequest rejects malformed, non-req, or ill-typed frames", () => {
  assert.equal(parseRequest("not json"), null)
  assert.equal(parseRequest('{"type":"res","id":1}'), null)
  assert.equal(parseRequest('{"type":"req","method":"x"}'), null) // no id
  assert.equal(parseRequest('{"type":"req","id":"1","method":"x"}'), null) // id not a number
  assert.equal(parseRequest('{"type":"req","id":1}'), null) // no method
})

test("helloFrame is newline-terminated JSON carrying the token", () => {
  const frame = helloFrame("tok-1")
  assert.ok(frame.endsWith("\n"))
  assert.deepEqual(JSON.parse(frame), { type: "hello", token: "tok-1" })
})

test("responseFrame encodes success and failure", () => {
  assert.deepEqual(JSON.parse(responseFrame(3, { ok: true, result: { opened: true } })), {
    type: "res",
    id: 3,
    ok: true,
    result: { opened: true },
  })
  assert.deepEqual(JSON.parse(responseFrame(4, { ok: false, error: "boom" })), {
    type: "res",
    id: 4,
    ok: false,
    error: "boom",
  })
  // A success with no result defaults to null (not undefined, which JSON drops).
  assert.equal(JSON.parse(responseFrame(5, { ok: true })).result, null)
})

test("toZeroBased converts 1-based positions and guards non-numbers", () => {
  assert.equal(toZeroBased(1), 0)
  assert.equal(toZeroBased(42), 41)
  assert.equal(toZeroBased(0), 0) // clamped, never negative
  assert.equal(toZeroBased(undefined), null)
  assert.equal(toZeroBased("3"), null)
  assert.equal(toZeroBased(NaN), null)
})

test("shouldReflectEdit reflects only an open, still-stale buffer", () => {
  // Open and differs from disk → reflect as an undo-able edit.
  assert.equal(shouldReflectEdit("new", "old"), true)
  // Open but already reconciled → nothing to reflect.
  assert.equal(shouldReflectEdit("same", "same"), false)
  // Not open (null buffer) → reveal only, no undo history to preserve.
  assert.equal(shouldReflectEdit("new", null), false)
})

test("editReflectionAction requires conflict handling for a dirty stale buffer", () => {
  assert.equal(editReflectionAction("agent", "user draft", true), "conflict")
  assert.equal(editReflectionAction("agent", "old disk", false), "reflect")
  assert.equal(editReflectionAction("same", "same", true), "reveal")
  assert.equal(editReflectionAction("agent", null, false), "reveal")
})

test("diagnosticSeverityName maps VS Code severities and defaults to info", () => {
  assert.equal(diagnosticSeverityName(0), "error")
  assert.equal(diagnosticSeverityName(1), "warning")
  assert.equal(diagnosticSeverityName(2), "info")
  assert.equal(diagnosticSeverityName(3), "hint")
  assert.equal(diagnosticSeverityName(99), "info")
})

test("eventFrame is newline-terminated JSON with no correlation id", () => {
  const frame = eventFrame("activeEditorChanged", { path: "/a.ts" })
  assert.ok(frame.endsWith("\n"))
  const parsed = JSON.parse(frame)
  assert.deepEqual(parsed, {
    type: "evt",
    name: "activeEditorChanged",
    payload: { path: "/a.ts" },
  })
  // No id: an event must never be able to satisfy a pending request.
  assert.equal("id" in parsed, false)
})

test("eventFrame normalises a missing payload to null", () => {
  // undefined would be dropped by JSON.stringify, leaving the key absent and the
  // Rust `Option<Value>` unable to distinguish it from a malformed frame.
  assert.equal(JSON.parse(eventFrame("documentSaved")).payload, null)
  assert.equal(JSON.parse(eventFrame("documentSaved", undefined)).payload, null)
})

test("eventFrame survives a round-trip through splitFrames", () => {
  const { lines, rest } = splitFrames(eventFrame("a", { n: 1 }) + eventFrame("b", { n: 2 }))
  assert.equal(rest, "")
  assert.deepEqual(
    lines.map((l) => JSON.parse(l).name),
    ["a", "b"]
  )
})

test("parseRequest ignores an event frame", () => {
  // The two directions share a socket; a request parser must not claim events.
  assert.equal(parseRequest(eventFrame("activeEditorChanged", {}).trim()), null)
})

test("notificationKind narrows to what the editor can show", () => {
  assert.equal(notificationKind("error"), "error")
  assert.equal(notificationKind("warning"), "warning")
  assert.equal(notificationKind("info"), "info")
  // Anything unrecognised still shows, as info — a message the app wanted
  // surfaced must not be dropped over a misspelled kind.
  assert.equal(notificationKind(undefined), "info")
  assert.equal(notificationKind("critical"), "info")
  assert.equal(notificationKind(7), "info")
})
