// Agent host additions (ADR-0090 Phase 3): command idempotency, capability
// gating, and the claude-host.mjs compatibility shim. Lifecycle behavior
// (makeWrappedEmit / restartReason / routeClose …) stays covered by
// claude-host.test.mjs, which now imports through the shim — passing there IS
// the compat proof.

import test from "node:test"
import assert from "node:assert/strict"

import { blockUnsupportedCommand, dropDuplicateCommand, startAgentHost } from "./agent-host.mjs"
import * as shim from "./claude-host.mjs"

test("the claude-host shim re-exports the full agent-host surface", () => {
  for (const name of [
    "makeWrappedEmit",
    "restartReason",
    "routeClose",
    "routeRestore",
    "routeSteer",
    "buildPermissionResult",
    "startAgentHost",
    "dropDuplicateCommand",
    "blockUnsupportedCommand",
  ]) {
    assert.equal(typeof shim[name], "function", `shim must re-export ${name}`)
  }
  assert.equal(shim.startAgentHost, startAgentHost, "same function object, not a copy")
})

test("duplicate commandIds are acked once and dropped; LRU caps at 128", () => {
  const sessions = new Map([["s1", {}]])
  const out = []
  const emit = (m) => out.push(m)

  assert.equal(dropDuplicateCommand(sessions, { sessionId: "s1", commandId: "c1" }, emit), false)
  assert.equal(dropDuplicateCommand(sessions, { sessionId: "s1", commandId: "c1" }, emit), true)
  assert.deepEqual(out, [
    { type: "command_ack", sessionId: "s1", commandId: "c1", duplicate: true },
  ])

  // Fill past the LRU cap: the oldest id ages out and is processable again.
  for (let i = 0; i < 130; i += 1) {
    dropDuplicateCommand(sessions, { sessionId: "s1", commandId: `fill-${i}` }, emit)
  }
  assert.equal(dropDuplicateCommand(sessions, { sessionId: "s1", commandId: "c1" }, emit), false)

  // Messages without ids, or for unknown sessions, are never dropped.
  assert.equal(dropDuplicateCommand(sessions, { sessionId: "s1" }, emit), false)
  assert.equal(dropDuplicateCommand(sessions, { sessionId: "ghost", commandId: "x" }, emit), false)
})

test("commands unsupported by the frozen adapter emit a typed capability_error", () => {
  const sessions = new Map([
    ["frozen", { runtimeAdapterId: "ai-sdk" }],
    ["legacy", {}],
  ])
  const out = []
  const emit = (m) => out.push(m)

  // ai-sdk supports compaction/set_mode; steer is unsupported on both rails.
  assert.equal(
    blockUnsupportedCommand(sessions, { sessionId: "frozen", type: "steer" }, emit),
    true
  )
  assert.deepEqual(out, [
    { type: "capability_error", sessionId: "frozen", capability: "steer", command: "steer" },
  ])
  assert.equal(
    blockUnsupportedCommand(sessions, { sessionId: "frozen", type: "compact" }, emit),
    false
  )
  // Legacy sessions and unknown sessions are never blocked.
  assert.equal(
    blockUnsupportedCommand(sessions, { sessionId: "legacy", type: "steer" }, emit),
    false
  )
  assert.equal(
    blockUnsupportedCommand(sessions, { sessionId: "ghost", type: "steer" }, emit),
    false
  )
})

test("startAgentHost is exported and idempotent by contract (guard flag)", () => {
  // We cannot start the real stdin loop in a test process; assert the export
  // exists and is a zero-arg function (the shim + packaged-CLI role rely on
  // calling it more than once safely — see the hostStarted guard).
  assert.equal(typeof startAgentHost, "function")
  assert.equal(startAgentHost.length, 0)
})
