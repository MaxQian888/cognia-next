import test from "node:test"
import assert from "node:assert/strict"
import { fromResult } from "./result.ts"
import { createSdkMappingState } from "./index.ts"

test("missing requested structured output settles as failure before lifecycle", () => {
  const events = fromResult(
    { type: "result", subtype: "success" },
    createSdkMappingState({ expectStructuredOutput: true })
  )
  assert.deepEqual(
    events.map((event) => event.kind),
    ["structured-output", "failure"]
  )
})
