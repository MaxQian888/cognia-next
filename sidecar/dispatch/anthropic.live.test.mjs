// Live round-trip test for the Anthropic dispatch path.
//
// Boots the REAL sidecar + real `@anthropic-ai/claude-agent-sdk` `query()` (and
// the claude-code CLI subprocess) against an in-process mock Anthropic Messages
// API. This is the only automated test that exercises the genuine
// send → dispatch → query → SSE → stdout-framing pipeline; the Jest
// `chat-main-flow.integration.test.tsx` hand-fakes the SDK event shapes, so it
// cannot catch drift between what the real SDK emits and what the renderer
// adapter expects. This test catches exactly that.

import { test } from "node:test"
import assert from "node:assert/strict"
import { startMockAnthropic, spawnSidecar, assistantText } from "./live-harness.mjs"

test("anthropic dispatch streams a real assistant reply + success result", async () => {
  const mock = startMockAnthropic({ chunks: ["PONG"] })
  await mock.listen()
  const sidecar = spawnSidecar({ baseUrl: mock.baseUrl })

  try {
    await sidecar.waitFor((m) => m.type === "ready", { timeoutMs: 15_000, label: "ready" })

    sidecar.send({ type: "send", sessionId: "live-1", prompt: "Reply with the single word PONG." })

    const assistant = await sidecar.waitFor(
      (m) => m.type === "event" && m.event?.type === "assistant",
      { label: "assistant" }
    )
    const result = await sidecar.waitFor((m) => m.type === "event" && m.event?.type === "result", {
      label: "result",
    })

    // Real SDK shape: assistant message carries content blocks the renderer
    // adapter folds into bubbles. Assert the text round-tripped from the mock.
    assert.match(assistantText(assistant), /PONG/, "assistant text should contain the mock reply")

    // Real terminal frame the adapter keys "session settled" off of.
    assert.equal(result.event.subtype, "success")
    assert.equal(result.event.is_error, false)

    // Proves the turn hit the mock — NOT api.anthropic.com — so the test is
    // hermetic and the base-URL enabler actually reaches the SDK.
    assert.ok(mock.messagesCalls.length >= 1, "mock /v1/messages was called at least once")
    // The user's prompt must be present in the request the SDK sent upstream.
    const lastReq = mock.messagesCalls[mock.messagesCalls.length - 1]
    const flat = JSON.stringify(lastReq?.messages ?? [])
    assert.match(flat, /PONG/, "request to upstream should carry the user prompt")
  } finally {
    await sidecar.close()
    await mock.close()
  }
})

test("anthropic dispatch reports a session id for the turn", async () => {
  const mock = startMockAnthropic({ chunks: ["ok"] })
  await mock.listen()
  const sidecar = spawnSidecar({ baseUrl: mock.baseUrl })

  try {
    await sidecar.waitFor((m) => m.type === "ready", { timeoutMs: 15_000, label: "ready" })
    sidecar.send({ type: "send", sessionId: "live-2", prompt: "hello" })
    // The renderer captures this to thread `resume` into the next turn — its
    // absence breaks multi-turn continuity.
    const sid = await sidecar.waitFor((m) => m.type === "sdk_session_id", {
      label: "sdk_session_id",
    })
    assert.equal(sid.sessionId, "live-2")
    // `sdkSessionId` is what the renderer threads back as `resume` next turn.
    assert.equal(typeof sid.sdkSessionId, "string")
    assert.ok(sid.sdkSessionId.length > 0)
    await sidecar.waitFor((m) => m.type === "event" && m.event?.type === "result", {
      label: "result",
    })
  } finally {
    await sidecar.close()
    await mock.close()
  }
})

test("anthropic dispatch accepts a correlated live steer into the same query", async () => {
  const mock = startMockAnthropic({
    delayMs: 150,
    replyFor: (body) =>
      JSON.stringify(body.messages ?? []).includes("change direction") ? ["STEERED"] : ["FIRST"],
  })
  await mock.listen()
  const sidecar = spawnSidecar({ baseUrl: mock.baseUrl })

  try {
    await sidecar.waitFor((m) => m.type === "ready", { timeoutMs: 15_000, label: "ready" })
    sidecar.send({ type: "send", sessionId: "live-steer", prompt: "start the task" })
    await sidecar.waitFor((m) => m.type === "sdk_session_id", { label: "sdk_session_id" })

    sidecar.send({
      type: "control",
      sessionId: "live-steer",
      requestId: "steer-request-1",
      method: "steer",
      params: { prompt: "change direction", priority: "now" },
    })
    const acknowledged = await sidecar.waitFor(
      (m) => m.type === "control_response" && m.requestId === "steer-request-1",
      { label: "steer_response" }
    )
    assert.equal(acknowledged.ok, true)
    assert.equal(acknowledged.result?.accepted, true)

    await sidecar.waitFor((m) => m.type === "session_ended", {
      timeoutMs: 30_000,
      label: "session_ended",
    })
    assert.ok(
      mock.messagesCalls.some((body) =>
        JSON.stringify(body.messages ?? []).includes("change direction")
      ),
      "the accepted steer must reach the live SDK query"
    )
  } finally {
    await sidecar.close()
    await mock.close()
  }
})
