import test from "node:test"
import assert from "node:assert/strict"
import { fromAssistant } from "./content.ts"
import { createSdkMappingState } from "./index.ts"

test("repeated tool snapshots retain only the first sealed call", () => {
  const state = createSdkMappingState()
  const message = (input: unknown, status?: string) => ({
    message: { content: [{ type: "tool_use", id: "t", name: "Read", input, state: status }] },
  })
  assert.deepEqual(fromAssistant(message({}, "input-streaming"), state), [])
  assert.equal(fromAssistant(message({ path: "a" }), state).length, 1)
  assert.deepEqual(fromAssistant(message({ path: "a" }), state), [])
})
