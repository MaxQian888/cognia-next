// Lifecycle test for the host's session-map retirement policy — the crux of
// multi-turn context retention. Before this, the host deleted a session on
// EVERY `session_ended`, so every non-Anthropic provider lost its in-process
// conversation each turn. `makeWrappedEmit` encodes the fixed policy:
//   • multi-turn (ai-sdk) session  → kept across per-turn `session_ended`,
//                                     retired only on `session_closed`.
//   • single-turn (Anthropic)      → retired on `session_ended` (resume rebuilds).
// `session_closed` is internal and must never be forwarded to the parent.

import { test } from "node:test"
import assert from "node:assert/strict"
import { makeWrappedEmit, restartReason, routeRestore } from "./claude-host.mjs"

function setup(sessionId, session) {
  const forwarded = []
  const sessions = new Map()
  if (session) sessions.set(sessionId, session)
  const wrapped = makeWrappedEmit((m) => forwarded.push(m), sessions, sessionId)
  return { forwarded, sessions, wrapped }
}

test("multi-turn session is KEPT across per-turn session_ended events", () => {
  const { forwarded, sessions, wrapped } = setup("s1", { multiTurn: true })

  wrapped({ type: "session_ended", sessionId: "s1" }) // turn 1
  assert.ok(sessions.has("s1"), "session survives turn 1")
  wrapped({ type: "session_ended", sessionId: "s1" }) // turn 2
  assert.ok(sessions.has("s1"), "session survives turn 2")

  // Each per-turn session_ended IS forwarded to the parent (capture resolves on it).
  assert.equal(forwarded.filter((m) => m.type === "session_ended").length, 2)
})

test("session_closed retires a multi-turn session and is NOT forwarded", () => {
  const { forwarded, sessions, wrapped } = setup("s1", { multiTurn: true })

  wrapped({ type: "session_ended", sessionId: "s1" })
  assert.ok(sessions.has("s1"))

  wrapped({ type: "session_closed", sessionId: "s1" })
  assert.equal(sessions.has("s1"), false, "session retired on close")
  // Internal signal — never goes on the wire.
  assert.equal(
    forwarded.some((m) => m.type === "session_closed"),
    false
  )
})

test("single-turn (Anthropic) session is retired on session_ended", () => {
  const { forwarded, sessions, wrapped } = setup("a1", {}) // no multiTurn flag

  wrapped({ type: "session_ended", sessionId: "a1" })
  assert.equal(sessions.has("a1"), false, "Anthropic session cleaned up per turn")
  assert.equal(forwarded.filter((m) => m.type === "session_ended").length, 1)
})

test("events for a different session id never touch this session", () => {
  const { sessions, wrapped } = setup("s1", { multiTurn: true })

  wrapped({ type: "session_ended", sessionId: "other" })
  assert.ok(sessions.has("s1"), "foreign session_ended is ignored")
  wrapped({ type: "session_closed", sessionId: "other" })
  assert.ok(sessions.has("s1"), "foreign session_closed is ignored")
})

test("non-lifecycle events are forwarded untouched", () => {
  const { forwarded, sessions, wrapped } = setup("s1", { multiTurn: true })

  const evt = { type: "event", sessionId: "s1", event: { type: "assistant" } }
  wrapped(evt)
  assert.deepEqual(forwarded.at(-1), evt)
  assert.ok(sessions.has("s1"))
})

// ── Restore (undo compaction) routing ────────────────────────────────────────
test("routeRestore forwards the snapshot to the session's restoreConversation", () => {
  let received = null
  const sessions = new Map([["s1", { restoreConversation: (m) => ((received = m), true) }]])
  const snapshot = [{ role: "user", content: "m0" }]
  const ok = routeRestore(sessions, { sessionId: "s1", messages: snapshot })
  assert.equal(ok, true)
  assert.deepEqual(received, snapshot)
})

test("routeRestore is a safe no-op for unknown / non-restorable sessions", () => {
  const logs = []
  const log = (lvl, m) => logs.push([lvl, m])
  // Unknown session.
  assert.equal(routeRestore(new Map(), { sessionId: "x", messages: [] }, log), false)
  assert.ok(logs.some(([lvl]) => lvl === "warn"))
  // Anthropic-style session without restoreConversation.
  const sessions = new Map([["a1", { multiTurn: false }]])
  assert.equal(routeRestore(sessions, { sessionId: "a1", messages: [] }, log), false)
})

test("routeRestore reports false when the session declines the restore", () => {
  const sessions = new Map([["s1", { restoreConversation: () => false }]])
  assert.equal(routeRestore(sessions, { sessionId: "s1", messages: [] }), false)
})

// ── Identity guard: a superseded old loop must not evict its replacement ──────
// After a close-and-restart the OLD session's loop can emit a late
// `session_ended` / `session_closed` for the same id. With `getOwner` wired,
// the wrapped emitter retires the entry only when the map still points at the
// session it belongs to — so the freshly-registered replacement survives.

test("a superseded session's late session_closed does NOT evict the replacement", () => {
  const sessions = new Map()
  const oldSession = { multiTurn: true }
  const newSession = { multiTurn: true }
  // The OLD loop's emitter still closes over the OLD owner.
  const oldEmit = makeWrappedEmit(
    () => {},
    sessions,
    "s1",
    () => oldSession
  )
  // Restart happened: the map now holds the NEW session.
  sessions.set("s1", newSession)

  oldEmit({ type: "session_closed", sessionId: "s1" })
  assert.equal(sessions.get("s1"), newSession, "replacement is preserved")
})

test("a superseded single-turn session's late session_ended does NOT evict the replacement", () => {
  const sessions = new Map()
  const oldSession = {} // single-turn (Anthropic)
  const newSession = {}
  const oldEmit = makeWrappedEmit(
    () => {},
    sessions,
    "a1",
    () => oldSession
  )
  sessions.set("a1", newSession)

  oldEmit({ type: "session_ended", sessionId: "a1" })
  assert.equal(sessions.get("a1"), newSession, "replacement is preserved")
})

test("the owning session still retires itself on its own lifecycle event", () => {
  const sessions = new Map()
  const self = {} // single-turn
  sessions.set("a1", self)
  const emit = makeWrappedEmit(
    () => {},
    sessions,
    "a1",
    () => self
  )

  emit({ type: "session_ended", sessionId: "a1" })
  assert.equal(sessions.has("a1"), false, "owner retires on session_ended")
})

// ── restartReason: the send-time close-and-restart decision (both paths) ──────

test("restartReason: cwd change forces a restart", () => {
  const existing = { multiTurn: true, q: { active: false }, sendOptions: { cwd: "/old" } }
  assert.equal(restartReason(existing, { cwd: "/new" }), "cwd changed")
  assert.equal(restartReason(existing, { cwd: "/old" }), null, "same cwd keeps the session")
})

test("restartReason: an in-flight ai-sdk (multiTurn) turn forces a restart", () => {
  const busy = { multiTurn: true, q: { active: true }, sendOptions: { cwd: "/x" } }
  assert.equal(restartReason(busy, { cwd: "/x" }), "turn still active")
})

test("restartReason: an idle ai-sdk (multiTurn) session is kept (pushUserMessage)", () => {
  const idle = { multiTurn: true, q: { active: false }, sendOptions: { cwd: "/x" } }
  assert.equal(restartReason(idle, { cwd: "/x" }), null)
})

test("restartReason: a lingering single-turn (Anthropic) session is always restarted", () => {
  // Anthropic exposes no `q.active`; its mere presence in the map means the
  // previous turn never ended — restart so the recovery prompt doesn't hang.
  const stuck = { q: {}, sendOptions: { cwd: "/x" } } // no multiTurn flag
  assert.equal(restartReason(stuck, { cwd: "/x" }), "stale single-turn session")
  assert.equal(restartReason(stuck, undefined), "stale single-turn session")
})

test("restartReason: a provider change forces a respawn onto the new dispatch path", () => {
  // ai-sdk (openai) → anthropic: the live `q` can't serve the new provider, so
  // pushing the prompt into it would run on the wrong runner. Restart instead.
  const onOpenai = {
    multiTurn: true,
    q: { active: false },
    sendOptions: { cwd: "/x", provider: "openai" },
  }
  assert.equal(restartReason(onOpenai, { cwd: "/x", provider: "anthropic" }), "provider changed")
  // anthropic → openai (single-turn live session lingering): provider change is
  // checked before the stale-single-turn fallback, so the reason is the change.
  const onAnthropic = { q: {}, sendOptions: { cwd: "/x", provider: "anthropic" } }
  assert.equal(restartReason(onAnthropic, { cwd: "/x", provider: "openai" }), "provider changed")
})

test("restartReason: a same-provider model change is NOT a restart (handled live via setModel)", () => {
  const idle = {
    multiTurn: true,
    q: { active: false },
    sendOptions: { cwd: "/x", provider: "openai" },
  }
  // Same provider — the model swap rides the live `setModel`, conversation kept.
  assert.equal(restartReason(idle, { cwd: "/x", provider: "openai" }), null)
})

test("restartReason: the implicit anthropic default never reads as a provider change", () => {
  // Both sides default to anthropic when unspecified — must not respawn.
  const implicit = { multiTurn: false, q: {}, sendOptions: { cwd: "/x" } }
  // No provider on either side → falls through to the single-turn fallback,
  // NOT "provider changed".
  assert.equal(restartReason(implicit, { cwd: "/x" }), "stale single-turn session")
  // Explicit anthropic on one side, implicit on the other → still equal.
  const explicit = { multiTurn: true, q: { active: false }, sendOptions: { cwd: "/x" } }
  assert.equal(restartReason(explicit, { cwd: "/x", provider: "anthropic" }), null)
})

// ---- buildPermissionResult ------------------------------------------------
// Regression: the renderer's `permission_response` carries no `updatedInput`
// when the user approves a call unmodified. Resolving the Agent-SDK
// `canUseTool` promise with `{ behavior: "allow", updatedInput: undefined }`
// fails the SDK subprocess's zod schema (it requires a record), surfacing as
// `Tool permission request failed: ZodError`. The allow result must fall back
// to the ORIGINAL tool input so `updatedInput` is always a record.

import { buildPermissionResult } from "./claude-host.mjs"

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
