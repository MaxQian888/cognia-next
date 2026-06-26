// Live sequential-turns test for the Anthropic dispatch path.
//
// The default chat path is single-turn-per-`query()`: each turn's session is
// retired on `session_ended` (the SDK rebuilds context via `resume`). This test
// drives two turns on one logical session through the REAL sidecar and asserts
// the SECOND turn completes — a fresh upstream request and its own success
// result — without stalling.
//
// Why this matters: `handleSend` + `restartReason` decide, for a `send` on an
// already-known session, whether to push into the live session or tear down and
// restart. A regression there (e.g. pushing a prompt into a session the SDK
// already abandoned) makes turn 2 hang forever — invisible to the pure unit
// tests of `restartReason`, which never cross a real turn boundary.
//
// NOTE on context retention: against a MOCK upstream the claude-code CLI's
// `resume` does not replay prior transcript into the request `messages[]`
// (that round-trips through the real backend's session store), so this test
// deliberately does NOT assert "turn 1 content appears in turn 2" — that would
// be asserting mock behaviour, not product behaviour.

import { test } from "node:test"
import assert from "node:assert/strict"
import { startMockAnthropic, spawnSidecar, assistantText } from "./live-harness.mjs"

test("anthropic dispatch handles two sequential turns on one session without stalling", async () => {
  // Echo a distinct reply per call so each turn's assistant frame is identifiable.
  const mock = startMockAnthropic({
    replyFor: (_body, callIndex) => [callIndex === 0 ? "first-reply" : "second-reply"],
  })
  await mock.listen()
  const sidecar = spawnSidecar({ baseUrl: mock.baseUrl })

  try {
    await sidecar.waitFor((m) => m.type === "ready", { timeoutMs: 15_000, label: "ready" })

    // ── Turn 1 ──────────────────────────────────────────────────────────────
    sidecar.send({ type: "send", sessionId: "mt-1", prompt: "First question." })
    const sid = await sidecar.waitFor((m) => m.type === "sdk_session_id", {
      label: "sdk_session_id",
    })
    const assistant1 = await sidecar.waitFor(
      (m) => m.type === "event" && m.event?.type === "assistant",
      { label: "assistant#1" }
    )
    assert.match(assistantText(assistant1), /first-reply/)
    const result1 = await sidecar.waitFor((m) => m.type === "event" && m.event?.type === "result", {
      label: "result#1",
    })
    assert.equal(result1.event.subtype, "success")
    const callsAfterTurn1 = mock.messagesCalls.length
    assert.ok(callsAfterTurn1 >= 1, "turn 1 hit the mock")

    // ── Turn 2 (same session, threading `resume` exactly like the renderer) ──
    // Cursor so the turn-2 waits don't re-match turn 1's frames.
    const since = sidecar.mark()
    sidecar.send({
      type: "send",
      sessionId: "mt-1",
      prompt: "Second question.",
      options: { resume: sid.sdkSessionId },
    })
    const assistant2 = await sidecar.waitFor(
      (m) => m.type === "event" && m.event?.type === "assistant",
      { label: "assistant#2", sinceIndex: since }
    )
    const result2 = await sidecar.waitFor((m) => m.type === "event" && m.event?.type === "result", {
      label: "result#2",
      sinceIndex: since,
    })

    // Turn 2 genuinely ran: a NEW upstream request + its own assistant + result.
    assert.match(assistantText(assistant2), /second-reply/)
    assert.equal(result2.event.subtype, "success")
    assert.equal(result2.event.is_error, false)
    assert.ok(
      mock.messagesCalls.length > callsAfterTurn1,
      "turn 2 must make its own upstream request (didn't stall or short-circuit)"
    )
  } finally {
    await sidecar.close()
    await mock.close()
  }
})
