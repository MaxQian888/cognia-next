import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { createMcpStdioServer } from "./stdio-server.ts"
import type { StdioTool, StdioRequest } from "./stdio-server.ts"
interface RpcReply {
  result: {
    protocolVersion: string
    serverInfo: { name: string }
    capabilities: { tools: object }
    tools: StdioTool[]
    content: { text: string }[]
    isError: boolean
  }
  error: { code: number; message: string }
}
/** Drive the MCP stdio server with scripted JSON-RPC lines. */
function mcpHarness(tools: StdioTool[]) {
  const input = new (class extends EventEmitter {
    setEncoding() {}
  })()
  const written: RpcReply[] = []
  const output = { write: (line: string) => written.push(JSON.parse(line)) }
  createMcpStdioServer({ serverName: "cognia-tools", tools, input, output })
  return {
    send: (message: StdioRequest) => input.emit("data", `${JSON.stringify(message)}\n`),
    raw: (text: string) => input.emit("data", text),
    written,
  }
}

test("MCP initialize advertises the tools capability and the server name", () => {
  const h = mcpHarness([])
  h.send({ jsonrpc: "2.0", id: 1, method: "initialize" })
  assert.equal(h.written[0]!.result.serverInfo.name, "cognia-tools")
  assert.deepEqual(h.written[0]!.result.capabilities, { tools: {} })
  assert.equal(h.written[0]!.result.protocolVersion, "2025-11-25")
})

test("MCP tools/list returns name, description and schema", () => {
  const h = mcpHarness([
    {
      name: "read",
      description: "read a file",
      inputSchema: { type: "object" },
      run: async () => ({}),
    },
  ])
  h.send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
  assert.deepEqual(h.written[0]!.result.tools, [
    { name: "read", description: "read a file", inputSchema: { type: "object" } },
  ])
})

test("MCP tools/call forwards the arguments and returns the tool result", async () => {
  const seen: unknown[] = []
  const h = mcpHarness([
    {
      name: "read",
      description: "",
      inputSchema: {},
      run: async (args) => {
        seen.push(args)
        return { content: [{ type: "text", text: "body" }] }
      },
    },
  ])
  h.send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "read", arguments: { p: 1 } },
  })
  await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(seen, [{ p: 1 }])
  assert.deepEqual(h.written[0]!.result.content, [{ type: "text", text: "body" }])
})

test("an unknown tool is a tool error, not a protocol error", async () => {
  const h = mcpHarness([])
  h.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "ghost" } })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(h.written[0]!.result.isError, true)
  assert.match(h.written[0]!.result.content[0]!.text, /unknown tool/)
})

test("a transport fault surfaces as a tool error so the agent keeps the turn", async () => {
  const h = mcpHarness([
    {
      name: "read",
      description: "",
      inputSchema: {},
      run: async () => {
        throw new Error("cognia tool host closed the connection")
      },
    },
  ])
  h.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "read" } })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(h.written[0]!.result.isError, true)
  assert.match(h.written[0]!.result.content[0]!.text, /closed the connection/)
})

test("notifications are never answered", () => {
  const h = mcpHarness([])
  h.send({ jsonrpc: "2.0", method: "notifications/initialized" })
  assert.deepEqual(h.written, [])
})

test("an unknown method is a JSON-RPC method-not-found", () => {
  const h = mcpHarness([])
  h.send({ jsonrpc: "2.0", id: 6, method: "resources/list" })
  assert.equal(h.written[0]!.error.code, -32601)
})

test("ping is answered so a client health check does not time out", () => {
  const h = mcpHarness([])
  h.send({ jsonrpc: "2.0", id: 7, method: "ping" })
  assert.deepEqual(h.written[0]!.result, {})
})

test("an unparsable stdin line reports a parse error without killing the loop", () => {
  const h = mcpHarness([])
  h.raw("garbage\n")
  h.send({ jsonrpc: "2.0", id: 8, method: "ping" })
  assert.equal(h.written[0]!.error.code, -32700)
  assert.deepEqual(h.written[1]!.result, {})
})
