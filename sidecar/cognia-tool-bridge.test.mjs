import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { z } from "zod"

import {
  buildToolSurface,
  connectBroker,
  createMcpStdioServer,
  runToolBridge,
  toMcpContent,
  toolInputJsonSchema,
} from "./cognia-tool-bridge.mjs"

/** A fake socket the broker helper can drive both ways. */
function fakeSocket() {
  const socket = new EventEmitter()
  socket.writes = []
  socket.readyState = "open"
  socket.setEncoding = () => {}
  socket.write = (chunk) => {
    socket.writes.push(chunk)
    return true
  }
  socket.destroy = () => socket.emit("close")
  return socket
}

/** A broker that answers every request with `answer(method, params)`. */
function scriptedBroker(answer) {
  const socket = fakeSocket()
  const broker = connectBroker("/ignored", { connect: () => socket })
  socket.write = (chunk) => {
    socket.writes.push(chunk)
    for (const line of chunk.split("\n").filter(Boolean)) {
      const request = JSON.parse(line)
      queueMicrotask(() => {
        const result = answer(request.method, request.params)
        socket.emit("data", `${JSON.stringify({ id: request.id, result })}\n`)
      })
    }
    return true
  }
  return { broker, socket }
}

test("connectBroker resolves a call with the matching response id", async () => {
  const { broker } = scriptedBroker((method) => ({ echoed: method }))
  assert.deepEqual(await broker.call("hello", {}), { echoed: "hello" })
})

test("connectBroker rejects every pending call when Cognia goes away", async () => {
  const socket = fakeSocket()
  const broker = connectBroker("/ignored", { connect: () => socket })
  const pending = broker.call("authorize", {})
  socket.emit("close")
  await assert.rejects(pending, /closed the connection/)
})

test("connectBroker rejects a malformed frame rather than guessing", async () => {
  const socket = fakeSocket()
  const broker = connectBroker("/ignored", { connect: () => socket })
  const pending = broker.call("authorize", {})
  socket.emit("data", "garbage\n")
  await assert.rejects(pending, /malformed frame/)
})

test("connectBroker surfaces a broker-side error as a rejection", async () => {
  const socket = fakeSocket()
  const broker = connectBroker("/ignored", { connect: () => socket })
  socket.write = (chunk) => {
    const { id } = JSON.parse(chunk)
    queueMicrotask(() => socket.emit("data", `${JSON.stringify({ id, error: "unauthorized" })}\n`))
    return true
  }
  await assert.rejects(broker.call("hello", {}), /unauthorized/)
})

test("toolInputJsonSchema converts a zod raw shape into an object schema", () => {
  const schema = toolInputJsonSchema({ file_path: z.string(), limit: z.number().optional() })
  assert.equal(schema.type, "object")
  assert.ok(schema.properties.file_path)
  assert.deepEqual(schema.required, ["file_path"])
})

test("toolInputJsonSchema degrades to an empty object schema for anything unusable", () => {
  assert.deepEqual(toolInputJsonSchema(undefined), { type: "object", properties: {} })
  assert.deepEqual(toolInputJsonSchema("nope"), { type: "object", properties: {} })
})

test("toMcpContent passes through SDK content and flags errors", () => {
  assert.deepEqual(toMcpContent({ content: [{ type: "text", text: "hi" }], isError: true }), {
    content: [{ type: "text", text: "hi" }],
    isError: true,
  })
  assert.deepEqual(toMcpContent("plain"), { content: [{ type: "text", text: "plain" }] })
  assert.deepEqual(toMcpContent(null), { content: [{ type: "text", text: "null" }] })
})

test("host tools advertise Cognia's manifest and execute over the broker", async () => {
  const seen = []
  const { broker } = scriptedBroker((method, params) => {
    seen.push(method)
    if (method === "authorize") return { allow: true }
    if (method === "exec") return { result: `ran ${params.name}` }
    return {}
  })
  const tools = buildToolSurface(
    "cognia-plugin-tools",
    {
      hostTools: [{ name: "ask_user", description: "ask", jsonSchema: { type: "object" } }],
    },
    broker
  )
  assert.deepEqual(
    tools.map((t) => t.name),
    ["ask_user"]
  )
  assert.deepEqual(await tools[0].run({ q: "?" }), {
    content: [{ type: "text", text: "ran ask_user" }],
  })
  assert.deepEqual(seen, ["authorize", "exec"])
})

test("a host tool refused by Cognia never reaches exec", async () => {
  const seen = []
  const { broker } = scriptedBroker((method) => {
    seen.push(method)
    return method === "authorize" ? { allow: false, reason: "denied by policy" } : {}
  })
  const tools = buildToolSurface(
    "cognia-plugin-tools",
    { hostTools: [{ name: "web_search", description: "", jsonSchema: {} }] },
    broker
  )
  const result = await tools[0].run({})
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /denied by policy/)
  assert.deepEqual(seen, ["authorize"])
})

test("built-in tools are filtered to the names Cognia said are visible", () => {
  const { broker } = scriptedBroker(() => ({ allow: true }))
  const tools = buildToolSurface(
    "cognia-tools",
    {
      cwd: process.cwd(),
      enabledCategories: { git: true },
      visibleBuiltinTools: ["git_status"],
      model: "m",
      provider: "p",
    },
    broker
  )
  assert.deepEqual(
    tools.map((t) => t.name),
    ["git_status"]
  )
  assert.equal(tools[0].inputSchema.type, "object")
})

test("a built-in refused by Cognia is never handed to its handler", async () => {
  const { broker } = scriptedBroker(() => ({ allow: false, reason: "outside the workspace" }))
  const tools = buildToolSurface(
    "cognia-tools",
    {
      cwd: process.cwd(),
      enabledCategories: { git: true },
      visibleBuiltinTools: ["git_status"],
      model: "m",
      provider: "p",
    },
    broker
  )
  const result = await tools[0].run({})
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /outside the workspace/)
})

/** Drive the MCP stdio server with scripted JSON-RPC lines. */
function mcpHarness(tools) {
  const input = new EventEmitter()
  input.setEncoding = () => {}
  const written = []
  const output = { write: (line) => written.push(JSON.parse(line)) }
  createMcpStdioServer({ serverName: "cognia-tools", tools, input, output })
  return {
    send: (message) => input.emit("data", `${JSON.stringify(message)}\n`),
    raw: (text) => input.emit("data", text),
    written,
  }
}

test("MCP initialize advertises the tools capability and the server name", () => {
  const h = mcpHarness([])
  h.send({ jsonrpc: "2.0", id: 1, method: "initialize" })
  assert.equal(h.written[0].result.serverInfo.name, "cognia-tools")
  assert.deepEqual(h.written[0].result.capabilities, { tools: {} })
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
  assert.deepEqual(h.written[0].result.tools, [
    { name: "read", description: "read a file", inputSchema: { type: "object" } },
  ])
})

test("MCP tools/call forwards the arguments and returns the tool result", async () => {
  const seen = []
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
  assert.deepEqual(h.written[0].result.content, [{ type: "text", text: "body" }])
})

test("an unknown tool is a tool error, not a protocol error", async () => {
  const h = mcpHarness([])
  h.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "ghost" } })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(h.written[0].result.isError, true)
  assert.match(h.written[0].result.content[0].text, /unknown tool/)
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
  assert.equal(h.written[0].result.isError, true)
  assert.match(h.written[0].result.content[0].text, /closed the connection/)
})

test("notifications are never answered", () => {
  const h = mcpHarness([])
  h.send({ jsonrpc: "2.0", method: "notifications/initialized" })
  assert.deepEqual(h.written, [])
})

test("an unknown method is a JSON-RPC method-not-found", () => {
  const h = mcpHarness([])
  h.send({ jsonrpc: "2.0", id: 6, method: "resources/list" })
  assert.equal(h.written[0].error.code, -32601)
})

test("ping is answered so a client health check does not time out", () => {
  const h = mcpHarness([])
  h.send({ jsonrpc: "2.0", id: 7, method: "ping" })
  assert.deepEqual(h.written[0].result, {})
})

test("an unparsable stdin line reports a parse error without killing the loop", () => {
  const h = mcpHarness([])
  h.raw("garbage\n")
  h.send({ jsonrpc: "2.0", id: 8, method: "ping" })
  assert.equal(h.written[0].error.code, -32700)
  assert.deepEqual(h.written[1].result, {})
})

test("runToolBridge refuses to start without an endpoint and token", async () => {
  await assert.rejects(runToolBridge({ env: {} }), /COGNIA_TOOLHOST_SOCKET/)
})

test("runToolBridge handshakes with the token and builds the advertised surface", async () => {
  const socket = fakeSocket()
  socket.write = (chunk) => {
    socket.writes.push(chunk)
    for (const line of chunk.split("\n").filter(Boolean)) {
      const request = JSON.parse(line)
      queueMicrotask(() =>
        socket.emit(
          "data",
          `${JSON.stringify({
            id: request.id,
            result: {
              session: {
                hostTools: [{ name: "ask_user", description: "", jsonSchema: {} }],
              },
            },
          })}\n`
        )
      )
    }
    return true
  }
  const input = new EventEmitter()
  input.setEncoding = () => {}
  const { tools } = await runToolBridge({
    env: {
      COGNIA_TOOLHOST_SOCKET: "/tmp/x.sock",
      COGNIA_TOOLHOST_TOKEN: "tok",
      COGNIA_TOOLHOST_SERVER: "cognia-plugin-tools",
    },
    input,
    output: { write: () => {} },
    connect: () => socket,
  })
  assert.deepEqual(
    tools.map((t) => t.name),
    ["ask_user"]
  )
  assert.ok(socket.writes[0].includes('"token":"tok"'))
})
