import assert from "node:assert/strict"
import { Readable } from "node:stream"
import { test } from "node:test"
import { createLiveStreamCompat } from "./builtin-agent-live-stream-compat.mjs"

async function forward(chunks) {
  const repairs = []
  const stream = Readable.from(chunks).pipe(createLiveStreamCompat((kind) => repairs.push(kind)))
  let output = ""
  for await (const chunk of stream) output += chunk.toString()
  return { output, repairs }
}

test("Chat empty tool type is omitted without changing argument fragments or identifiers", async () => {
  const event = {
    choices: [{ delta: { tool_calls: [{ index: 5, type: "", function: { arguments: "}" } }] } }],
  }
  const result = await forward([Buffer.from(`data: ${JSON.stringify(event)}\n\n`)])
  const parsed = JSON.parse(result.output.split("\n")[0].slice(6))
  assert.deepEqual(parsed.choices[0].delta.tool_calls, [{ index: 5, function: { arguments: "}" } }])
  assert.deepEqual(result.repairs, ["chat-empty-tool-type"])
})

test("Responses function start receives an empty argument accumulator, never a fabricated call or result", async () => {
  const event = {
    type: "response.output_item.added",
    output_index: 4,
    item: { type: "function_call", id: "fc1", call_id: "c1", name: "read", status: "in_progress" },
  }
  const result = await forward([Buffer.from(`data: ${JSON.stringify(event)}\n\n`)])
  assert.deepEqual(JSON.parse(result.output.split("\n")[0].slice(6)), {
    ...event,
    item: { ...event.item, arguments: "" },
  })
  assert.deepEqual(result.repairs, ["responses-missing-start-arguments"])
})

test("valid traffic, existing arguments, comments, errors and unknown malformed fields pass unchanged", async () => {
  const lines = [
    ": keepalive\r\n",
    "event: response.output_item.added\r\n",
    'data: {"type":"response.output_item.added","item":{"type":"function_call","arguments":"{\\\"x\\\":1}"}}\r\n\r\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"type":"function","function":{"arguments":"{"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"type":"invalid"}]}}]}\n\n',
    'data: {"choices":{}}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":{}}}]}\n\n',
    'data: {"error":{"message":"upstream failure"}}\n\n',
    "data: {bad json}\n\n",
    "data: [DONE]\n\n",
  ].join("")
  assert.deepEqual(await forward([Buffer.from(lines)]), { output: lines, repairs: [] })
})

test("missing final arguments and explicit null remain errors rather than silently losing data", async () => {
  const lines = [
    { type: "response.output_item.done", item: { type: "function_call", id: "fc1" } },
    { type: "response.output_item.added", item: { type: "function_call", arguments: null } },
    { type: "response.output_item.added", item: { type: "message" } },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("")
  assert.deepEqual(await forward([Buffer.from(lines)]), { output: lines, repairs: [] })
})

test("arbitrary byte boundaries preserve UTF8, CRLF, real argument deltas and an unterminated final line", async () => {
  const before =
    'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc1","call_id":"c1","name":"read"}}\r\n\r\n'
  const after =
    'data: {"type":"response.function_call_arguments.delta","delta":"中文路径"}\r\n\r\ndata: [DONE]'
  const bytes = Buffer.from(before + after)
  const result = await forward(Array.from(bytes, (byte) => Buffer.from([byte])))
  const first = JSON.parse(result.output.split("\r\n")[0].slice(6))
  assert.equal(first.item.arguments, "")
  assert.equal(result.output.slice(result.output.indexOf("\r\n") + 4), after)
  assert.deepEqual(result.repairs, ["responses-missing-start-arguments"])
})
