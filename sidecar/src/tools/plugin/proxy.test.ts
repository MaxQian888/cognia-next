import { test } from "node:test"
import assert from "node:assert/strict"

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

import {
  SERVER_NAME,
  SERVER_VERSION,
  awaitPluginToolResponse,
  buildPluginToolDefinitions,
  isCallToolResult,
} from "./proxy.ts"
import type { PendingPluginToolCalls, PluginToolResponse } from "./proxy.ts"

/** Resolve the pending call a frame opened, as the host does. */
function answer(pending: PendingPluginToolCalls, toolUseId: string, response: PluginToolResponse) {
  const entry = pending.get(toolUseId)
  assert.ok(entry, `no pending call ${toolUseId}`)
  entry.resolve(response)
}

test("awaitPluginToolResponse registers the resolver synchronously (before emit)", () => {
  const pending: PendingPluginToolCalls = new Map()
  void awaitPluginToolResponse(pending, "t3", "x", 1000)
  assert.equal(pending.has("t3"), true)
  answer(pending, "t3", { result: null })
})

test("awaitPluginToolResponse resolves with the response and clears the entry", async () => {
  const pending: PendingPluginToolCalls = new Map()
  const promise = awaitPluginToolResponse(pending, "t2", "sandbox_bash", 1000)
  answer(pending, "t2", { result: "ok" })
  assert.deepEqual(await promise, { result: "ok" })
  assert.equal(pending.has("t2"), false)
})

test("awaitPluginToolResponse can disable its timeout for long-running tools", async () => {
  const pending: PendingPluginToolCalls = new Map()
  const promise = awaitPluginToolResponse(pending, "tool-1", "long", 0)
  // Give a real timer a chance to fire — it must NOT.
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(pending.has("tool-1"), true)
  answer(pending, "tool-1", { result: "ok" })
  assert.deepEqual(await promise, { result: "ok" })
  assert.equal(pending.has("tool-1"), false)
})

test("awaitPluginToolResponse treats a negative / non-finite timeout as no timeout", async () => {
  const pending: PendingPluginToolCalls = new Map()
  const infinite = awaitPluginToolResponse(pending, "d", "dispatch_agent", Number.POSITIVE_INFINITY)
  const negative = awaitPluginToolResponse(pending, "n", "dispatch_agent", -1)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(pending.has("d"), true)
  assert.equal(pending.has("n"), true)
  answer(pending, "d", { result: "done" })
  answer(pending, "n", { result: "done" })
  assert.equal((await infinite).result, "done")
  assert.equal((await negative).result, "done")
})

test("awaitPluginToolResponse resolves with an error when the tool times out", async () => {
  const pending: PendingPluginToolCalls = new Map()
  const response = await awaitPluginToolResponse(pending, "tool-2", "slow", 1)
  // The entry is cleaned up so a late response can't double-resolve.
  assert.equal(pending.has("tool-2"), false)
  assert.deepEqual(response, { error: "plugin tool 'slow' timed out after 1ms" })
})

test("isCallToolResult accepts a well-formed MCP result", () => {
  assert.equal(
    isCallToolResult({
      content: [
        { type: "text", text: "shot.png (12 bytes)" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
    }),
    true
  )
})

test("isCallToolResult rejects ordinary plugin return values", () => {
  assert.equal(isCallToolResult({ ok: true, base64: "AAAA" }), false)
  assert.equal(isCallToolResult({ ok: false, error: "user-cancelled" }), false)
  assert.equal(isCallToolResult("plain text"), false)
  assert.equal(isCallToolResult(null), false)
  assert.equal(isCallToolResult(undefined), false)
  assert.equal(isCallToolResult(42), false)
})

test("isCallToolResult rejects a malformed or empty content array", () => {
  // An empty array carries nothing, so flattening it to `{"content":[]}` text
  // is no worse — and keeps the passthrough honest about what it accepts.
  assert.equal(isCallToolResult({ content: [] }), false)
  assert.equal(isCallToolResult({ content: "not an array" }), false)
  assert.equal(isCallToolResult({ content: [{ text: "no type field" }] }), false)
  assert.equal(isCallToolResult({ content: [null] }), false)
  // An array at the top level is not a CallToolResult.
  assert.equal(isCallToolResult([{ type: "text", text: "x" }]), false)
})

test("server name + version are stable", () => {
  assert.equal(SERVER_NAME, "cognia-plugin-tools")
  assert.match(SERVER_VERSION, /^\d+\.\d+\.\d+$/)
})

test("buildPluginToolDefinitions returns null for an empty or missing manifest", () => {
  const base = { emit: () => {}, sessionId: "s", pendingPluginToolCalls: new Map() }
  assert.equal(buildPluginToolDefinitions({ ...base, tools: [] }), null)
  assert.equal(buildPluginToolDefinitions({ ...base, tools: undefined }), null)
})

test("plugin definitions are engine-neutral and round-trip through the renderer", async () => {
  const pending: PendingPluginToolCalls = new Map()
  const frames: Record<string, unknown>[] = []
  const definitions = buildPluginToolDefinitions({
    tools: [
      { name: "echo", description: "Echo", jsonSchema: { type: "object", properties: {} } },
      { name: "pinned", description: "Pinned", jsonSchema: {} },
    ],
    emit: (frame) => {
      frames.push(frame)
      answer(pending, frame.toolUseId as string, { result: { said: "hi" } })
    },
    sessionId: "sess",
    pendingPluginToolCalls: pending,
    alwaysLoadToolNames: ["pinned"],
    turnId: "turn-1",
  })!
  const [echo, pinned] = definitions
  // Tool-search presentation is a neutral field; no engine metadata is written.
  assert.equal(echo!.alwaysLoad, undefined)
  assert.equal(pinned!.alwaysLoad, true)
  assert.equal(echo!._meta, undefined)
  const result = (await echo!.handler({ value: 1 })) as CallToolResult
  assert.deepEqual(frames[0], {
    type: "plugin_tool_exec",
    sessionId: "sess",
    toolUseId: frames[0]!.toolUseId,
    name: "echo",
    args: { value: 1 },
    turnId: "turn-1",
  })
  assert.deepEqual(result.content, [{ type: "text", text: '{"said":"hi"}' }])
})

test("server-wide always-load marks every plugin definition resident", () => {
  const definitions = buildPluginToolDefinitions({
    tools: [{ name: "a", description: "a", jsonSchema: {} }],
    emit: () => {},
    sessionId: "s",
    pendingPluginToolCalls: new Map(),
    alwaysLoad: true,
  })!
  assert.equal(definitions[0]!.alwaysLoad, true)
})
