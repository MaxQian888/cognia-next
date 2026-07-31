import test from "node:test"
import assert from "node:assert/strict"

import {
  ADAPTER_CAPABILITIES,
  capabilityError,
  commandSupported,
  resolveRuntimeAdapter,
  RUNTIME_ADAPTERS,
} from "./runtime-adapter.mjs"

test("registry resolves both adapters and rejects unknown ids", () => {
  assert.equal(resolveRuntimeAdapter("claude-agent-sdk")?.id, "claude-agent-sdk")
  assert.equal(resolveRuntimeAdapter("ai-sdk")?.id, "ai-sdk")
  assert.equal(resolveRuntimeAdapter("external"), null) // external never dispatches in-sidecar
  assert.equal(resolveRuntimeAdapter(undefined), null)
  assert.equal(Object.keys(RUNTIME_ADAPTERS).length, 2)
})

test("capability tables: only claude-agent-sdk has native subagents; neither has steer", () => {
  assert.equal(ADAPTER_CAPABILITIES["claude-agent-sdk"].has("subagents.native"), true)
  assert.equal(ADAPTER_CAPABILITIES["ai-sdk"].has("subagents.native"), false)
  assert.equal(ADAPTER_CAPABILITIES["claude-agent-sdk"].has("steer"), false)
  assert.equal(ADAPTER_CAPABILITIES["ai-sdk"].has("steer"), false)
})

test("commandSupported gates capability-mapped commands per adapter", () => {
  assert.equal(commandSupported("claude-agent-sdk", "compact"), true)
  assert.equal(commandSupported("ai-sdk", "set_mode"), true)
  assert.equal(commandSupported("claude-agent-sdk", "steer"), false)
  assert.equal(commandSupported("ai-sdk", "steer"), false)
  // Universal commands and legacy (adapter-less) sessions are never blocked.
  assert.equal(commandSupported("ai-sdk", "interrupt"), true)
  assert.equal(commandSupported(undefined, "steer"), true)
  assert.equal(commandSupported("unknown-adapter", "steer"), true)
})

test("capabilityError builds the typed wire payload", () => {
  assert.deepEqual(capabilityError("s1", "steer", "steer"), {
    type: "capability_error",
    sessionId: "s1",
    capability: "steer",
    command: "steer",
  })
})
