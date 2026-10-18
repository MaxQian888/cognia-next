import test from "node:test"
import assert from "node:assert/strict"
import { fromResult } from "./result.ts"
import { createSdkMappingState } from "./index.ts"

test("result timing is portable and preserves zero queue waits", () => {
  const events = fromResult(
    {
      subtype: "success",
      first_text_post_ms: 12,
      first_text_post_queue_wait_ms: 0,
      first_text_post_queued_behind: "retry_backoff",
      first_stream_post_ms: 8,
    },
    createSdkMappingState()
  )
  assert.deepEqual(events.at(-1), {
    kind: "lifecycle",
    phase: "ended",
    timing: {
      firstTextMs: 12,
      firstTextQueueWaitMs: 0,
      firstTextQueueReason: "retry-backoff",
      firstStreamMs: 8,
    },
  })
})

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
