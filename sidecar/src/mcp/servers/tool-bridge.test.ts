import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { fakeSocket, scriptedBroker } from "../../../test-support/mcp-broker.ts"
function firstText(result: CallToolResult) {
  const block = result.content[0]
  assert.ok(block?.type === "text")
  return block.text
}
import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { z } from "zod"

import {
  buildToolSurface,
  runToolBridge,
  toMcpContent,
  toolInputJsonSchema,
} from "./tool-bridge.ts"

test("toolInputJsonSchema converts a zod raw shape into an object schema", () => {
  const schema = toolInputJsonSchema({ file_path: z.string(), limit: z.number().optional() })
  assert.equal(schema.type, "object")
  assert.ok((schema.properties as Record<string, unknown>).file_path)
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
  const seen: string[] = []
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
  assert.deepEqual(await tools[0]!.run({ q: "?" }), {
    content: [{ type: "text", text: "ran ask_user" }],
  })
  assert.deepEqual(seen, ["exec"])
})

test("a host tool surfaces the broker's execution authorization denial", async () => {
  const seen: string[] = []
  const { broker } = scriptedBroker((method) => {
    seen.push(method)
    return method === "exec" ? { error: "denied by policy" } : {}
  })
  const tools = buildToolSurface(
    "cognia-plugin-tools",
    { hostTools: [{ name: "web_search", description: "", jsonSchema: {} }] },
    broker
  )
  const result = await tools[0]!.run({})
  assert.equal(result.isError, true)
  assert.match(firstText(result), /denied by policy/)
  assert.deepEqual(seen, ["exec"])
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
  assert.equal((tools[0]!.inputSchema as Record<string, unknown>).type, "object")
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
  const result = await tools[0]!.run({})
  assert.equal(result.isError, true)
  assert.match(firstText(result), /outside the workspace/)
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
  const input = new (class extends EventEmitter {
    setEncoding() {}
  })()
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
  assert.ok(socket.writes[0]!.includes('"token":"tok"'))
})

test("builtin execution applies rewritten args and host review before model output", async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const { broker } = scriptedBroker((method, params) => {
    calls.push({ method, params })
    if (method === "authorize")
      return { allow: true, updatedArgs: { file_path: "/nonexistent-cognia-fixture" } }
    if (method === "review")
      return { result: { content: [{ type: "text", text: "Reviewed: fixture@example.com" }] } }
    return {}
  })
  const tools = buildToolSurface(
    "cognia-tools",
    {
      cwd: process.cwd(),
      enabledCategories: { coreFiles: true },
      visibleBuiltinTools: ["read"],
      model: "m",
      provider: "p",
    },
    broker
  )
  const result = await tools.find((tool) => tool.name === "read")!.run({ file_path: "/original" })
  assert.deepEqual(
    calls.map((call) => call.method),
    ["authorize", "review", "report"]
  )
  assert.equal(
    (calls[1]!.params.args as Record<string, unknown>).file_path,
    "/nonexistent-cognia-fixture"
  )
  assert.match(firstText(result), /Reviewed/)
  assert.doesNotMatch(JSON.stringify(result), /fixture@example.com/)
})
