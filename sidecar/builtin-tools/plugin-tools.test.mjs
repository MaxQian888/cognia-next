import { test } from "node:test"
import assert from "node:assert/strict"

import { awaitPluginToolResponse } from "./plugin-tools.mjs"

test("awaitPluginToolResponse times out to an error envelope when no response arrives", async () => {
  const pending = new Map()
  const res = await awaitPluginToolResponse(pending, "t1", "sandbox_bash", 20)
  assert.equal(typeof res.error, "string")
  assert.match(res.error, /timed out/)
  // the pending entry is cleaned up so a late response can't double-resolve
  assert.equal(pending.has("t1"), false)
})

test("awaitPluginToolResponse resolves with the response and clears the entry", async () => {
  const pending = new Map()
  const p = awaitPluginToolResponse(pending, "t2", "sandbox_bash", 1000)
  // claude-host resolves via the registered { resolve } entry
  pending.get("t2").resolve({ result: "ok" })
  const res = await p
  assert.equal(res.result, "ok")
  assert.equal(pending.has("t2"), false)
})

test("awaitPluginToolResponse registers the resolver synchronously (before emit)", () => {
  const pending = new Map()
  void awaitPluginToolResponse(pending, "t3", "x", 1000)
  assert.equal(pending.has("t3"), true)
  pending.get("t3").resolve({ result: null })
})

test("awaitPluginToolResponse with timeoutMs 0 never times out (blocking tools)", async () => {
  const pending = new Map()
  const p = awaitPluginToolResponse(pending, "ask", "ask_user", 0)
  // Give a real timer a chance to fire — it must NOT.
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(pending.has("ask"), true)
  pending.get("ask").resolve({ result: "Answer: yes" })
  const res = await p
  assert.equal(res.result, "Answer: yes")
  assert.equal(pending.has("ask"), false)
})

test("awaitPluginToolResponse treats a negative / non-finite timeout as no timeout", async () => {
  const pending = new Map()
  const p = awaitPluginToolResponse(pending, "d", "dispatch_agent", Number.POSITIVE_INFINITY)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(pending.has("d"), true)
  pending.get("d").resolve({ result: "done" })
  assert.equal((await p).result, "done")
})
