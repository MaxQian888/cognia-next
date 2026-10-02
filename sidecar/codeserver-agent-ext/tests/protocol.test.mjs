import assert from "node:assert/strict"
import { test } from "node:test"

import * as protocol from "../src/protocol.mjs"

const {
  diagnosticSeverityName,
  editReflectionAction,
  notificationKind,
  shouldReflectEdit,
  toZeroBased,
} = protocol

test("the retired newline framing helpers are gone", () => {
  // The host refuses anything that is not Content-Length framed; a leftover
  // newline encoder here would only build frames nobody accepts.
  for (const name of ["splitFrames", "parseRequest", "helloFrame", "eventFrame", "responseFrame"]) {
    assert.equal(name in protocol, false, name)
  }
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
