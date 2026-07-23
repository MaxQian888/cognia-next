import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

import { canonicalEventFromWireMessage, createEnvelopeEmitter } from "./event-envelope.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(join(here, "agent-event-envelope.fixture.json"), "utf8"))

function collectEmitter() {
  const out = []
  const emitter = createEnvelopeEmitter({
    sessionId: fixture.context.sessionId,
    runId: fixture.context.runId,
    attemptId: fixture.context.attemptId,
    hostRef: fixture.context.hostRef,
    runtime: fixture.context.runtime,
    turnRef: { id: fixture.context.turnId },
    emit: (msg) => out.push(msg),
  })
  return { out, emitter }
}

test("fixture parity: wire messages produce the pinned envelopes (TS mirrors this)", () => {
  const { out, emitter } = collectEmitter()
  for (const c of fixture.cases) emitter(c.wire)

  const envelopes = out.filter((m) => m.type === "agent_event").map((m) => m.envelope)
  assert.equal(envelopes.length, fixture.cases.length)
  for (let i = 0; i < fixture.cases.length; i += 1) {
    const { timestamp, ...rest } = envelopes[i]
    assert.match(timestamp, /^\d{4}-\d{2}-\d{2}T/)
    assert.deepEqual(rest, fixture.cases[i].envelope)
  }
})

test("raw legacy messages keep flowing unchanged, in order, before their envelope", () => {
  const { out, emitter } = collectEmitter()
  emitter(fixture.cases[0].wire)
  assert.deepEqual(out[0], fixture.cases[0].wire)
  assert.equal(out[1].type, "agent_event")
})

test("sequence is monotonic per emitter and ids embed session+attempt", () => {
  const { out, emitter } = collectEmitter()
  for (const c of fixture.cases) emitter(c.wire)
  const seqs = out.filter((m) => m.type === "agent_event").map((m) => m.envelope.sequence)
  assert.deepEqual(seqs, [0, 1, 2])
  for (const m of out.filter((m) => m.type === "agent_event")) {
    assert.equal(m.envelope.eventId, `s1:a1:${m.envelope.sequence}`)
  }
})

test("messages without a canonical projection are not enveloped", () => {
  const { out, emitter } = collectEmitter()
  emitter({ type: "plugin_tool_exec", sessionId: "s1", toolUseId: "t", name: "x", args: {} })
  emitter({ type: "log", level: "info", message: "hi" })
  assert.equal(out.filter((m) => m.type === "agent_event").length, 0)
  assert.equal(out.length, 2)
})

test("canonicalEventFromWireMessage maps the remaining kinds", () => {
  assert.deepEqual(canonicalEventFromWireMessage({ type: "session_ended", sessionId: "s1" }), {
    kind: "lifecycle",
    phase: "ended",
  })
  assert.deepEqual(
    canonicalEventFromWireMessage({
      type: "capability_error",
      sessionId: "s1",
      capability: "steer",
      command: "steer",
    }),
    { kind: "capability-error", capability: "steer", command: "steer" }
  )
  assert.equal(canonicalEventFromWireMessage(null), null)
  assert.equal(canonicalEventFromWireMessage({ type: "ready" }), null)
  const diag = canonicalEventFromWireMessage({
    type: "event",
    sessionId: "s1",
    event: { type: "assistant", message: {} },
  })
  assert.equal(diag.kind, "diagnostic")
  const interrupted = canonicalEventFromWireMessage({
    type: "permission_interrupted",
    sessionId: "s1",
    requestId: "r",
    reason: "closed",
  })
  assert.deepEqual(interrupted, {
    kind: "warning",
    code: "permission_interrupted",
    message: "closed",
  })
})
