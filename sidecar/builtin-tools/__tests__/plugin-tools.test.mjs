import { test } from "node:test"
import assert from "node:assert/strict"

import {
  SERVER_NAME,
  SERVER_VERSION,
  awaitPluginToolResponse,
  buildPluginToolsServer,
  isCallToolResult,
  jsonSchemaToZodShape,
  jsonSchemaPropToZod,
} from "../plugin-tools.mjs"

test("server name + version are stable", () => {
  assert.equal(SERVER_NAME, "cognia-plugin-tools")
  assert.match(SERVER_VERSION, /^\d+\.\d+\.\d+$/)
})

test("buildPluginToolsServer returns null when tools array is empty or missing", () => {
  assert.equal(
    buildPluginToolsServer({
      tools: [],
      emit: () => {},
      sessionId: "s",
      pendingPluginToolCalls: new Map(),
    }),
    null
  )
  assert.equal(
    buildPluginToolsServer({
      tools: undefined,
      emit: () => {},
      sessionId: "s",
      pendingPluginToolCalls: new Map(),
    }),
    null
  )
})

test("buildPluginToolsServer returns a server config with the SERVER_NAME", () => {
  const server = buildPluginToolsServer({
    tools: [
      {
        name: "demo",
        description: "demo tool",
        jsonSchema: {
          type: "object",
          properties: { foo: { type: "string" } },
          required: ["foo"],
        },
        pluginId: "p1",
      },
    ],
    emit: () => {},
    sessionId: "s",
    pendingPluginToolCalls: new Map(),
  })
  assert.notEqual(server, null)
  assert.equal(server?.name, SERVER_NAME)
})

test("awaitPluginToolResponse can disable its timeout for long-running tools", async () => {
  const pending = new Map()
  const promise = awaitPluginToolResponse(pending, "tool-1", "long", 0)
  assert.equal(pending.has("tool-1"), true)
  pending.get("tool-1").resolve({ result: "ok" })
  assert.deepEqual(await promise, { result: "ok" })
  assert.equal(pending.has("tool-1"), false)
})

test("awaitPluginToolResponse resolves with an error when the tool times out", async () => {
  const pending = new Map()
  const response = await awaitPluginToolResponse(pending, "tool-2", "slow", 1)
  assert.equal(pending.has("tool-2"), false)
  assert.deepEqual(response, { error: "plugin tool 'slow' timed out after 1ms" })
})

test("synthesized tool emits plugin_tool_exec and resolves with the response result", async () => {
  const emitted = []
  const pending = new Map()
  const server = buildPluginToolsServer({
    tools: [
      {
        name: "echo",
        description: "echo back",
        jsonSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        pluginId: "p1",
      },
    ],
    emit: (msg) => {
      emitted.push(msg)
      // Simulate the renderer responding immediately.
      const pendingEntry = pending.get(msg.toolUseId)
      if (pendingEntry) pendingEntry.resolve({ result: `got: ${msg.args.text}` })
    },
    sessionId: "sess-1",
    pendingPluginToolCalls: pending,
  })

  // The SDK registers each tool() on `instance._registeredTools[name]` with
  // its `handler` callback exposed; we invoke it directly so the test can
  // run without spinning up an MCP transport.
  const registered = server.instance?._registeredTools?.echo
  assert.ok(registered, "expected the wrapped tool to be exposed on the server")
  const result = await registered.handler({ text: "hi" })

  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].type, "plugin_tool_exec")
  assert.equal(emitted[0].sessionId, "sess-1")
  assert.equal(emitted[0].name, "echo")
  assert.deepEqual(emitted[0].args, { text: "hi" })
  assert.equal(typeof emitted[0].toolUseId, "string")
  assert.equal(result.isError, undefined)
  assert.equal(result.content[0].type, "text")
  assert.equal(result.content[0].text, "got: hi")
})

test("synthesized tool preserves the server-issued remote execution context", async () => {
  const emitted = []
  const pending = new Map()
  const remoteExecutionContext = {
    hostId: "host-a",
    originDeviceId: "device-a",
    sessionId: "session-a",
    generation: 1,
    requestId: "request-a",
    issuedAt: 1,
    expiresAt: 2,
  }
  const server = buildPluginToolsServer({
    tools: [{ name: "remote-tool", jsonSchema: { type: "object", properties: {} } }],
    emit: (event) => emitted.push(event),
    sessionId: "session-a",
    pendingPluginToolCalls: pending,
    remoteExecutionContext,
  })

  const call = server.instance._registeredTools["remote-tool"].handler({})
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(emitted[0].remoteExecutionContext, remoteExecutionContext)
  pending.get(emitted[0].toolUseId).resolve({ result: "ok" })
  await call
})

test("synthesized tool returns compact JSON for structured results", async () => {
  const pending = new Map()
  const server = buildPluginToolsServer({
    tools: [
      {
        name: "structured",
        description: "structured response",
        jsonSchema: { type: "object", properties: {} },
        pluginId: "p1",
      },
    ],
    emit: (msg) => {
      const pendingEntry = pending.get(msg.toolUseId)
      if (pendingEntry) pendingEntry.resolve({ result: { ok: true, rows: [1, 2] } })
    },
    sessionId: "sess-1",
    pendingPluginToolCalls: pending,
  })
  const registered = server.instance?._registeredTools?.structured
  assert.ok(registered)
  const result = await registered.handler({})
  assert.equal(result.isError, undefined)
  assert.equal(result.content[0].text, '{"ok":true,"rows":[1,2]}')
})

test("synthesized tool passes an MCP CallToolResult through untouched", async () => {
  // Without the passthrough every plugin result is JSON.stringify-ed into one
  // text block, which makes returning an image / audio / embedded resource
  // structurally impossible — the model would only ever get base64 text.
  const pending = new Map()
  const callToolResult = {
    content: [
      { type: "text", text: "shot.png (12 bytes)" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ],
  }
  const server = buildPluginToolsServer({
    tools: [
      {
        name: "take_screenshot",
        description: "capture",
        jsonSchema: { type: "object", properties: {} },
        pluginId: "p1",
      },
    ],
    emit: (msg) => {
      const e = pending.get(msg.toolUseId)
      if (e) e.resolve({ result: callToolResult })
    },
    sessionId: "s",
    pendingPluginToolCalls: pending,
  })
  const registered = server.instance?._registeredTools?.take_screenshot
  assert.ok(registered)
  const result = await registered.handler({})
  assert.deepEqual(result, callToolResult)
  assert.equal(result.content[1].data, "AAAA")
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

test("synthesized tool surfaces error responses as isError content", async () => {
  const pending = new Map()
  const server = buildPluginToolsServer({
    tools: [
      {
        name: "fail",
        description: "always fails",
        jsonSchema: { type: "object", properties: {} },
        pluginId: "p1",
      },
    ],
    emit: (msg) => {
      const e = pending.get(msg.toolUseId)
      if (e) e.resolve({ error: "boom" })
    },
    sessionId: "s",
    pendingPluginToolCalls: pending,
  })
  const registered = server.instance?._registeredTools?.fail
  assert.ok(registered)
  const result = await registered.handler({})
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /Error: boom/)
})

test("jsonSchemaToZodShape returns empty shape for non-object schemas", () => {
  assert.deepEqual(jsonSchemaToZodShape(null), {})
  assert.deepEqual(jsonSchemaToZodShape(undefined), {})
  assert.deepEqual(jsonSchemaToZodShape({ type: "string" }), {})
  assert.deepEqual(jsonSchemaToZodShape({ type: "object" }), {})
})

test("jsonSchemaToZodShape produces one zod entry per declared property", () => {
  const shape = jsonSchemaToZodShape({
    type: "object",
    properties: {
      a: { type: "string" },
      b: { type: "number" },
      c: { type: "boolean" },
    },
    required: ["a"],
  })
  assert.deepEqual(Object.keys(shape).sort(), ["a", "b", "c"])
})

test("jsonSchemaPropToZod handles the common primitive types", () => {
  // Smoke-check: each call returns a zod-like object with a parse() method.
  const types = ["string", "number", "integer", "boolean", "null", "array", "object", "weird"]
  for (const t of types) {
    const z = jsonSchemaPropToZod({ type: t }, true)
    assert.equal(typeof z.parse, "function", `expected zod for type=${t}`)
  }
})

test("jsonSchemaPropToZod wraps non-required fields in .optional()", () => {
  const required = jsonSchemaPropToZod({ type: "string" }, true)
  const optional = jsonSchemaPropToZod({ type: "string" }, false)
  // Optional schemas expose isOptional() on zod v3+ instances.
  assert.equal(typeof required.isOptional, "function")
  assert.equal(required.isOptional(), false)
  assert.equal(optional.isOptional(), true)
})

test("jsonSchemaPropToZod preserves descriptions on known fields", () => {
  const schema = jsonSchemaPropToZod({ type: "string", description: "field docs" }, true)
  assert.equal(schema.description, "field docs")
})
