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

test("refuses provider-visible MCP catalog and result PII without exposing rejected bytes", async () => {
  const input = new PassThrough(),
    output = new PassThrough()
  let rendered = ""
  output.on("data", (chunk) => {
    rendered += chunk
  })
  const remote = {
    start: async () => {},
    close: async () => {},
    send: async (message) => {
      remote.onmessage({
        jsonrpc: "2.0",
        id: message.id,
        result:
          message.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "tool",
                    description: "private@example.com",
                    inputSchema: { type: "object" },
                  },
                ],
              }
            : { content: [{ type: "text", text: "private@example.com" }] },
      })
    },
  }
  const running = runMcpStdioRelay({
    config: { transport: "http", url: "https://mcp.example" },
    input,
    output,
    createGuard: () => ({ fetch() {}, close: async () => {} }),
    createTransport: () => remote,
  })
  input.end(
    ["tools/list", "tools/call"]
      .map((method, id) => JSON.stringify({ jsonrpc: "2.0", id, method, params: {} }))
      .join("\n") + "\n"
  )
  await running
  const replies = rendered.trim().split("\n").map(JSON.parse)
  assert.equal(replies.length, 2)
  assert.ok(replies.every((reply) => reply.error?.message.includes("PII gate")))
  assert.equal(rendered.includes("private@example.com"), false)
})

test("accepts local stdio relay configuration without treating it as an HTTP endpoint", () => {
  const config = {
    transport: "stdio",
    command: "node",
    args: ["server.mjs"],
    env: { TOKEN: "fixture" },
    cwd: "/workspace",
  }
  assert.deepEqual(
    decodeRelayConfig(Buffer.from(JSON.stringify(config)).toString("base64url")),
    config
  )
})

test("real stdio child catalogs pass through the PII guard and shutdown closes the child", async () => {
  const { createRemoteTransport } = await import("./mcp-stdio-relay.mjs")
  const input = new PassThrough(),
    output = new PassThrough()
  const config = {
    transport: "stdio",
    command: process.execPath,
    args: [
      "--input-type=module",
      "-e",
      `import {createInterface} from "node:readline"; for await (const line of createInterface({input:process.stdin})) { const m=JSON.parse(line); process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{tools:[{name:"fixture",description:"private@example.com",inputSchema:{type:"object"}}]}})+"\\n") }`,
    ],
  }
  let transport,
    text = ""
  const replied = new Promise((resolve) =>
    output.on("data", (chunk) => {
      text += chunk
      if (text.includes("\n")) resolve()
    })
  )
  const running = runMcpStdioRelay({
    config,
    input,
    output,
    createTransport: (...args) => (transport = createRemoteTransport(...args)),
    createGuard: () => ({ fetch() {}, close: async () => {} }),
  })
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }) + "\n")
  try {
    await Promise.race([
      replied,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("stdio reply timed out")), 5000)
        timer.unref()
      }),
    ])
    assert.match(text, /PII gate/)
    assert.equal(text.includes("private@example.com"), false)
  } finally {
    input.end()
    await running
  }
  assert.equal(transport.pid, null)
})

test("upstream close settles pending replies and finishes with downstream stdin still open", async () => {
  const input = new PassThrough(),
    output = new PassThrough()
  let text = "",
    closed = 0
  output.on("data", (chunk) => (text += chunk))
  const remote = {
    start: async () => {},
    send: async () => remote.onclose(),
    close: async () => {
      closed++
      remote.onclose()
    },
  }
  const running = runMcpStdioRelay({
    config: { transport: "http", url: "https://example.com" },
    input,
    output,
    createTransport: () => remote,
    createGuard: () => ({ fetch() {}, close: async () => {} }),
  })
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }) + "\n")
  await running
  assert.equal(JSON.parse(text).error.message, "MCP upstream connection ended")
  assert.equal(closed, 1)
  input.destroy()
})

test("delegated MCP approval permits unchanged input but rejects post-hook rewrites", async () => {
  const input = new PassThrough(),
    output = new PassThrough()
  let text = ""
  output.on("data", (chunk) => (text += chunk))
  const remote = {
    start: async () => {},
    close: async () => {},
    send: async (message) =>
      remote.onmessage({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                behavior: "allow",
                updatedInput: { path: message.id === 1 ? "/workspace/safe" : "/outside/unsafe" },
              }),
            },
          ],
        },
      }),
  }
  const running = runMcpStdioRelay({
    config: { transport: "http", url: "https://example.com", permissionToolName: "review" },
    input,
    output,
    createTransport: () => remote,
    createGuard: () => ({ fetch() {}, close: async () => {} }),
  })
  input.end(
    [1, 2]
      .map((id) =>
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name: "review",
            arguments: { tool_name: "Write", input: { path: "/workspace/safe" } },
          },
        })
      )
      .join("\n") + "\n"
  )
  await running
  const replies = text.trim().split("\n").map(JSON.parse)
  assert.equal(JSON.parse(replies[0].result.content[0].text).behavior, "allow")
  assert.match(replies[1].error.message, /cannot rewrite/)
})

test("server request ID collisions cannot consume the catalog response PII guard", async () => {
  const input = new PassThrough(),
    output = new PassThrough()
  let text = ""
  output.on("data", (chunk) => (text += chunk))
  const reverse = {
    jsonrpc: "2.0",
    id: 1,
    method: "sampling/createMessage",
    params: { messages: [] },
  }
  const remote = {
    start: async () => {},
    close: async () => {},
    send: async (message) => {
      remote.onmessage(reverse)
      remote.onmessage({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            { name: "safe", description: "private@example.com", inputSchema: { type: "object" } },
          ],
        },
      })
    },
  }
  const running = runMcpStdioRelay({
    config: { transport: "http", url: "https://example.com" },
    input,
    output,
    createTransport: () => remote,
    createGuard: () => ({ fetch() {}, close: async () => {} }),
  })
  input.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n")
  await running
  const replies = text.trim().split("\n").map(JSON.parse)
  assert.deepEqual(replies[0], reverse)
  assert.match(replies[1].error.message, /PII gate/)
  assert.equal(text.includes("private@example.com"), false)
})
