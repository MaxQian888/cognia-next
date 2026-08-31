import { test } from "node:test"
import assert from "node:assert/strict"
import { anthropicPluginToolBridgeOptions, enforceAnthropicToolSurface } from "./anthropic.mjs"

test("disabled tool surface removes every SDK tool entry point", () => {
  const options = enforceAnthropicToolSurface(
    {
      tools: ["Read", "Bash"],
      allowedTools: ["Read"],
      mcpServers: { unsafe: { type: "stdio", command: "unsafe" } },
      agents: { helper: { description: "helper", prompt: "help" } },
      agent: "helper",
      hooks: { PreToolUse: [] },
    },
    { toolSurface: "none" }
  )

  assert.deepEqual(options.tools, [])
  assert.deepEqual(options.allowedTools, [])
  assert.deepEqual(options.mcpServers, {})
  assert.equal(options.agents, undefined)
  assert.equal(options.agent, undefined)
  assert.equal(options.hooks, undefined)
})

test("default tool surface preserves SDK options", () => {
  const original = { tools: ["Read"], mcpServers: { safe: {} } }
  assert.equal(enforceAnthropicToolSurface(original, {}), original)
})

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
