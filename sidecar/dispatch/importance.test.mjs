import { test } from "node:test"
import assert from "node:assert/strict"

import { scoreMessage, messageText } from "./importance.mjs"

test("messageText flattens string and block content", () => {
  assert.equal(messageText({ content: "hi" }), "hi")
  assert.equal(messageText({ content: [{ type: "text", text: "a" }, "b"] }), "ab")
  assert.equal(messageText({ content: null }), "")
})

test("system messages score maximally", () => {
  const { score, signals } = scoreMessage(
    { role: "system", content: "rules" },
    { index: 0, total: 10 }
  )
  assert.equal(score, 1)
  assert.ok(signals.includes("system"))
})

test("each content signal is detected", () => {
  assert.ok(scoreMessage({ role: "user", content: "```js\nx\n```" }).signals.includes("code"))
  assert.ok(
    scoreMessage({ role: "user", content: "this failed with an exception" }).signals.includes(
      "error"
    )
  )
  assert.ok(
    scoreMessage({ role: "user", content: "we decided to use Postgres" }).signals.includes(
      "decision"
    )
  )
  assert.ok(scoreMessage({ role: "user", content: "what now?" }).signals.includes("question"))
  assert.ok(
    scoreMessage({ role: "user", content: "see https://example.com/x" }).signals.includes("url")
  )
  assert.ok(
    scoreMessage({ role: "user", content: "edit lib/claude/usage.ts please" }).signals.includes(
      "artifact"
    )
  )
  assert.ok(
    scoreMessage({ role: "user", content: '{"key": "value", "n": 1}' }).signals.includes(
      "structured-data"
    )
  )
})

test("tool messages get the tool-call signal", () => {
  assert.ok(scoreMessage({ role: "tool", content: "result" }).signals.includes("tool-call"))
  assert.ok(
    scoreMessage({
      role: "assistant",
      content: [{ type: "tool-call", toolName: "grep" }],
    }).signals.includes("tool-call")
  )
})

test("recency lifts later messages and fires the signal in the back half", () => {
  const early = scoreMessage({ role: "user", content: "chatter" }, { index: 0, total: 10 })
  const late = scoreMessage({ role: "user", content: "chatter" }, { index: 9, total: 10 })
  assert.ok(late.score > early.score)
  assert.ok(late.signals.includes("recency"))
  assert.ok(!early.signals.includes("recency"))
})

test("plain chatter scores below the default 0.4 threshold; signal-rich scores above", () => {
  const plain = scoreMessage({ role: "user", content: "ok thanks" }, { index: 0, total: 20 })
  assert.ok(plain.score < 0.4)
  const rich = scoreMessage(
    { role: "user", content: "we decided to refactor lib/x.ts" },
    { index: 0, total: 20 }
  )
  assert.ok(rich.score >= 0.4)
})

test("score is clamped to [0,1] even with many signals", () => {
  const msg = {
    role: "system",
    content:
      'we decided to fix the error in lib/x.ts: see ```code``` and {"a":1} at https://e.com ?',
  }
  const { score } = scoreMessage(msg, { index: 19, total: 20 })
  assert.ok(score <= 1)
  assert.equal(score, 1)
})
