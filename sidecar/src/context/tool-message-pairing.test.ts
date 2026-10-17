import { test } from "node:test"
import assert from "node:assert/strict"

import {
  pairSafeSplitAfter,
  pairSafeSplitBefore,
  sanitizeToolMessagePairs,
  toolPairUnits,
  unpairedToolCallIds,
} from "./tool-message-pairing.ts"

// Helpers mirroring the AI SDK `ModelMessage` shapes the dispatcher builds.
const asstCall = (id: string, name = "bash") => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: id, toolName: name, input: {} }],
})
const asstTextCall = (text: string, id: string) => ({
  role: "assistant",
  content: [
    { type: "text", text },
    { type: "tool-call", toolCallId: id, toolName: "bash", input: {} },
  ],
})
const toolResult = (id: string, name = "bash") => ({
  role: "tool",
  content: [
    { type: "tool-result", toolCallId: id, toolName: name, output: { type: "text", value: "ok" } },
  ],
})

test("returns non-array input untouched", () => {
  assert.equal(sanitizeToolMessagePairs(null), null)
  assert.equal(sanitizeToolMessagePairs(undefined), undefined)
})

test("identity-preserving on a well-formed history", () => {
  const history = [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    asstCall("c1"),
    toolResult("c1"),
    { role: "assistant", content: "done" },
  ]
  const out = sanitizeToolMessagePairs(history)
  // Same length, and every message returned by reference (no needless copies).
  assert.equal(out.length, history.length)
  for (let i = 0; i < history.length; i++) assert.equal(out[i], history[i])
})

test("drops a dangling tool-call (call with no result)", () => {
  // Interrupt aborted the leg before the tool result landed.
  const history = [{ role: "user", content: "go" }, asstCall("c1")]
  const out = sanitizeToolMessagePairs(history)
  // The assistant message had only the dangling call → whole message dropped.
  assert.deepEqual(out, [{ role: "user", content: "go" }])
})

test("keeps assistant text when its only tool-call is dangling", () => {
  const history = [asstTextCall("thinking…", "c1")]
  const out = sanitizeToolMessagePairs(history)
  assert.equal(out.length, 1)
  assert.deepEqual(out[0]?.content, [{ type: "text", text: "thinking…" }])
})

test("drops an orphan tool-result (result with no preceding call)", () => {
  // Compaction tail slice cut off the assistant tool-call but kept its result.
  const history = [toolResult("gone"), { role: "user", content: "next" }]
  const out = sanitizeToolMessagePairs(history)
  assert.deepEqual(out, [{ role: "user", content: "next" }])
})

test("prunes only the unpaired part in a mixed tool message", () => {
  const history = [
    asstCall("c1"),
    { role: "tool", content: [toolResult("c1").content[0], toolResult("orphan").content[0]] },
  ]
  const out = sanitizeToolMessagePairs(history)
  assert.equal(out.length, 2)
  assert.equal(out[1]?.content.length, 1)
  assert.equal(out[1]?.content[0]?.toolCallId, "c1")
})

test("prunes only the unpaired call in a multi-call assistant message", () => {
  const history = [
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "c1", toolName: "bash", input: {} },
        { type: "tool-call", toolCallId: "c2", toolName: "bash", input: {} },
      ],
    },
    toolResult("c1"),
  ]
  const out = sanitizeToolMessagePairs(history)
  // c2 has no result → dropped; c1 stays; the tool message stays.
  assert.equal(out[0]?.content.length, 1)
  assert.equal(out[0]?.content[0]?.toolCallId, "c1")
  assert.equal(out[1]?.content[0]?.toolCallId, "c1")
})

test("leaves string-content assistant/user/system messages alone", () => {
  const history = [
    { role: "system", content: "s" },
    { role: "assistant", content: "plain text reply" },
    { role: "user", content: "thanks" },
  ]
  const out = sanitizeToolMessagePairs(history)
  assert.deepEqual(out, history)
})

// ── pair-safe splits ──────────────────────────────────────────────────────

const parallelCall = (...ids: string[]) => ({
  role: "assistant",
  content: ids.map((id) => ({ type: "tool-call", toolCallId: id, toolName: "bash", input: {} })),
})
const user = (text: string) => ({ role: "user", content: text })

test("pairSafeSplitBefore moves a cut that lands on a result back to its call", () => {
  const history = [user("u"), asstCall("a"), toolResult("a"), user("next")]
  assert.equal(pairSafeSplitBefore(history, 2), 1)
  assert.equal(pairSafeSplitBefore(history, 3), 3, "a cut after the pair is already safe")
  assert.equal(pairSafeSplitBefore(history, 1), 1, "a cut before the call is already safe")
})

test("pairSafeSplitBefore keeps parallel results with their single call message", () => {
  const history = [user("u"), parallelCall("a", "b"), toolResult("a"), toolResult("b"), user("x")]
  assert.equal(pairSafeSplitBefore(history, 3), 1)
})

test("pairSafeSplitBefore follows chained pairs back to the earliest call", () => {
  // Call b is issued in the same message that carries no result, but result a
  // arrives after call b: a cut between them must reach call a.
  const history = [user("u"), asstCall("a"), parallelCall("b"), toolResult("a"), toolResult("b")]
  assert.equal(pairSafeSplitBefore(history, 4), 1)
})

test("pairSafeSplitAfter moves a cut past the results of every call before it", () => {
  const history = [user("u"), parallelCall("a", "b"), toolResult("a"), toolResult("b"), user("x")]
  assert.equal(pairSafeSplitAfter(history, 2), 4)
  assert.equal(pairSafeSplitAfter(history, 1), 1)
  assert.equal(pairSafeSplitAfter(history, 99), history.length, "clamped to the length")
})

test("a pre-existing orphan result or dangling call never moves a cut", () => {
  const history = [user("u"), toolResult("ghost"), asstCall("dangling"), user("x")]
  assert.equal(pairSafeSplitBefore(history, 2), 2)
  assert.equal(pairSafeSplitAfter(history, 3), 3)
})

test("toolPairUnits groups each call with all of its results", () => {
  const history = [
    user("u"),
    asstTextCall("run", "a"),
    toolResult("a"),
    parallelCall("b", "c"),
    toolResult("b"),
    toolResult("c"),
    { role: "assistant", content: "done" },
  ]
  assert.deepEqual(
    toolPairUnits(history).map((unit) => unit.length),
    [1, 2, 3, 1]
  )
  assert.deepEqual(toolPairUnits(history).flat(), history)
})

test("unpairedToolCallIds reports orphan results and unanswered calls only", () => {
  assert.deepEqual([...unpairedToolCallIds([asstCall("a"), toolResult("a")])], [])
  assert.deepEqual(
    [
      ...unpairedToolCallIds([
        toolResult("orphan"),
        asstCall("a"),
        toolResult("a"),
        asstCall("open"),
      ]),
    ].sort(),
    ["open", "orphan"]
  )
  assert.deepEqual(
    [...unpairedToolCallIds([toolResult("late"), asstCall("late")])].sort(),
    ["late"],
    "a result before its call is still an orphan"
  )
})
