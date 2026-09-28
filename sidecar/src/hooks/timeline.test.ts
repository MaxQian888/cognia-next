import { test } from "node:test"
import assert from "node:assert/strict"
import { buildHookAuditPayload, buildHookFirePayload, hookFireOutcome } from "./agent-hooks.ts"

test("hookFireOutcome: precedence block > context > warning > null", () => {
  assert.equal(hookFireOutcome({ block: "x", warnings: [] }), "blocked")
  assert.equal(hookFireOutcome({ additionalContext: "x", warnings: [] }), "context")
  assert.equal(hookFireOutcome({ warnings: ["w"] }), "warning")
  assert.equal(hookFireOutcome({ warnings: [] }), null)
})

test("buildHookFirePayload: matches the Rust envelope shape, null on no-op", () => {
  assert.equal(buildHookFirePayload("s1", "Stop", null, { warnings: [] }), null)
  const p = buildHookFirePayload("s1", "PreToolUse", "Bash", {
    block: "no",
    warnings: ["w"],
  })
  assert.equal(p!.type, "event")
  assert.equal(p!.sessionId, "s1")
  assert.equal(p!.event.subtype, "hook_fire")
  assert.equal(p!.event.hook_event, "PreToolUse")
  assert.equal(p!.event.tool_name, "Bash")
  assert.equal(p!.event.outcome, "blocked")
  assert.equal(p!.event.block, "no")
  assert.deepEqual(p!.event.warnings, ["w"])
})

test("buildHookAuditPayload creates a persistence-ready system event", () => {
  const payload = buildHookAuditPayload("s", {
    hookId: "h",
    hookEvent: "Stop",
    provider: "claude",
    handlerType: "command",
    policyClass: "user",
    outcome: "allowed",
    latencyMs: 2,
    redacted: false,
  })
  assert.equal(payload.sessionId, "s")
  assert.equal(payload.event.subtype, "hook_audit")
  assert.equal(payload.event.latencyMs, 2)
})
