// Tests for the first-connection MCP auto-reconnector (Anthropic path).

import { test } from "node:test"
import assert from "node:assert/strict"
import { extractFailedMcpServers, createMcpAutoReconnector } from "./mcp-auto-reconnect.mjs"

const initEvent = (servers) => ({ type: "system", subtype: "init", mcp_servers: servers })
const tick = () => new Promise((r) => setImmediate(r))

test("extractFailedMcpServers picks only failed servers from the init event", () => {
  const evt = initEvent([
    { name: "a", status: "connected" },
    { name: "b", status: "failed" },
    { name: "c", status: "needs-auth" },
    { name: "d", status: "pending" },
    { status: "failed" }, // nameless → ignored
  ])
  assert.deepEqual(extractFailedMcpServers(evt), ["b"])
})

test("extractFailedMcpServers ignores non-init events and malformed shapes", () => {
  assert.deepEqual(extractFailedMcpServers(undefined), [])
  assert.deepEqual(extractFailedMcpServers({ type: "assistant" }), [])
  assert.deepEqual(extractFailedMcpServers({ type: "system", subtype: "status" }), [])
  assert.deepEqual(extractFailedMcpServers({ type: "system", subtype: "init" }), [])
  assert.deepEqual(
    extractFailedMcpServers({ type: "system", subtype: "init", mcp_servers: "nope" }),
    []
  )
})

test("auto-reconnector reconnects each failed server exactly once", async () => {
  const reconnected = []
  const r = createMcpAutoReconnector({
    reconnect: async (name) => reconnected.push(name),
    delayMs: 0,
  })
  r.onEvent(
    initEvent([
      { name: "cold", status: "failed" },
      { name: "ok", status: "connected" },
    ])
  )
  // A second init report (e.g. after resume) must not re-spend the budget.
  r.onEvent(initEvent([{ name: "cold", status: "failed" }]))
  await tick()
  assert.deepEqual(reconnected, ["cold"])
  assert.deepEqual(r.attempted(), ["cold"])
})

test("auto-reconnector does not touch needs-auth servers", async () => {
  const reconnected = []
  const r = createMcpAutoReconnector({
    reconnect: async (name) => reconnected.push(name),
    delayMs: 0,
  })
  r.onEvent(initEvent([{ name: "oauth", status: "needs-auth" }]))
  await tick()
  assert.deepEqual(reconnected, [])
})

test("auto-reconnector logs + diagnoses a reconnect failure without throwing", async () => {
  const logs = []
  const diags = []
  const r = createMcpAutoReconnector({
    reconnect: async () => {
      throw new Error("still down")
    },
    log: (lvl, msg) => logs.push(`${lvl}:${msg}`),
    emitMcpLog: (e) => diags.push(e),
    delayMs: 0,
  })
  r.onEvent(initEvent([{ name: "bad", status: "failed" }]))
  await tick()
  assert.ok(logs.some((l) => l.startsWith("warn:") && l.includes("still down")))
  assert.ok(
    diags.some((d) => d.server === "bad" && d.level === "warn" && /still down/.test(d.message))
  )
})

test("auto-reconnector emits diagnostics on the success path", async () => {
  const diags = []
  const r = createMcpAutoReconnector({
    reconnect: async () => {},
    emitMcpLog: (e) => diags.push(e),
    delayMs: 0,
  })
  r.onEvent(initEvent([{ name: "cold", status: "failed" }]))
  await tick()
  assert.ok(diags.some((d) => d.server === "cold" && /auto-reconnecting/.test(d.message)))
  assert.ok(diags.some((d) => d.server === "cold" && /auto-reconnect issued/.test(d.message)))
})

test("auto-reconnector waits delayMs before reconnecting", async () => {
  let reconnectedAt = 0
  const start = Date.now()
  const r = createMcpAutoReconnector({
    reconnect: async () => {
      reconnectedAt = Date.now()
    },
    delayMs: 25,
  })
  r.onEvent(initEvent([{ name: "cold", status: "failed" }]))
  await new Promise((res) => setTimeout(res, 60))
  assert.ok(reconnectedAt - start >= 20, "reconnect delayed by ~delayMs")
})

test("maxPerServer > 1 allows a second attempt on a later init report", async () => {
  const reconnected = []
  const r = createMcpAutoReconnector({
    reconnect: async (name) => reconnected.push(name),
    delayMs: 0,
    maxPerServer: 2,
  })
  r.onEvent(initEvent([{ name: "cold", status: "failed" }]))
  await tick()
  r.onEvent(initEvent([{ name: "cold", status: "failed" }]))
  await tick()
  r.onEvent(initEvent([{ name: "cold", status: "failed" }]))
  await tick()
  assert.deepEqual(reconnected, ["cold", "cold"])
})
