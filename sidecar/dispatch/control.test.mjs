// Tests for the pure session-control helpers (allowlist, arg mapping, response
// shaping). No I/O — exercises the logic the host's `handleControl` relies on.

import { test } from "node:test"
import assert from "node:assert/strict"
import { CONTROL_METHODS, isControlMethod, controlArgs, buildControlResponse } from "./control.mjs"

test("isControlMethod accepts only allowlisted methods", () => {
  for (const m of CONTROL_METHODS) {
    assert.equal(isControlMethod(m), true, `${m} should be allowed`)
  }
  for (const m of ["close", "interrupt", "__proto__", "setModelX", "", null, undefined, 42]) {
    assert.equal(isControlMethod(m), false, `${String(m)} should be rejected`)
  }
})

test("controlArgs maps params to positional args", () => {
  assert.deepEqual(controlArgs("setModel", { model: "claude-opus-4-8" }), ["claude-opus-4-8"])
  assert.deepEqual(controlArgs("reconnectMcpServer", { name: "github" }), ["github"])
  assert.deepEqual(controlArgs("toggleMcpServer", { name: "github", enabled: false }), [
    "github",
    false,
  ])
  // No-arg methods ignore params.
  assert.deepEqual(controlArgs("getContextUsage", { junk: 1 }), [])
  assert.deepEqual(controlArgs("mcpServerStatus", undefined), [])
  assert.deepEqual(controlArgs("supportedModels"), [])
  assert.deepEqual(controlArgs("steer", { prompt: "redirect", priority: "now" }), [
    "redirect",
    "now",
  ])
})

test("controlArgs tolerates missing params", () => {
  assert.deepEqual(controlArgs("setModel", undefined), [undefined])
  assert.deepEqual(controlArgs("toggleMcpServer"), [undefined, undefined])
})

test("buildControlResponse shapes a success reply", () => {
  const r = buildControlResponse({
    sessionId: "s1",
    requestId: "r1",
    method: "getContextUsage",
    ok: true,
    result: { percentage: 0.42 },
  })
  assert.deepEqual(r, {
    type: "control_response",
    sessionId: "s1",
    requestId: "r1",
    method: "getContextUsage",
    ok: true,
    result: { percentage: 0.42 },
  })
})

test("buildControlResponse omits result when undefined (e.g. setModel)", () => {
  const r = buildControlResponse({
    sessionId: "s1",
    requestId: "r2",
    method: "setModel",
    ok: true,
  })
  assert.equal("result" in r, false)
  assert.equal(r.ok, true)
})

test("buildControlResponse shapes a failure reply with a default code", () => {
  const r = buildControlResponse({
    sessionId: "s1",
    requestId: "r3",
    method: "mcpServerStatus",
    ok: false,
  })
  assert.equal(r.ok, false)
  assert.equal(r.error, "error")
  assert.equal("result" in r, false)
})

test("buildControlResponse preserves an explicit error code", () => {
  const r = buildControlResponse({
    sessionId: "s1",
    requestId: "r4",
    method: "setModel",
    ok: false,
    error: "unsupported_provider",
  })
  assert.equal(r.error, "unsupported_provider")
})
