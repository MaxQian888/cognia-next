import assert from "node:assert/strict"
import test from "node:test"

import { createBootstrapTracker } from "./bootstrap-state.mjs"

test("App-originated nonce binds the canonical thread and turn", () => {
  const tracker = createBootstrapTracker()
  tracker.begin({
    nonce: "session-123",
    expectedAnswer: "BROWSER_OK:VISIBLE-123",
    browserUrl: "http://127.0.0.1:4319/browser-target",
  })

  tracker.observeApp({
    id: 41,
    method: "turn/start",
    params: {
      threadId: "thread-app-owned",
      input: [{ type: "text", text: "Read the open Browser.\n\n[COGNIA_BOOTSTRAP:session-123]" }],
    },
  })
  assert.deepEqual(tracker.latest(), {
    ...tracker.latest(),
    status: "bound",
    threadId: "thread-app-owned",
  })

  tracker.observeServer({ id: 41, result: { turn: { id: "turn-app-owned" } } })
  assert.equal(tracker.latest().turnId, "turn-app-owned")
  assert.equal(tracker.latest().status, "running")
})

test("Browser bootstrap passes only on the exact final answer", () => {
  const tracker = createBootstrapTracker()
  tracker.begin({
    nonce: "session-456",
    expectedAnswer: "BROWSER_OK:VISIBLE-456",
    browserUrl: "http://127.0.0.1:4319/browser-target",
  })
  tracker.observeApp({
    id: "app-turn-1",
    method: "turn/start",
    params: {
      threadId: "thread-1",
      input: [{ type: "text", text: "[COGNIA_BOOTSTRAP:session-456]" }],
    },
  })
  tracker.observeServer({ id: "app-turn-1", result: { turn: { id: "turn-1" } } })
  tracker.observeServer({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "agentMessage",
        phase: "final_answer",
        text: "Browser unavailable; expected BROWSER_OK:VISIBLE-456",
      },
    },
  })
  tracker.observeServer({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
  })

  assert.equal(tracker.latest().status, "failed")
  assert.equal(tracker.latest().browserVerified, false)
})

test("Browser bootstrap records a verified App-owned completion", () => {
  const tracker = createBootstrapTracker()
  tracker.begin({
    nonce: "session-789",
    expectedAnswer: "BROWSER_OK:VISIBLE-789",
    browserUrl: "http://127.0.0.1:4319/browser-target",
  })
  tracker.observeApp({
    id: 9,
    method: "turn/start",
    params: {
      threadId: "thread-verified",
      input: [{ type: "text", text: "[COGNIA_BOOTSTRAP:session-789]" }],
    },
  })
  tracker.observeServer({ id: 9, result: { turn: { id: "turn-verified" } } })
  tracker.observeServer({
    method: "item/completed",
    params: {
      threadId: "thread-verified",
      turnId: "turn-verified",
      item: {
        type: "agentMessage",
        phase: "final_answer",
        text: "BROWSER_OK:VISIBLE-789",
      },
    },
  })
  tracker.observeServer({
    method: "turn/completed",
    params: {
      threadId: "thread-verified",
      turn: { id: "turn-verified", status: "completed" },
    },
  })

  assert.equal(tracker.latest().status, "passed")
  assert.equal(tracker.latest().browserVerified, true)
})

test("a completed non-verification bootstrap does not block the next task", () => {
  const tracker = createBootstrapTracker()
  tracker.begin({ nonce: "first", expectedAnswer: null, browserUrl: "https://example.com/" })
  tracker.observeApp({
    id: 1,
    method: "turn/start",
    params: {
      threadId: "thread-first",
      input: [{ type: "text", text: "hello [COGNIA_BOOTSTRAP:first]" }],
    },
  })
  tracker.observeServer({ id: 1, result: { turn: { id: "turn-first" } } })
  tracker.observeServer({
    method: "turn/completed",
    params: { threadId: "thread-first", turnId: "turn-first" },
  })

  const next = tracker.begin({
    nonce: "second",
    expectedAnswer: null,
    browserUrl: "https://example.com/next",
  })

  assert.equal(next.status, "opening")
})

test("a late CDP submission result cannot downgrade a bound task", () => {
  const tracker = createBootstrapTracker()
  tracker.begin({ nonce: "race", expectedAnswer: null, browserUrl: "https://example.com/" })
  tracker.observeApp({
    id: 2,
    method: "turn/start",
    params: {
      threadId: "thread-race",
      input: [{ type: "text", text: "hello [COGNIA_BOOTSTRAP:race]" }],
    },
  })

  tracker.markUiSubmitted("race", {
    deepLink: "codex://new",
    rendererId: "renderer-1",
    submission: { submitted: true },
  })

  assert.equal(tracker.latest().status, "bound")
  assert.equal(tracker.latest().submission.submitted, true)
})

test("a later title-generation turn cannot replace the canonical task binding", () => {
  const tracker = createBootstrapTracker()
  tracker.begin({ nonce: "title-race", expectedAnswer: null, browserUrl: "https://example.com/" })
  tracker.observeApp({
    id: "real-turn",
    method: "turn/start",
    params: {
      threadId: "thread-durable",
      input: [{ type: "text", text: "hello [COGNIA_BOOTSTRAP:title-race]" }],
    },
  })
  tracker.observeApp({
    id: "title-turn",
    method: "turn/start",
    params: {
      threadId: "thread-ephemeral-title",
      input: [{ type: "text", text: "make a title [COGNIA_BOOTSTRAP:title-race]" }],
    },
  })

  assert.equal(tracker.latest().threadId, "thread-durable")
})
