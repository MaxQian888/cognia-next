import { test } from "node:test"
import assert from "node:assert/strict"

import {
  awaitPluginHookResponse,
  pluginHookOutcome,
  runPluginHookHandler,
  PLUGIN_HOOK_BROADCAST,
  PLUGIN_HOOK_TIMEOUT_MS,
} from "./plugin-hook-exec.mjs"

/** A harness that captures the emitted frame and answers it. */
function harness(answer) {
  const pending = new Map()
  const emitted = []
  let n = 0
  const emit = (frame) => {
    emitted.push(frame)
    if (answer === "never") return
    // Answer on the next tick, like the renderer round-trip does.
    queueMicrotask(() => {
      const entry = pending.get(frame.execId)
      if (entry) entry.resolve(answer)
    })
  }
  return { pending, emitted, emit, newId: () => `exec-${++n}` }
}

test("emits a plugin_hook_exec frame carrying the parsed payload", async () => {
  const h = harness({ result: {} })
  await runPluginHookHandler(
    { type: "plugin", pluginId: "p1", hookId: "onPreToolUse" },
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash" }),
    { emit: h.emit, sessionId: "s1", pendingPluginHookCalls: h.pending, newId: h.newId }
  )
  assert.equal(h.emitted.length, 1)
  assert.deepEqual(h.emitted[0], {
    type: "plugin_hook_exec",
    sessionId: "s1",
    execId: "exec-1",
    pluginId: "p1",
    hookId: "onPreToolUse",
    payload: { hook_event_name: "PreToolUse", tool_name: "Bash" },
  })
})

test("a plugin's explicit deny becomes a block", async () => {
  for (const answer of [
    { result: { block: "nope" } },
    { result: { action: "deny", reason: "nope" } },
    { result: { decision: "block", message: "nope" } },
  ]) {
    const h = harness(answer)
    const out = await runPluginHookHandler(
      { type: "plugin", pluginId: "p1", hookId: "onPreToolUse" },
      "{}",
      { emit: h.emit, sessionId: "s1", pendingPluginHookCalls: h.pending, newId: h.newId }
    )
    assert.equal(out.block, "nope")
  }
})

test("additionalContext rides back without blocking", async () => {
  const h = harness({ result: { additionalContext: "remember this" } })
  const out = await runPluginHookHandler(
    { type: "plugin", pluginId: "p1", hookId: "onUserPromptSubmit" },
    "{}",
    { emit: h.emit, sessionId: "s1", pendingPluginHookCalls: h.pending, newId: h.newId }
  )
  assert.equal(out.block, undefined)
  assert.equal(out.additionalContext, "remember this")
})

test("fails OPEN on timeout, renderer error, and dispatch failure", async () => {
  // Timeout: a 1ms budget with an answer that never comes.
  const never = harness("never")
  const timedOut = await runPluginHookHandler(
    { type: "plugin", pluginId: "p1", hookId: "onPreToolUse", timeout: 0.001 },
    "{}",
    { emit: never.emit, sessionId: "s1", pendingPluginHookCalls: never.pending, newId: never.newId }
  )
  assert.match(timedOut.warning, /timed out/)
  assert.equal(timedOut.block, undefined)

  // Renderer reported a failure.
  const failed = harness({ error: "handler exploded" })
  const errored = await runPluginHookHandler(
    { type: "plugin", pluginId: "p1", hookId: "onPreToolUse" },
    "{}",
    {
      emit: failed.emit,
      sessionId: "s1",
      pendingPluginHookCalls: failed.pending,
      newId: failed.newId,
    }
  )
  assert.match(errored.warning, /handler exploded/)
  assert.equal(errored.block, undefined)

  // The emit itself threw.
  const boom = await runPluginHookHandler(
    { type: "plugin", pluginId: "p1", hookId: "onPreToolUse" },
    "{}",
    {
      emit: () => {
        throw new Error("stdout closed")
      },
      sessionId: "s1",
      pendingPluginHookCalls: new Map(),
      newId: () => "x",
    }
  )
  assert.match(boom.warning, /could not be dispatched/)
  assert.equal(boom.block, undefined)
})

test("fails OPEN with no renderer attached (headless)", async () => {
  const out = await runPluginHookHandler(
    { type: "plugin", pluginId: "p1", hookId: "onPreToolUse" },
    "{}",
    {}
  )
  assert.match(out.warning, /no renderer/)
  assert.equal(out.block, undefined)
})

test("rejects a malformed handler instead of emitting", async () => {
  const h = harness({ result: {} })
  for (const handler of [
    { type: "plugin" },
    { type: "plugin", pluginId: "p1" },
    { type: "plugin", hookId: "onPreToolUse" },
  ]) {
    const out = await runPluginHookHandler(handler, "{}", {
      emit: h.emit,
      sessionId: "s1",
      pendingPluginHookCalls: h.pending,
      newId: h.newId,
    })
    assert.match(out.warning, /missing pluginId\/hookId/)
  }
  assert.equal(h.emitted.length, 0)
})

test("a dropped pending entry cannot resolve twice", async () => {
  const pending = new Map()
  const promise = awaitPluginHookResponse(pending, "e1", 50)
  const entry = pending.get("e1")
  entry.resolve({ result: { block: "first" } })
  entry.resolve({ result: { block: "second" } })
  assert.deepEqual(await promise, { result: { block: "first" } })
  assert.equal(pending.size, 0)
})

test("carries the raw plugin return for host-owned seams", () => {
  // The compaction seam needs `skipCompaction` / `customStrategy`, which have
  // no equivalent in the settings.json decision vocabulary.
  const out = pluginHookOutcome({ result: { skipCompaction: true } }, "x:y")
  assert.deepEqual(out.pluginResult, { skipCompaction: true })
  assert.equal(out.block, undefined)
})

test("exposes a stable broadcast sentinel and timeout", () => {
  assert.equal(PLUGIN_HOOK_BROADCAST, "*")
  assert.equal(PLUGIN_HOOK_TIMEOUT_MS, 5_000)
})
