import test from "node:test"
import assert from "node:assert/strict"

import {
  ADAPTER_CAPABILITIES,
  capabilityError,
  capabilitySupported,
  commandSupported,
  resolveRuntimeAdapter,
  RUNTIME_ADAPTERS,
} from "./runtime-adapter.mjs"
import { CONTROL_METHOD_CAPABILITIES } from "./control.mjs"

test("registry resolves both adapters and rejects unknown ids", () => {
  assert.equal(resolveRuntimeAdapter("claude-agent-sdk")?.id, "claude-agent-sdk")
  assert.equal(resolveRuntimeAdapter("ai-sdk")?.id, "ai-sdk")
  assert.equal(resolveRuntimeAdapter("external"), null) // external never dispatches in-sidecar
  assert.equal(resolveRuntimeAdapter(undefined), null)
  assert.equal(Object.keys(RUNTIME_ADAPTERS).length, 2)
})

test("capability tables: subagents and steering are both claude-agent-sdk only", () => {
  assert.equal(ADAPTER_CAPABILITIES["claude-agent-sdk"].has("subagents.native"), true)
  assert.equal(ADAPTER_CAPABILITIES["ai-sdk"].has("subagents.native"), false)

  // This assertion used to read `false` for both adapters — pinning the bug as
  // if it were the design. `routeSteer()` in agent-host.mjs implements steering
  // and rejects every non-anthropic provider, so "neither has steer" made the
  // one rail that CAN steer fail closed whenever a frozen spec was present.
  assert.equal(ADAPTER_CAPABILITIES["claude-agent-sdk"].has("steer"), true)
  assert.equal(ADAPTER_CAPABILITIES["ai-sdk"].has("steer"), false)
})

test("commandSupported gates capability-mapped commands per adapter", () => {
  assert.equal(commandSupported("claude-agent-sdk", "compact"), true)
  assert.equal(commandSupported("ai-sdk", "set_mode"), true)
  assert.equal(commandSupported("claude-agent-sdk", "steer"), true)
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

test("capabilitySupported answers by capability, for the control surface", () => {
  // The control surface is keyed by SDK method name, so it cannot go through
  // COMMAND_CAPABILITIES; it needs the capability itself.
  assert.equal(capabilitySupported("claude-agent-sdk", "checkpoint"), true)
  assert.equal(capabilitySupported("ai-sdk", "checkpoint"), false)
  // Same two escapes as commandSupported: an adapter-less (legacy) session and
  // an adapter id this build does not know are both permissive, because
  // blocking there rejects a session whose capabilities we cannot read.
  assert.equal(capabilitySupported(undefined, "checkpoint"), true)
  assert.equal(capabilitySupported("unknown-adapter", "checkpoint"), true)
  assert.equal(capabilitySupported("claude-agent-sdk", undefined), true)
})

test("the claude table covers every capability a control gates on", () => {
  // A control gated on a capability no adapter declares can only ever return
  // `capability_error`. The gate proves this from source; this proves it from
  // the loaded modules.
  for (const capability of Object.values(CONTROL_METHOD_CAPABILITIES)) {
    assert.equal(
      ADAPTER_CAPABILITIES["claude-agent-sdk"].has(capability),
      true,
      `claude-agent-sdk must declare "${capability}"`
    )
  }
})
