// Tests for the external-MCP bridge on the non-Anthropic dispatch path.
// A fake client factory is injected so no real MCP server is spawned/connected.

import { test } from "node:test"
import assert from "node:assert/strict"
import { PassThrough } from "node:stream"
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
  const attempts = {}
  // Per-url failure so the retry never accidentally rescues the down server.
  const createClient = async ({ transport }) => {
    attempts[transport.url] = (attempts[transport.url] ?? 0) + 1
    if (transport.url === "https://down") throw new Error("ECONNREFUSED")
    return { tools: async () => ({ ok: { execute: async () => "ok" } }), close: async () => {} }
  }
  const { tools } = await buildAiSdkMcpTools({
    mcpServers: {
      bad: { type: "sse", url: "https://down" },
      good: { type: "sse", url: "https://up" },
    },
    createClient,
    log,
    retryDelayMs: 0,
  })
  assert.equal(tools["mcp__good__ok"] !== undefined, true, "healthy server still bridged")
  assert.ok(
    warnings.some((w) => w.includes('mcp "bad" failed to connect')),
    "bad server logged after both attempts"
  )
  // The down server exhausted all three attempts before giving up.
  assert.equal(attempts["https://down"], 3, "connect retried until maxAttempts")
  assert.equal(attempts["https://up"], 1, "healthy server connected on the first attempt")
})

test("buildAiSdkMcpTools recovers a server that fails once then connects (retry)", async () => {
  let attempts = 0
  const createClient = async () => {
    attempts++
    if (attempts === 1) throw new Error("cold start")
    return { tools: async () => ({ ping: { execute: async () => "pong" } }), close: async () => {} }
  }
  const { tools } = await buildAiSdkMcpTools({
    mcpServers: { flaky: { type: "http", url: "https://cold" } },
    createClient,
    retryDelayMs: 0,
  })
  assert.equal(attempts, 2, "connected on the retry")
  assert.ok(tools["mcp__flaky__ping"], "transiently-failing server recovered on retry")
})

test("buildAiSdkMcpTools recovers a server that fails twice then connects (backoff)", async () => {
  let attempts = 0
  const createClient = async () => {
    attempts++
    if (attempts <= 2) throw new Error("still cold")
    return { tools: async () => ({ ping: { execute: async () => "pong" } }), close: async () => {} }
  }
  const { tools } = await buildAiSdkMcpTools({
    mcpServers: { flaky: { type: "http", url: "https://cold" } },
    createClient,
    retryDelayMs: 0,
  })
  assert.equal(attempts, 3, "third attempt connected")
  assert.ok(tools["mcp__flaky__ping"], "recovered on the last attempt")
})

test("buildAiSdkMcpTools caps a hung connect with connectTimeoutMs and closes the late client", async () => {
  const warnings = []
  let lateClosed = false
  // Never-yielding connect that eventually resolves AFTER the timeout.
  const createClient = () =>
    new Promise((resolve) =>
      setTimeout(
        () => resolve({ tools: async () => ({}), close: async () => (lateClosed = true) }),
        40
      )
    )
  const { tools } = await buildAiSdkMcpTools({
    mcpServers: { hung: { type: "http", url: "https://hang" } },
    createClient,
    log: (lvl, msg) => warnings.push(msg),
    retryDelayMs: 0,
    maxAttempts: 1,
    connectTimeoutMs: 10,
  })
  assert.deepEqual(Object.keys(tools), [], "hung server contributes no tools")
  assert.ok(
    warnings.some((w) => w.includes("timed out")),
    "timeout surfaced in the log"
  )
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(lateClosed, true, "late-resolving client torn down (no socket leak)")
})

test("buildAiSdkMcpTools connects servers concurrently (a slow one does not block)", async () => {
  const order = []
  const createClient = async ({ transport }) => {
    order.push(`start:${transport.url}`)
    // The "slow" server resolves last; a serial impl would push its start only
    // after "fast" fully finished — concurrent starts interleave.
    const delay = transport.url === "https://slow" ? 30 : 0
    await new Promise((r) => setTimeout(r, delay))
    order.push(`done:${transport.url}`)
    return { tools: async () => ({ t: { execute: async () => "x" } }), close: async () => {} }
  }
  const { tools } = await buildAiSdkMcpTools({
    mcpServers: {
      slow: { type: "sse", url: "https://slow" },
      fast: { type: "sse", url: "https://fast" },
    },
    createClient,
  })
  assert.ok(tools["mcp__slow__t"] && tools["mcp__fast__t"], "both bridged")
  // Both connects START before either finishes → concurrency (not serial).
  assert.deepEqual(order.slice(0, 2), ["start:https://slow", "start:https://fast"])
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

test("toMcpTransport wires a provided stderr stream into the stdio config", () => {
  const s = new PassThrough()
  const t = toMcpTransport(
    { type: "stdio", command: "node" },
    { StdioTransport: FakeStdio, stderr: s }
  )
  assert.equal(t.cfg.stderr, s, "stderr stream forwarded to the transport config")
})

test("buildAiSdkMcpTools captures stdio server stderr into emitMcpLog", async () => {
  const logs = []
  let stderrStream = null
  const createClient = async ({ transport }) => {
    stderrStream = transport.cfg.stderr // the PassThrough wired by toMcpTransport
    return { tools: async () => ({ ping: { execute: async () => "pong" } }), close: async () => {} }
  }
  const { close } = await buildAiSdkMcpTools({
    mcpServers: { fs: { type: "stdio", command: "node" } },
    createClient,
    StdioTransport: FakeStdio,
    emitMcpLog: (e) => logs.push(e),
  })
  assert.ok(stderrStream, "stderr stream wired for stdio server")
  stderrStream.write("[error] boom\nwarn: slow\n")
  await new Promise((r) => setImmediate(r))
  const err = logs.find((l) => l.source === "stderr" && l.level === "error")
  assert.ok(err, "stderr error line captured as an mcp_log")
  assert.equal(err.server, "fs")
  assert.equal(err.message, "[error] boom")
  assert.ok(
    logs.some((l) => l.source === "stderr" && l.level === "warn"),
    "stderr warn line captured too"
  )
  // A successful connect also emits a diagnostic summary.
  assert.ok(logs.some((l) => l.source === "diagnostic" && /connected/.test(l.message)))
  await close()
})

test("buildAiSdkMcpTools emits a diagnostic mcp_log when a server fails to connect", async () => {
  const logs = []
  const createClient = async () => {
    throw new Error("ECONNREFUSED")
  }
  await buildAiSdkMcpTools({
    mcpServers: { bad: { type: "sse", url: "https://down" } },
    createClient,
    emitMcpLog: (e) => logs.push(e),
    retryDelayMs: 0,
  })
  const d = logs.find((l) => l.source === "diagnostic" && /failed to connect/.test(l.message))
  assert.ok(d, "connect failure surfaced as a diagnostic mcp_log")
  assert.equal(d.server, "bad")
  assert.equal(d.level, "warn")
})

test("stdio transport has no stderr stream when no emitMcpLog sink is supplied", async () => {
  let cfg = null
  const createClient = async ({ transport }) => {
    cfg = transport.cfg
    return { tools: async () => ({}), close: async () => {} }
  }
  await buildAiSdkMcpTools({
    mcpServers: { fs: { type: "stdio", command: "node" } },
    createClient,
    StdioTransport: FakeStdio,
  })
  assert.equal(cfg.stderr, undefined, "no stderr stream spawned without a log sink")
})
