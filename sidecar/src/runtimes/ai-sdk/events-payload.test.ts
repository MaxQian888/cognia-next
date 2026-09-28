import { test } from "node:test"
import assert from "node:assert/strict"
import { finishReasonToStopReason, shapeToolResultContent } from "./events-payload.ts"

test("finishReasonToStopReason maps only length/content-filter", () => {
  assert.equal(finishReasonToStopReason("length"), "max_tokens")
  assert.equal(finishReasonToStopReason("content-filter"), "refusal")
  assert.equal(finishReasonToStopReason("stop"), null)
  assert.equal(finishReasonToStopReason("tool-calls"), null)
  assert.equal(finishReasonToStopReason(undefined), null)
})

test("shapeToolResultContent stringifies text/object results but keeps image blocks structured", () => {
  // Plain string passes through.
  assert.equal(shapeToolResultContent("hello"), "hello")
  // A non-image object is JSON-stringified (unchanged behavior).
  assert.equal(
    shapeToolResultContent({ content: [{ type: "text", text: "x" }] }),
    '{"content":[{"type":"text","text":"x"}]}'
  )
  // An MCP image result keeps its structured blocks so the TUI can render it.
  const blocks = [
    { type: "text", text: "shot.png" },
    { type: "image", data: "QUJD", mimeType: "image/png" },
  ]
  assert.deepEqual(shapeToolResultContent({ content: blocks }), blocks)
})
