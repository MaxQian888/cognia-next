// The plugin proxy registered as the Claude Agent SDK rail's in-process MCP
// server: every case runs through the real SDK server composition.

import { test } from "node:test"
import assert from "node:assert/strict"

import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

import { SERVER_NAME } from "../plugin/proxy.ts"
import type { PendingPluginToolCalls, PluginToolResponse } from "../plugin/proxy.ts"
import { buildPluginToolsServer } from "./sdk-mcp-plugin.ts"

/** The `plugin_tool_exec` frame the server emits. */
interface ExecFrame {
  type: string
  sessionId: string
  toolUseId: string
  name: string
  args: Record<string, unknown>
  [field: string]: unknown
}

const asFrame = (frame: Record<string, unknown>) => frame as unknown as ExecFrame

type RegisteredTool = { handler(args: unknown, extra?: unknown): Promise<CallToolResult> }

/**
 * The SDK registers each tool() on `instance._registeredTools[name]` with its
 * `handler` callback exposed; the tests invoke it directly so they run without
 * an MCP transport.
 */
function registeredTools(
  server: McpSdkServerConfigWithInstance | null
): Record<string, RegisteredTool | undefined> {
  assert.ok(server, "expected a server")
  return (server.instance as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools
}

/** Resolve the pending call a frame opened, as the host does. */
function answer(pending: PendingPluginToolCalls, toolUseId: string, response: PluginToolResponse) {
  const entry = pending.get(toolUseId)
  assert.ok(entry, `no pending call ${toolUseId}`)
  entry.resolve(response)
}

/** The text of a result's first block. */
function firstText(result: CallToolResult): string {
  const block = result.content[0]
  assert.equal(block?.type, "text")
  return (block as { text: string }).text
}

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

test("synthesized tool emits plugin_tool_exec and resolves with the response result", async () => {
  const emitted: ExecFrame[] = []
  const pending: PendingPluginToolCalls = new Map()
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
      const frame = asFrame(msg)
      emitted.push(frame)
      // Simulate the renderer responding immediately.
      answer(pending, frame.toolUseId, { result: `got: ${String(frame.args.text)}` })
    },
    sessionId: "sess-1",
    turnId: "turn-1",
    attemptId: "attempt-2",
    sandboxRuntimeRef: "sandbox-runtime:one",
    pendingPluginToolCalls: pending,
  })

  const registered = registeredTools(server).echo
  assert.ok(registered, "expected the wrapped tool to be exposed on the server")
  const result = await registered.handler({ text: "hi" })
  const [frame] = emitted
  assert.ok(frame)

  assert.equal(emitted.length, 1)
  assert.equal(frame.type, "plugin_tool_exec")
  assert.equal(frame.sessionId, "sess-1")
  assert.equal(frame.turnId, "turn-1")
  assert.equal(frame.attemptId, "attempt-2")
  assert.equal(frame.sandboxRuntimeRef, "sandbox-runtime:one")
  assert.equal(frame.name, "echo")
  assert.deepEqual(frame.args, { text: "hi" })
  assert.equal(typeof frame.toolUseId, "string")
  assert.equal(result.isError, undefined)
  assert.equal(firstText(result), "got: hi")
})

test("synthesized tool preserves the server-issued remote execution context", async () => {
  const emitted: ExecFrame[] = []
  const pending: PendingPluginToolCalls = new Map()
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
    emit: (event) => emitted.push(asFrame(event)),
    sessionId: "session-a",
    pendingPluginToolCalls: pending,
    remoteExecutionContext,
  })

  const call = registeredTools(server)["remote-tool"]!.handler({})
  await new Promise((resolve) => setImmediate(resolve))
  const [frame] = emitted
  assert.ok(frame)
  assert.deepEqual(frame.remoteExecutionContext, remoteExecutionContext)
  answer(pending, frame.toolUseId, { result: "ok" })
  await call
})

test("synthesized tool returns compact JSON for structured results", async () => {
  const pending: PendingPluginToolCalls = new Map()
  const server = buildPluginToolsServer({
    tools: [
      {
        name: "structured",
        description: "structured response",
        jsonSchema: { type: "object", properties: {} },
        pluginId: "p1",
      },
    ],
    emit: (msg) => answer(pending, asFrame(msg).toolUseId, { result: { ok: true, rows: [1, 2] } }),
    sessionId: "sess-1",
    pendingPluginToolCalls: pending,
  })
  const registered = registeredTools(server).structured
  assert.ok(registered)
  const result = await registered.handler({})
  assert.equal(result.isError, undefined)
  assert.equal(firstText(result), '{"ok":true,"rows":[1,2]}')
})

test("synthesized tool passes an MCP CallToolResult through untouched", async () => {
  // Without the passthrough every plugin result is JSON.stringify-ed into one
  // text block, which makes returning an image / audio / embedded resource
  // structurally impossible — the model would only ever get base64 text.
  const pending: PendingPluginToolCalls = new Map()
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
    emit: (msg) => answer(pending, asFrame(msg).toolUseId, { result: callToolResult }),
    sessionId: "s",
    pendingPluginToolCalls: pending,
  })
  const registered = registeredTools(server).take_screenshot
  assert.ok(registered)
  const result = await registered.handler({})
  assert.deepEqual(result, callToolResult)
  assert.equal((result.content[1] as { data?: string }).data, "AAAA")
})

test("synthesized tool surfaces error responses as isError content", async () => {
  const pending: PendingPluginToolCalls = new Map()
  const server = buildPluginToolsServer({
    tools: [
      {
        name: "fail",
        description: "always fails",
        jsonSchema: { type: "object", properties: {} },
        pluginId: "p1",
      },
    ],
    emit: (msg) => answer(pending, asFrame(msg).toolUseId, { error: "boom" }),
    sessionId: "s",
    pendingPluginToolCalls: pending,
  })
  const registered = registeredTools(server).fail
  assert.ok(registered)
  const result = await registered.handler({})
  assert.equal(result.isError, true)
  assert.match(firstText(result), /plugin tool: boom/)
  // A plugin failure is classified like any other, so the model is told
  // whether repeating the call could help.
  const failure = result._meta?.["cognia/failure"] as { kind?: string } | undefined
  assert.equal(failure?.kind, "execution-failed")
})

test("a manifest name the API would reject registers under its model-facing form and round-trips", async () => {
  const emitted: ExecFrame[] = []
  const pending: PendingPluginToolCalls = new Map()
  const aliases = new Map<string, string>()
  const server = buildPluginToolsServer({
    tools: [
      {
        name: "ocr.extract",
        description: "ocr",
        jsonSchema: { type: "object", properties: {} },
        pluginId: "p1",
      },
      {
        name: "sandbox_bash",
        description: "bash",
        jsonSchema: { type: "object", properties: {} },
        pluginId: "p1",
      },
    ],
    emit: (msg) => {
      const frame = asFrame(msg)
      emitted.push(frame)
      pending.get(frame.toolUseId)?.resolve({ result: "text" })
    },
    sessionId: "sess-1",
    pendingPluginToolCalls: pending,
    toolNameAliases: aliases,
  })
  const registered = registeredTools(server)
  assert.ok(registered.ocr_extract, "the model-facing name is what the SDK registers")
  assert.equal(registered["ocr.extract"], undefined)
  assert.ok(registered.sandbox_bash, "a safe name is registered unchanged")
  assert.deepEqual([...aliases], [["ocr_extract", "ocr.extract"]])

  await registered.ocr_extract!.handler({})
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0]!.name, "ocr.extract", "the renderer keeps seeing the manifest name")
})

test("buildPluginToolsServer works without an alias map to fill", () => {
  const server = buildPluginToolsServer({
    tools: [{ name: "docs/search", description: "d", jsonSchema: {}, pluginId: "p1" }],
    emit: () => {},
    sessionId: "s",
    pendingPluginToolCalls: new Map(),
  })
  assert.ok(registeredTools(server).docs_search)
})

test("real SDK plugin permission delegate allows original input and refuses post-hook rewrites", async () => {
  const pending: PendingPluginToolCalls = new Map()
  let rewrite = false
  const server = buildPluginToolsServer({
    tools: [
      {
        name: "review",
        description: "approval",
        jsonSchema: {
          type: "object",
          properties: {
            tool_name: { type: "string" },
            input: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
          required: ["tool_name", "input"],
        },
      },
    ],
    sessionId: "delegate",
    pendingPluginToolCalls: pending,
    permissionPromptToolName: "mcp__cognia-plugin-tools__review",
    emit: (event) => {
      const frame = asFrame(event)
      answer(pending, frame.toolUseId, {
        result: {
          behavior: "allow",
          updatedInput: rewrite ? { path: "/unsafe" } : frame.args.input,
        },
      })
    },
  })
  assert.ok(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test", version: "1" })
  await server.instance.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    const request = { name: "review", arguments: { tool_name: "Write", input: { path: "/safe" } } }
    const allowed = (await client.callTool(request)) as CallToolResult
    assert.equal((JSON.parse(firstText(allowed)) as { behavior: string }).behavior, "allow")
    rewrite = true
    const denied = (await client.callTool(request)) as CallToolResult
    assert.equal(denied.isError, true)
    assert.match(firstText(denied), /cannot rewrite/)
  } finally {
    await client.close()
    await server.instance.close()
  }
})

test("MCP discovery reports allowlisted and server-wide always-load plugin tools as resident", async () => {
  const manifest = [
    { name: "pinned", description: "p", jsonSchema: {}, pluginId: "p1" },
    { name: "deferred", description: "d", jsonSchema: {}, pluginId: "p1" },
  ]
  const discover = async (options: { alwaysLoad?: boolean; alwaysLoadToolNames?: string[] }) => {
    const server = buildPluginToolsServer({
      tools: manifest,
      emit: () => {},
      sessionId: "s",
      pendingPluginToolCalls: new Map(),
      ...options,
    })!
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "always-load", version: "1" })
    await server.instance.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const tools = (await client.listTools()).tools
      return Object.fromEntries(
        tools.map((entry) => [entry.name, entry._meta?.["anthropic/alwaysLoad"] === true])
      )
    } finally {
      await client.close()
      await server.instance.close()
    }
  }
  assert.deepEqual(await discover({ alwaysLoadToolNames: ["pinned"] }), {
    pinned: true,
    deferred: false,
  })
  assert.deepEqual(await discover({ alwaysLoad: true }), { pinned: true, deferred: true })
})
