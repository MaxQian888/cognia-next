import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

import {
  canonicalEventFromWireMessage,
  canonicalEventsFromWireMessage,
  createEnvelopeEmitter,
} from "./event-envelope.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(join(here, "agent-event-envelope.fixture.json"), "utf8"))

function collectEmitter(extra = {}) {
  const out = []
  const emitter = createEnvelopeEmitter({
    sessionId: fixture.context.sessionId,
    runId: fixture.context.runId,
    attemptId: fixture.context.attemptId,
    hostRef: fixture.context.hostRef,
    runtime: fixture.context.runtime,
    turnRef: { id: fixture.context.turnId },
    emit: (msg) => out.push(msg),
    ...extra,
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

test("sequence is monotonic per emitter and ids embed session+turn+attempt", () => {
  const { out, emitter } = collectEmitter()
  for (const c of fixture.cases) emitter(c.wire)
  const seqs = out.filter((m) => m.type === "agent_event").map((m) => m.envelope.sequence)
  assert.deepEqual(seqs, [0, 1, 2])
  for (const m of out.filter((m) => m.type === "agent_event")) {
    assert.equal(m.envelope.eventId, `s1:t1:a1:${m.envelope.sequence}`)
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

test("a raw SDK message is projected semantically, not swallowed as a diagnostic", () => {
  // Before the exhaustive mapping every `type: "event"` except compact_boundary
  // became `{ kind: "diagnostic" }`, which is how 30 of the 39 union members
  // reached consumers as opaque blobs.
  const events = canonicalEventsFromWireMessage({
    type: "event",
    sessionId: "s1",
    event: {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
      },
    },
  })
  assert.deepEqual(events, [
    { kind: "tool-call", toolName: "Bash", input: { command: "ls" }, toolCallId: "t1" },
  ])
})

test("one SDK message can produce several envelopes, each with its own sequence", () => {
  const { out, emitter } = collectEmitter()
  emitter({
    type: "event",
    sessionId: "s1",
    event: {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "checking" },
          { type: "tool_use", id: "t1", name: "Bash", input: {} },
        ],
      },
    },
  })

  const envelopes = out.filter((m) => m.type === "agent_event").map((m) => m.envelope)
  assert.deepEqual(
    envelopes.map((e) => e.event.kind),
    ["text-delta", "tool-call"]
  )
  assert.deepEqual(
    envelopes.map((e) => e.sequence),
    [0, 1]
  )
})

test("the partial-stream latch is per emitter, so attempts do not leak into each other", () => {
  const assistant = {
    type: "event",
    sessionId: "s1",
    event: { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
  }
  const streamed = {
    type: "event",
    sessionId: "s1",
    event: {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "h" } },
    },
  }

  const first = collectEmitter()
  first.emitter(streamed)
  first.emitter(assistant)
  assert.deepEqual(
    first.out.filter((m) => m.type === "agent_event").map((m) => m.envelope.event.kind),
    ["text-delta"],
    "the assistant echo must not duplicate the streamed text"
  )

  // A fresh emitter (a new attempt) starts unlatched.
  const second = collectEmitter()
  second.emitter(assistant)
  assert.deepEqual(
    second.out.filter((m) => m.type === "agent_event").map((m) => m.envelope.event.kind),
    ["text-delta"]
  )
})

test("the structured-output expectation reaches the mapper, per emitter", () => {
  const result = {
    type: "event",
    sessionId: "s1",
    event: { type: "result", subtype: "success", is_error: false, result: "prose" },
  }

  const expecting = collectEmitter({ expectStructuredOutput: true })
  expecting.emitter(result)
  assert.deepEqual(
    expecting.out.filter((m) => m.type === "agent_event").map((m) => m.envelope.event.kind),
    ["structured-output", "failure"],
    "a schema was requested and none came back"
  )

  // The default must stay OFF: a session that never asked for a schema would
  // otherwise have every successful turn rewritten into a failure.
  const plain = collectEmitter()
  plain.emitter(result)
  assert.deepEqual(
    plain.out.filter((m) => m.type === "agent_event").map((m) => m.envelope.event.kind),
    ["lifecycle"]
  )
})
