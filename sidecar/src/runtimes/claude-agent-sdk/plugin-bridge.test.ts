import { test } from "node:test"
import assert from "node:assert/strict"
import { anthropicPluginToolBridgeOptions } from "./plugin-bridge.ts"

test("plugin tool bridge preserves the immutable sandbox runtime reference", () => {
  const options = anthropicPluginToolBridgeOptions({
    tools: [],
    emit: () => {},
    sessionId: "s1",
    turnId: "turn-1",
    attemptId: "attempt-2",
    sandboxRuntimeRef: "sandbox-runtime:anthropic",
    pendingPluginToolCalls: new Map(),
    alwaysLoad: true,
    alwaysLoadToolNames: new Set(),
  })

  assert.equal(options.sandboxRuntimeRef, "sandbox-runtime:anthropic")
  assert.equal(options.turnId, "turn-1")
  assert.equal(options.attemptId, "attempt-2")
})

test("plugin tool bridge forwards the alias table the dispatcher translates with", () => {
  const toolNameAliases = new Map()
  const options = anthropicPluginToolBridgeOptions({
    tools: [],
    emit: () => {},
    sessionId: "s1",
    pendingPluginToolCalls: new Map(),
    toolNameAliases,
  })
  assert.equal(options.toolNameAliases, toolNameAliases)
  const without = anthropicPluginToolBridgeOptions({
    tools: [],
    emit: () => {},
    sessionId: "s1",
    pendingPluginToolCalls: new Map(),
  })
  assert.equal("toolNameAliases" in without, false)
})
