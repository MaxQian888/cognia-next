import { test } from "node:test"
import assert from "node:assert/strict"

import { EMITTED_INSTRUCTIONS_KEY, partitionPrompt } from "./prompt-partition.mjs"

const CACHE_CONTROL = { anthropic: { cacheControl: { type: "ephemeral" } } }

const sys = (content, providerOptions) => ({
  role: "system",
  content,
  ...(providerOptions ? { providerOptions } : {}),
})

test("emits under the key the installed AI SDK accepts", () => {
  // ai@6 only accepts `system` on streamText. Flip this pin in the v7 bump.
  assert.equal(EMITTED_INSTRUCTIONS_KEY, "system")
})

test("leaves a system-free conversation untouched", () => {
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ]
  assert.deepEqual(partitionPrompt(messages), { messages })
})

test("handles empty and non-array input", () => {
  assert.deepEqual(partitionPrompt([]), { messages: [] })
  assert.deepEqual(partitionPrompt(undefined), { messages: [] })
  assert.deepEqual(partitionPrompt(null), { messages: [] })
})

test("hoists a single leading system message", () => {
  const result = partitionPrompt([sys("be terse"), { role: "user", content: "hi" }])
  assert.deepEqual(result.system, [{ role: "system", content: "be terse" }])
  assert.deepEqual(result.messages, [{ role: "user", content: "hi" }])
  assert.equal(result.allowSystemInMessages, undefined)
})

test("preserves order and per-message providerOptions across the leading run", () => {
  // Mirrors ai-sdk.mjs's three-breakpoint Anthropic cache layout: stable base,
  // stable append, uncached per-turn tail.
  const result = partitionPrompt([
    sys("base", CACHE_CONTROL),
    sys("stable append", CACHE_CONTROL),
    sys("per-turn tail"),
    { role: "user", content: "hi" },
  ])

  assert.deepEqual(result.system, [
    { role: "system", content: "base", providerOptions: CACHE_CONTROL },
    { role: "system", content: "stable append", providerOptions: CACHE_CONTROL },
    { role: "system", content: "per-turn tail" },
  ])
  assert.deepEqual(result.messages, [{ role: "user", content: "hi" }])
})

test("prepends separately-carried leading instructions ahead of history system content", () => {
  const result = partitionPrompt([sys("from history"), { role: "user", content: "hi" }], "composed")
  assert.deepEqual(result.system, [
    { role: "system", content: "composed" },
    { role: "system", content: "from history" },
  ])
})

test("drops blank leading instructions instead of emitting an empty system turn", () => {
  for (const value of [undefined, null, "", "   \n\t "]) {
    assert.equal(partitionPrompt([{ role: "user", content: "hi" }], value).system, undefined)
  }
})

test("accepts a single system message or an array as leading instructions", () => {
  assert.deepEqual(
    partitionPrompt([{ role: "user", content: "x" }], sys("solo", CACHE_CONTROL)).system,
    [{ role: "system", content: "solo", providerOptions: CACHE_CONTROL }]
  )
  assert.deepEqual(partitionPrompt([{ role: "user", content: "x" }], [sys("a"), sys("b")]).system, [
    { role: "system", content: "a" },
    { role: "system", content: "b" },
  ])
})

test("drops blank system messages so they never reach the provider", () => {
  const result = partitionPrompt([sys("   "), sys("real"), { role: "user", content: "hi" }])
  assert.deepEqual(result.system, [{ role: "system", content: "real" }])
})

test("leaves mid-history system messages in place and opts them back in", () => {
  // compaction-strategies.mjs can leave a system turn mid-array; hoisting it
  // would reorder what the model sees, so it stays put.
  const messages = [
    { role: "user", content: "hi" },
    sys("mid-course correction"),
    { role: "assistant", content: "ok" },
  ]
  const result = partitionPrompt(messages)

  assert.equal(result.system, undefined)
  assert.deepEqual(result.messages, messages)
  assert.equal(result.allowSystemInMessages, true)
})

test("hoists the leading run while still opting in for an interleaved system message", () => {
  const result = partitionPrompt([
    sys("base"),
    { role: "user", content: "hi" },
    sys("mid"),
    { role: "assistant", content: "ok" },
  ])

  assert.deepEqual(result.system, [{ role: "system", content: "base" }])
  assert.deepEqual(result.messages, [
    { role: "user", content: "hi" },
    { role: "system", content: "mid" },
    { role: "assistant", content: "ok" },
  ])
  assert.equal(result.allowSystemInMessages, true)
})

test("treats an all-system conversation as pure instructions", () => {
  const result = partitionPrompt([sys("a"), sys("b")])
  assert.deepEqual(result.system, [
    { role: "system", content: "a" },
    { role: "system", content: "b" },
  ])
  assert.deepEqual(result.messages, [])
  assert.equal(result.allowSystemInMessages, undefined)
})

test("does not mutate the input array", () => {
  const messages = [sys("base"), { role: "user", content: "hi" }]
  const snapshot = structuredClone(messages)
  partitionPrompt(messages, "composed")
  assert.deepEqual(messages, snapshot)
})

test("spreads into call options without leaking undefined keys", () => {
  const options = { model: "m", ...partitionPrompt([{ role: "user", content: "hi" }]) }
  assert.deepEqual(Object.keys(options).sort(), ["messages", "model"])
})
