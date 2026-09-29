import type { SendOptions } from "../../shared/wire/inbound.ts"
import type { HostSession } from "./types.ts"
import test from "node:test"
import assert from "node:assert/strict"
import {
  makeWrappedEmit,
  envelopeEmitterParams,
  restartReason,
  routeSendIntoLiveLoop,
  routeRestore,
  routeClose,
} from "./lifecycle.ts"

// ---- envelope emitter configuration ------------------------------------------

const emitterFor = (sendOptions?: SendOptions) =>
  envelopeEmitterParams({
    sessionId: "s1",
    sendOptions,
    turnRef: { id: "t1" },
    emit: () => {},
  })

test("a session without a frozen spec gets no envelope emitter at all", () => {
  // ADR-0090: envelope emission is additive and only for spec-carrying
  // sessions. Returning params here would put the legacy queue on a second
  // channel it never asked for.
  assert.equal(emitterFor({}), null)
  assert.equal(emitterFor(undefined), null)
})

test("emitter identity falls back to the session id rather than inventing one", () => {
  const params = emitterFor({ execution: { runtimeAdapter: "claude-agent-sdk" } })
  assert.equal(params!.runId, "s1")
  assert.equal(params!.attemptId, "a1")
  assert.equal(params!.hostRef, "desktop-sidecar")
  assert.equal(params!.parentRunId, undefined)
})

test("explicit execution identity wins over every fallback", () => {
  const params = emitterFor({
    execution: {
      runtimeAdapter: "claude-agent-sdk",
      hostRef: "companion",
      identity: { runId: "r9", attemptId: "a3", parentRunId: "r1" },
    },
  })
  assert.deepEqual(
    { runId: params!.runId, attemptId: params!.attemptId, parentRunId: params!.parentRunId },
    { runId: "r9", attemptId: "a3", parentRunId: "r1" }
  )
  assert.equal(params!.hostRef, "companion")
})

test("the structured-output expectation is derived from the send, not defaulted on", () => {
  // If this ever silently returns true, every ordinary turn of a spec-carrying
  // session settles as `structured_output_missing`.
  assert.equal(emitterFor({ execution: { runtimeAdapter: "x" } })!.expectStructuredOutput, false)
  assert.equal(
    emitterFor({
      execution: { runtimeAdapter: "x" },
      claudeAgentSdk: { version: 1, outputFormat: { type: "json_schema", schema: {} } },
    })!.expectStructuredOutput,
    true
  )
})

function setup(sessionId: string, session?: HostSession) {
  const forwarded: { type: string; turnId?: string; [key: string]: unknown }[] = []
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

// ---- turnId stamping -------------------------------------------------------
// The parent can only tell one turn's events from a previous turn's if the
// sidecar says which turn emitted them: a timed-out turn's interrupt produces a
// late `session_ended` that the NEXT turn (same session id) would otherwise
// consume and report as "ended with no assistant text".

test("stamps the current turn id onto forwarded session events", () => {
  const forwarded: { type: string; turnId?: string; [key: string]: unknown }[] = []
  const sessions = new Map([["s1", { multiTurn: true }]])
  const turnRef = { id: "turn-1" }
  const wrapped = makeWrappedEmit((m) => forwarded.push(m), sessions, "s1", undefined, turnRef)

  wrapped({ type: "event", sessionId: "s1", event: { type: "assistant" } })
  wrapped({ type: "session_ended", sessionId: "s1" })
  assert.deepEqual(
    forwarded.map((m) => m.turnId),
    ["turn-1", "turn-1"]
  )

  // A later turn on the SAME live loop advances the ref (what `handleSend` does
  // when it pushes into an existing session).
  turnRef.id = "turn-2"
  wrapped({ type: "session_ended", sessionId: "s1" })
  assert.equal(forwarded.at(-1)!.turnId, "turn-2")
})

test("a superseded loop keeps stamping its OWN turn id and cannot evict the replacement", () => {
  // The exact shape of the incident: turn 1's loop is replaced (close+restart,
  // or retired by its own session_ended) while its interrupt is still in
  // flight. Its late event must carry turn 1's id — stamping it with the live
  // turn's id would put us right back to the parent eating it.
  const forwarded: { type: string; turnId?: string; [key: string]: unknown }[] = []
  const sessions = new Map()

  const oldSession = { multiTurn: false }
  const oldTurnRef = { id: "turn-1" }
  sessions.set("s1", oldSession)
  const oldEmit = makeWrappedEmit(
    (m) => forwarded.push(m),
    sessions,
    "s1",
    () => oldSession,
    oldTurnRef
  )

  // Turn 2 restarts the session: a NEW loop with its own ref takes the map slot.
  const newSession = { multiTurn: false }
  sessions.set("s1", newSession)

  // Now turn 1's interrupt finally lands.
  oldEmit({ type: "session_ended", sessionId: "s1" })

  assert.equal(forwarded.at(-1)!.turnId, "turn-1", "late event carries the OLD turn id")
  assert.equal(sessions.get("s1"), newSession, "the replacement survives the old loop's end")
})

test("leaves events unstamped when the send carried no turn id", () => {
  const forwarded: { type: string; turnId?: string; [key: string]: unknown }[] = []
  const sessions = new Map([["s1", { multiTurn: true }]])
  // `startSession` builds the ref from `sendOptions.turnId`, so an older parent
  // that doesn't send one yields `{ id: undefined }`.
  const wrapped = makeWrappedEmit((m) => forwarded.push(m), sessions, "s1", undefined, {
    id: undefined,
  })

  wrapped({ type: "session_ended", sessionId: "s1" })
  assert.equal("turnId" in forwarded.at(-1)!, false, "no turnId key rather than an undefined one")
})

// ── Restore (undo compaction) routing ────────────────────────────────────────
test("routeRestore forwards the snapshot to the session's restoreConversation", () => {
  let received = null
  const sessions = new Map([
    ["s1", { restoreConversation: (m: unknown) => ((received = m), true) }],
  ])
  const snapshot = [{ role: "user", content: "m0" }]
  const ok = routeRestore(sessions, { sessionId: "s1", messages: snapshot })
  assert.equal(ok, true)
  assert.deepEqual(received, snapshot)
})

test("routeRestore is a safe no-op for unknown / non-restorable sessions", () => {
  const logs: string[][] = []
  const log = (lvl: "info" | "warn" | "error", m: string) => logs.push([lvl, m])
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

// ── Close routing ───────────────────────────────────────────────────────────
test("routeClose closes an ai-sdk session without requiring q.close", () => {
  const calls: unknown[] = []
  const logs: string[][] = []
  const session = {
    multiTurn: true,
    closeInput: () => calls.push("closeInput"),
    drainPending: (reason: string) => calls.push(["drainPending", reason]),
    q: { active: false },
  }
  const sessions = new Map([["s1", session]])

  assert.equal(
    routeClose(sessions, { sessionId: "s1" }, (level, message) => logs.push([level, message])),
    true
  )
  assert.deepEqual(calls, ["closeInput", ["drainPending", "session closed"]])
  assert.deepEqual(logs, [])
  assert.equal(sessions.has("s1"), false)
})

test("routeClose calls q.close when the dispatch path provides it", () => {
  const calls: unknown[] = []
  const session = {
    closeInput: () => calls.push("closeInput"),
    q: { close: () => calls.push("q.close") },
  }
  const sessions = new Map([["a1", session]])

  assert.equal(routeClose(sessions, { sessionId: "a1" }), true)
  assert.deepEqual(calls, ["closeInput", "q.close"])
  assert.equal(sessions.has("a1"), false)
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

test("a live loop is handed this send's turn id and ledger stamp before the prompt", () => {
  const order: unknown[] = []
  const loop = {
    turnRef: { id: "turn-1" },
    setNextTurnLedger: (ledger: unknown, remoteExecutionContext?: unknown) =>
      order.push(["ledger", ledger, remoteExecutionContext]),
    pushUserMessage: (prompt: unknown) => order.push(["prompt", prompt]),
  }
  const ledger = { runId: "run-2", mode: "per_call" }
  const remoteExecutionContext = { originDeviceId: "device-a", sessionId: "s", generation: 2 }
  routeSendIntoLiveLoop(loop, { turnId: "turn-2", ledger, remoteExecutionContext }, "again")
  assert.equal(loop.turnRef.id, "turn-2")
  assert.deepEqual(order, [
    ["ledger", ledger, remoteExecutionContext],
    ["prompt", "again"],
  ])

  // A switched-off surface sends no stamp, and the loop must be told so rather
  // than keeping the previous turn's run. A host-started send carries no
  // device context, and the loop must not keep the previous device's either.
  order.length = 0
  routeSendIntoLiveLoop(loop, { turnId: "turn-3" }, "third")
  assert.deepEqual(order, [
    ["ledger", undefined, undefined],
    ["prompt", "third"],
  ])
})

test("a loop with no ledger seam still takes the prompt", () => {
  const pushed: unknown[] = []
  // No turnRef either: a dispatcher that predates both seams.
  routeSendIntoLiveLoop({ pushUserMessage: (p) => pushed.push(p) }, undefined, "hi")
  assert.deepEqual(pushed, ["hi"])
})
