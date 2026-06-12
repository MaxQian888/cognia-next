// Tests for the external-MCP bridge on the non-Anthropic dispatch path.
// A fake client factory is injected so no real MCP server is spawned/connected.

import { test } from "node:test"
import assert from "node:assert/strict"
import { buildAiSdkMcpTools, toMcpTransport, wrapMcpToolWithGate } from "./ai-sdk-mcp.mjs"

// A no-op stdio transport stand-in so toMcpTransport doesn't construct the real
// (process-spawning) one in unit tests.
class FakeStdio {
  constructor(cfg) {
    this.cfg = cfg
  }
}

// A fake AI SDK MCP client: returns a fixed tools map; records close().
function fakeClientFactory(toolsByServer) {
  let callIndex = 0
  const servers = Object.keys(toolsByServer)
  return {
    closed: [],
    create({ transport }) {
      const server = servers[callIndex++]
      const closedRef = this.closed
      return Promise.resolve({
        tools: async () => toolsByServer[server],
        close: async () => closedRef.push(server),
        __transport: transport,
      })
    },
  }
}

test("toMcpTransport builds a stdio transport from command/args/env", () => {
  const t = toMcpTransport(
    { type: "stdio", command: "node", args: ["server.js"], env: { K: "v" } },
    { StdioTransport: FakeStdio }
  )
  assert.ok(t instanceof FakeStdio)
  assert.equal(t.cfg.command, "node")
  assert.deepEqual(t.cfg.args, ["server.js"])
  assert.deepEqual(t.cfg.env, { K: "v" })
})

test("toMcpTransport builds sse/http config objects and rejects bad entries", () => {
  assert.deepEqual(toMcpTransport({ type: "sse", url: "https://x/sse" }), {
    type: "sse",
    url: "https://x/sse",
  })
  assert.deepEqual(
    toMcpTransport({ type: "http", url: "https://x/mcp", headers: { Authorization: "Bearer t" } }),
    { type: "http", url: "https://x/mcp", headers: { Authorization: "Bearer t" } }
  )
  assert.equal(toMcpTransport({ type: "stdio" }, { StdioTransport: FakeStdio }), null, "no command")
  assert.equal(toMcpTransport({ type: "sse" }), null, "no url")
  assert.equal(toMcpTransport({ type: "carrier-pigeon", url: "x" }), null, "unknown type")
  assert.equal(toMcpTransport(undefined), null)
})

test("buildAiSdkMcpTools namespaces tools as mcp__<server>__<tool>", async () => {
  const fake = fakeClientFactory({
    docs: { search: { description: "d", execute: async () => "hit" } },
  })
  const { tools, close } = await buildAiSdkMcpTools({
    mcpServers: { docs: { type: "sse", url: "https://x/sse" } },
    createClient: (cfg) => fake.create(cfg),
    StdioTransport: FakeStdio,
  })
  assert.ok(tools["mcp__docs__search"], "tool namespaced by server")
  assert.equal(await tools["mcp__docs__search"].execute({ q: "hi" }), "hit")
  await close()
  assert.deepEqual(fake.closed, ["docs"], "close() disconnects the client")
})

test("buildAiSdkMcpTools gates execution: a deny ruleset blocks the tool", async () => {
  const fake = fakeClientFactory({
    sh: { run: { description: "", execute: async () => "ran" } },
  })
  // A gate that always denies (mirrors createToolPermissionGate's throw-on-deny).
  const gate = async (name) => {
    throw new Error(`denied: ${name}`)
  }
  const { tools } = await buildAiSdkMcpTools({
    mcpServers: { sh: { type: "stdio", command: "sh" } },
    gate,
    createClient: (cfg) => fake.create(cfg),
    StdioTransport: FakeStdio,
  })
  await assert.rejects(tools["mcp__sh__run"].execute({}), /denied: mcp__sh__run/)
})

test("buildAiSdkMcpTools gate may rewrite the input before execute", async () => {
  let seen = null
  const fake = fakeClientFactory({
    s: { t: { description: "", execute: async (args) => ((seen = args), "ok") } },
  })
  const gate = async () => ({ rewritten: true })
  const { tools } = await buildAiSdkMcpTools({
    mcpServers: { s: { type: "sse", url: "https://x" } },
    gate,
    createClient: (cfg) => fake.create(cfg),
  })
  await tools["mcp__s__t"].execute({ original: true })
  assert.deepEqual(seen, { rewritten: true }, "gate's effective input reaches execute")
})

test("buildAiSdkMcpTools honours allow/deny (deny wins, whole-server allow)", async () => {
  const fake = fakeClientFactory({
    api: {
      read: { description: "", execute: async () => "r" },
      write: { description: "", execute: async () => "w" },
    },
  })
  const denied = await buildAiSdkMcpTools({
    mcpServers: { api: { type: "http", url: "https://x" } },
    disallowedTools: ["mcp__api__write"],
    createClient: (cfg) => fake.create(cfg),
  })
  assert.ok(denied.tools["mcp__api__read"])
  assert.equal(denied.tools["mcp__api__write"], undefined, "denied tool absent")

  const fake2 = fakeClientFactory({
    api: {
      read: { description: "", execute: async () => "r" },
      write: { description: "", execute: async () => "w" },
    },
  })
  const allowed = await buildAiSdkMcpTools({
    mcpServers: { api: { type: "http", url: "https://x" } },
    allowedTools: ["mcp__api"], // whole-server allow admits every tool
    createClient: (cfg) => fake2.create(cfg),
  })
  assert.ok(allowed.tools["mcp__api__read"] && allowed.tools["mcp__api__write"])

  const fake3 = fakeClientFactory({
    api: {
      read: { description: "", execute: async () => "r" },
      write: { description: "", execute: async () => "w" },
    },
  })
  const scoped = await buildAiSdkMcpTools({
    mcpServers: { api: { type: "http", url: "https://x" } },
    allowedTools: ["mcp__api__read"], // single-tool allow
    createClient: (cfg) => fake3.create(cfg),
  })
  assert.ok(scoped.tools["mcp__api__read"])
  assert.equal(scoped.tools["mcp__api__write"], undefined)
})

test("buildAiSdkMcpTools skips a server that fails to connect, keeps the rest", async () => {
  const warnings = []
  const log = (lvl, msg) => warnings.push(`${lvl}:${msg}`)
  let i = 0
  const createClient = async ({ transport }) => {
    i++
    if (i === 1) throw new Error("ECONNREFUSED")
    return { tools: async () => ({ ok: { execute: async () => "ok" } }), close: async () => {} }
  }
  const { tools } = await buildAiSdkMcpTools({
    mcpServers: {
      bad: { type: "sse", url: "https://down" },
      good: { type: "sse", url: "https://up" },
    },
    createClient,
    log,
  })
  assert.equal(tools["mcp__good__ok"] !== undefined, true, "healthy server still bridged")
  assert.ok(
    warnings.some((w) => w.includes('mcp "bad" failed to connect')),
    "bad server logged"
  )
})

test("buildAiSdkMcpTools skips a server whose tools() rejects", async () => {
  const warnings = []
  const createClient = async () => ({
    tools: async () => {
      throw new Error("timeout listing tools")
    },
    close: async () => {},
  })
  const { tools } = await buildAiSdkMcpTools({
    mcpServers: { flaky: { type: "http", url: "https://x" } },
    createClient,
    log: (lvl, msg) => warnings.push(msg),
  })
  assert.deepEqual(Object.keys(tools), [])
  assert.ok(warnings.some((w) => w.includes('mcp "flaky" tools() failed')))
})

test("buildAiSdkMcpTools with no servers returns an empty map and a no-op close", async () => {
  const a = await buildAiSdkMcpTools({ mcpServers: undefined })
  assert.deepEqual(Object.keys(a.tools), [])
  await a.close() // must not throw
  const b = await buildAiSdkMcpTools({ mcpServers: {} })
  assert.deepEqual(Object.keys(b.tools), [])
})

test("wrapMcpToolWithGate returns the tool unchanged when no gate is supplied", () => {
  const t = { description: "d", execute: async () => "x" }
  assert.equal(wrapMcpToolWithGate(t, "mcp__s__t", undefined), t)
})
