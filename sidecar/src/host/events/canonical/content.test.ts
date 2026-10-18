import test from "node:test"
import assert from "node:assert/strict"
import { fromAssistant, fromUser } from "./content.ts"
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

test("a detached web tool emits background progress rather than a completed result", () => {
  const events = fromUser({
    tool_use_result: { detachedToolCall: true },
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "web-1",
          tool_name: "WebFetch",
          content: "backgrounded",
        },
      ],
    },
  })
  assert.deepEqual(events, [
    {
      kind: "tool-progress",
      toolCallId: "web-1",
      toolName: "WebFetch",
      elapsedMs: 0,
      backgrounded: true,
    },
  ])
})

test("structured MCP output and its omission marker survive canonical projection", () => {
  const message = { content: [{ type: "tool_result", tool_use_id: "mcp-1", content: "fallback" }] }
  for (const metadata of [
    { structuredContent: { value: 42 } },
    { structuredContentOmitted: true },
  ]) {
    assert.deepEqual(fromUser({ message, tool_use_result: metadata }), [
      {
        kind: "tool-result",
        toolName: "",
        toolCallId: "mcp-1",
        result: "fallback",
        ...metadata,
      },
    ])
  }
})

test("an aggregated result never repeats a single structured twin across its calls", () => {
  const events = fromUser({
    tool_use_result: { detachedToolCall: true, structuredContent: { value: 42 } },
    message: {
      content: [
        { type: "tool_result", tool_use_id: "one", content: "first" },
        { type: "tool_result", tool_use_id: "two", content: "second" },
      ],
    },
  })
  assert.deepEqual(events, [
    { kind: "tool-result", toolName: "", toolCallId: "one", result: "first" },
    { kind: "tool-result", toolName: "", toolCallId: "two", result: "second" },
  ])
})
