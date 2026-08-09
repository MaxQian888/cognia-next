import test from "node:test"
import assert from "node:assert/strict"
import { PassThrough } from "node:stream"

import { decodeRelayConfig, runMcpStdioRelay } from "./mcp-stdio-relay.mjs"

test("decodes only supported remote relay definitions", () => {
  const encoded = Buffer.from(
    JSON.stringify({ transport: "http", url: "https://mcp.example/rpc" })
  ).toString("base64url")
  assert.deepEqual(decodeRelayConfig(encoded), {
    transport: "http",
    url: "https://mcp.example/rpc",
  })
  assert.throws(() => decodeRelayConfig("bad"), /invalid MCP relay configuration/)
})

test("relays JSON-RPC and applies the negotiated protocol version", async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  let rendered = ""
  output.on("data", (chunk) => {
    rendered += chunk.toString()
  })
  const calls = []
  const remote = {
    start: async () => calls.push("start"),
    send: async (message) => {
      calls.push(["send", message])
      remote.onmessage({
        jsonrpc: "2.0",
        id: message.id,
        result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: {} },
      })
    },
    setProtocolVersion: (version) => calls.push(["protocol", version]),
    close: async () => calls.push("remote.close"),
  }
  const guard = { fetch: async () => new Response(), close: async () => calls.push("guard.close") }

  const running = runMcpStdioRelay({
    config: { transport: "http", url: "https://mcp.example/rpc" },
    input,
    output,
    createGuard: () => guard,
    createTransport: () => remote,
  })
  input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`)
  await running

  assert.equal(rendered.includes('"protocolVersion":"2025-11-25"'), true)
  assert.deepEqual(calls, [
    "start",
    ["send", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }],
    ["protocol", "2025-11-25"],
    "remote.close",
    "guard.close",
  ])
})

