import test from "node:test"
import assert from "node:assert/strict"
import {
  buildPermissionResult,
  persistableSuggestions,
  routeCallReserveDecision,
} from "./responses.ts"

// ---- permission result: user intent that used to be discarded --------------

const ALLOW_RULE = { type: "addRules", rules: [{ toolName: "Bash" }], destination: "session" }

test("the legacy rail's permission result is unchanged, field for field", () => {
  // ADR-0090 constraint 6: `claude_send` is still the production queue and this
  // is the same function on both rails, so the richer fields must be invisible
  // to it — an extra key here is a behaviour change on a path nobody opted in.
  assert.deepEqual(buildPermissionResult("allow", { input: { a: 1 } }), {
    behavior: "allow",
    updatedInput: { a: 1 },
  })
  assert.deepEqual(
    buildPermissionResult("allow_always", { input: { a: 1 }, suggestions: [ALLOW_RULE] }),
    { behavior: "allow", updatedInput: { a: 1 } }
  )
  assert.deepEqual(buildPermissionResult("deny", { message: "no", interrupt: true }), {
    behavior: "deny",
    message: "no",
  })
})

test('"always allow" carries the SDK\'s own permission updates on the new rail', () => {
  // Without this the user's "always" held for the renderer's session only: the
  // CLI's rule store never learned the decision, so the next identical call
  // prompted again.
  const res = buildPermissionResult("allow_always", {
    input: { a: 1 },
    suggestions: [ALLOW_RULE],
    rich: true,
  })
  assert.deepEqual(res.updatedPermissions, [ALLOW_RULE])
  assert.equal(res.decisionClassification, "user_permanent")
})

test("a one-off allow classifies as temporary and persists nothing", () => {
  const res = buildPermissionResult("allow", {
    input: {},
    suggestions: [ALLOW_RULE],
    rich: true,
  })
  assert.equal(res.decisionClassification, "user_temporary")
  assert.equal(res.updatedPermissions, undefined)
})

test("a deny can interrupt the turn instead of letting the model route around it", () => {
  const res = buildPermissionResult("deny", { message: "nope", interrupt: true, rich: true })
  assert.deepEqual(res, {
    behavior: "deny",
    message: "nope",
    interrupt: true,
    decisionClassification: "user_reject",
  })
  // Absent unless asked for — a plain refusal should not end the turn.
  assert.equal(buildPermissionResult("deny", { rich: true }).interrupt, undefined)
})

test("localSettings suggestions are never written back from a chat click", () => {
  // Those edit the user's on-disk settings file. Approving a tool call is
  // consent for this session, not consent to rewrite their configuration.
  const kept = persistableSuggestions([
    ALLOW_RULE,
    { type: "addRules", rules: [], destination: "localSettings" },
    { type: "setMode", mode: "acceptEdits", destination: "userSettings" },
  ])
  assert.deepEqual(kept, [
    ALLOW_RULE,
    { type: "setMode", mode: "acceptEdits", destination: "userSettings" },
  ])
})

test("malformed suggestions are dropped rather than forwarded as rules", () => {
  assert.deepEqual(persistableSuggestions(undefined), [])
  assert.deepEqual(persistableSuggestions("nope"), [])
  assert.deepEqual(
    persistableSuggestions([null, {}, { type: "addRules" }, { destination: "session" }]),
    []
  )
})

test("SDK suppressAlwaysAllowRule prevents durable grants even if a stale client sends always", () => {
  const result = buildPermissionResult("allow_always", {
    rich: true,
    suppressAlwaysAllowRule: true,
    input: { safe: true },
    suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
  })
  assert.equal(result.behavior, "allow")
  assert.equal(result.decisionClassification, "user_temporary")
  assert.equal(result.updatedPermissions, undefined)
})

test("buildPermissionResult: allow without updatedInput falls back to the original input (never undefined)", () => {
  const input = { query: "foo", path: "/x" }
  const res = buildPermissionResult("allow", { input })
  assert.equal(res.behavior, "allow")
  assert.deepEqual(res.updatedInput, input)
  assert.notEqual(res.updatedInput, undefined)
})

test("buildPermissionResult: allow_always also falls back to the original input", () => {
  const input = { a: 1 }
  const res = buildPermissionResult("allow_always", { input })
  assert.deepEqual(res, { behavior: "allow", updatedInput: { a: 1 } })
})

test("buildPermissionResult: an explicit updatedInput is preserved over the original input", () => {
  const res = buildPermissionResult("allow", { updatedInput: { a: 2 }, input: { a: 1 } })
  assert.deepEqual(res.updatedInput, { a: 2 })
})

test("buildPermissionResult: allow with neither updatedInput nor input defaults to an empty record (never undefined → no ZodError)", () => {
  const res = buildPermissionResult("allow", {})
  assert.equal(res.behavior, "allow")
  assert.deepEqual(res.updatedInput, {})
  assert.notEqual(res.updatedInput, undefined)
})

test("buildPermissionResult: allow called with no opts at all still yields an empty record", () => {
  const res = buildPermissionResult("allow")
  assert.deepEqual(res, { behavior: "allow", updatedInput: {} })
})

test("buildPermissionResult: deny carries the message (default when absent)", () => {
  assert.deepEqual(buildPermissionResult("deny", { message: "nope" }), {
    behavior: "deny",
    message: "nope",
  })
  assert.deepEqual(buildPermissionResult("deny", {}), {
    behavior: "deny",
    message: "denied by user",
  })
})

test("routes a reservation decision to the session's resolver", () => {
  const seen: unknown[] = []
  const sessions = new Map([
    ["s1", { resolveCallReserve: (msg: unknown) => (seen.push(msg), true) }],
    ["legacy", {}],
  ])
  const decision = { sessionId: "s1", requestId: "r1", decision: "granted", attemptId: "a1" }
  assert.equal(routeCallReserveDecision(sessions, decision), true)
  assert.deepEqual(seen, [decision])
  assert.equal(routeCallReserveDecision(sessions, { sessionId: "legacy", requestId: "r2" }), false)
  assert.equal(routeCallReserveDecision(sessions, { sessionId: "gone", requestId: "r3" }), false)
  assert.equal(routeCallReserveDecision(sessions, null), false)
})
