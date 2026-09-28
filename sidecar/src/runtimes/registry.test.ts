import test from "node:test"
import assert from "node:assert/strict"
import { resolveRuntimeAdapter, RUNTIME_ADAPTERS } from "./registry.ts"

test("registry resolves both adapters and rejects unknown ids", () => {
  assert.equal(resolveRuntimeAdapter("claude-agent-sdk")?.id, "claude-agent-sdk")
  assert.equal(resolveRuntimeAdapter("ai-sdk")?.id, "ai-sdk")
  assert.equal(resolveRuntimeAdapter("external"), null) // external never dispatches in-sidecar
  assert.equal(resolveRuntimeAdapter(undefined), null)
  assert.equal(Object.keys(RUNTIME_ADAPTERS).length, 2)
})
