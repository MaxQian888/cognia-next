import test from "node:test"
import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createToolHostManager } from "./tool-host.mjs"

const identity = { leaseId: "renderer-lease-0123456789", ownerSessionId: "chat-owner" }
const options = {
  cwd: process.cwd(),
  builtinTools: { coreFiles: true },
  planTools: false,
  allowedTools: ["Read", "mcp__cognia-plugin-tools__echo"],
  pluginTools: [
    {
      name: "echo",
      description: "Echo",
      jsonSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
    },
  ],
}
async function setup(t, configuration = {}) {
  const events = []
  const host = createToolHostManager({
    emit: (event) => {
      events.push(event)
      if (event.event.type === "tool_host_pre_tool" && configuration.autoPreflight !== false) {
        host.reply({
          ...identity,
          generation: event.generation,
          kind: "preflight",
          id: event.event.requestId,
          result: { action: "allow" },
        })
      }
    },
    ...configuration,
  })
  t.after(() => host.close())
  const descriptor = await host.start({ ...identity, sendOptions: options })
  async function client(index = 1) {
    const endpoint = descriptor.mcpServers[index]
    const client = new Client({ name: "cognia-test", version: "1.0.0" })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint.url), {
        requestInit: { headers: endpoint.headers },
      })
    )
    t.after(() => client.close())
    return client
  }
  async function event(type) {
    for (let index = 0; index < 100; index++) {
      const match = events.find((entry) => entry.event.type === type)
      if (match) return match.event
      await delay(5)
    }
    throw new Error(`No event ${type}`)
  }
  return { host, events, descriptor, client, event }
}

test("serves only scoped tool definitions and rejects unauthenticated and browser requests", async (t) => {
  const { descriptor, client } = await setup(t)
  assert.deepEqual(
    (await (await client(0)).listTools()).tools.map((tool) => tool.name),
    ["read"]
  )
  assert.deepEqual(
    (await (await client()).listTools()).tools.map((tool) => tool.name),
    ["echo"]
  )
  const endpoint = descriptor.mcpServers[0]
  assert.equal((await fetch(endpoint.url, { method: "POST" })).status, 403)
  assert.equal(
    (
      await fetch(endpoint.url, {
        method: "POST",
        headers: { ...endpoint.headers, Origin: "https://evil.test" },
      })
    ).status,
    403
  )
  assert.equal((await fetch(endpoint.url, { headers: endpoint.headers })).status, 405)
  assert.equal(
    (await fetch(endpoint.url, { method: "POST", headers: endpoint.headers, body: "invalid" }))
      .status,
    400
  )
})

test("executes a real builtin and validates plugin arguments before approvals", async (t) => {
  const { host, client, events } = await setup(t)
  const builtins = await client(0)
  const bad = await builtins.callTool({ name: "read", arguments: {} })
  assert.equal(bad.isError, true)
  const plugins = await client()
  const invalid = await plugins.callTool({ name: "echo", arguments: { value: 123 } })
  assert.equal(invalid.isError, true)
  assert.equal(events.length, 0)
  await host.stop({ ...identity, pause: true })
  await host.start({ ...identity, sendOptions: { ...options, permissionMode: "plan" } })
  const result = await builtins.callTool({
    name: "read",
    arguments: { file_path: `${process.cwd()}/package.json` },
  })
  assert.notEqual(result.isError, true)
  assert.match(JSON.stringify(result), /cognia/)
})

test("round trips approval and plugin execution with exact owner scope", async (t) => {
  const { host, client, event } = await setup(t)
  const pending = (await client()).callTool({ name: "echo", arguments: { value: "hello" } })
  const permission = await event("permission_request")
  assert.throws(
    () =>
      host.reply({
        ...identity,
        ownerSessionId: "other",
        kind: "permission",
        id: permission.requestId,
        result: { behavior: "allow" },
      }),
    /owner mismatch/
  )
  assert.throws(
    () => host.reply({ ...identity, kind: "permission", id: permission.requestId, result: {} }),
    /Invalid/
  )
  assert.deepEqual(
    host.reply({
      ...identity,
      kind: "permission",
      id: permission.requestId,
      result: { behavior: "allow", updatedInput: { value: "reviewed" } },
    }),
    { accepted: true }
  )
  const plugin = await event("plugin_tool_exec")
  assert.deepEqual(plugin.args, { value: "reviewed" })
  host.reply({
    ...identity,
    kind: "plugin",
    id: plugin.toolUseId,
    result: { result: { content: [{ type: "text", text: "safe result" }] } },
  })
  const result = await pending
  assert.match(JSON.stringify(result), /safe result/)
  assert.equal(
    host.reply({ ...identity, kind: "plugin", id: plugin.toolUseId, result: { result: "late" } })
      .accepted,
    false
  )
})

test("pause cancels pending approval, preserves endpoint, and enforces changed manifest on resume", async (t) => {
  const { host, descriptor, client, event } = await setup(t)
  const connected = await client()
  const pending = connected.callTool({ name: "echo", arguments: { value: "waiting" } })
  await event("permission_request")
  await assert.rejects(host.start({ ...identity, sendOptions: options }), /Pause/)
  await host.stop({ ...identity, pause: true })
  assert.equal((await pending).isError, true)
  await assert.rejects(
    connected.callTool({ name: "echo", arguments: { value: "stale" } }),
    /paused/
  )
  const resumed = await host.start({
    ...identity,
    sendOptions: { ...options, disallowedTools: ["echo"] },
  })
  assert.deepEqual(resumed.mcpServers, descriptor.mcpServers)
  assert.deepEqual((await connected.listTools()).tools, [])
  await assert.rejects(connected.callTool({ name: "echo", arguments: {} }), /not available/)
})

test("pause settles plugin callbacks and stale replies cannot authorize another turn", async (t) => {
  const { host, client, event } = await setup(t)
  await host.stop({ ...identity, pause: true })
  await host.start({
    ...identity,
    sendOptions: { ...options, permissionMode: "bypassPermissions" },
  })
  const pending = (await client()).callTool({ name: "echo", arguments: { value: "wait" } })
  const plugin = await event("plugin_tool_exec")
  await host.stop({ ...identity, pause: true })
  assert.equal((await pending).isError, true)
  assert.equal(
    host.reply({ ...identity, kind: "plugin", id: plugin.toolUseId, result: { result: "stale" } })
      .accepted,
    false
  )
})

test("leases expire without renderer renewal and startup stop cannot resurrect them", async (t) => {
  const { host, descriptor } = await setup(t, { leaseTtlMs: 40 })
  await delay(20)
  await host.start({ ...identity, renew: true })
  await delay(25)
  assert.equal((await fetch(descriptor.mcpServers[0].url)).status, 403)
  await delay(50)
  await assert.rejects(host.start({ ...identity, renew: true }), /expired/)
  await assert.rejects(fetch(descriptor.mcpServers[0].url))
  const newIdentity = { ...identity, leaseId: "startup-race-0123456789" }
  const starting = host.start({ ...newIdentity, sendOptions: options })
  const stopped = host.stop(newIdentity)
  await assert.rejects(starting, /closed during startup/)
  await stopped
  assert.deepEqual(await host.stop(newIdentity), { stopped: true })
})

test("rejects malformed lease boundaries and oversized authenticated requests", async (t) => {
  const { host, descriptor } = await setup(t)
  for (const input of [
    undefined,
    {},
    { leaseId: "short", ownerSessionId: "owner" },
    { leaseId: identity.leaseId, ownerSessionId: "" },
  ]) {
    await assert.rejects(host.start(input), /requires a lease/)
  }
  await assert.rejects(
    host.start({ leaseId: "missing-options-012345", ownerSessionId: "owner" }),
    /sendOptions/
  )
  const endpoint = descriptor.mcpServers[0]
  const response = await fetch(endpoint.url, {
    method: "POST",
    headers: endpoint.headers,
    body: " ".repeat(2 * 1024 * 1024 + 1),
  })
  assert.equal(response.status, 413)
  assert.equal(host.reply({ ...identity, kind: "invalid", id: "x", result: {} }).accepted, false)
})

test("real plugin errors are PII reviewed and a startup definition fault releases its lease", async (t) => {
  const { host, client, event } = await setup(t)
  await host.stop({ ...identity, pause: true })
  await host.start({
    ...identity,
    sendOptions: { ...options, permissionMode: "bypassPermissions" },
  })
  const pending = (await client()).callTool({ name: "echo", arguments: { value: "hello" } })
  const plugin = await event("plugin_tool_exec")
  host.reply({
    ...identity,
    kind: "plugin",
    id: plugin.toolUseId,
    result: { error: "Tool failed" },
  })
  const result = await pending
  assert.equal(result.isError, true)
  assert.match(JSON.stringify(result), /Tool failed/)
  const broken = createToolHostManager({
    emit: () => {},
    buildTools: () => {
      throw new Error("Invalid manifest")
    },
  })
  await assert.rejects(broken.start({ ...identity, sendOptions: options }), /Invalid manifest/)
  await assert.rejects(broken.start({ ...identity, renew: true }), /expired/)
  await broken.close()
})

test("HTTP caller cancellation releases its pending plugin without pausing siblings", async (t) => {
  const { host, client, event } = await setup(t)
  await host.stop({ ...identity, pause: true })
  const resumed = await host.start({
    ...identity,
    sendOptions: { ...options, permissionMode: "bypassPermissions" },
  })
  const connected = await client()
  const controller = new AbortController()
  const pending = connected.callTool({ name: "echo", arguments: { value: "cancel" } }, undefined, {
    signal: controller.signal,
  })
  const plugin = await event("plugin_tool_exec")
  assert.equal(
    host.reply({
      ...identity,
      generation: resumed.generation - 1,
      kind: "plugin",
      id: plugin.toolUseId,
      result: { result: "stale" },
    }).accepted,
    false
  )
  controller.abort()
  await assert.rejects(pending)
  await delay(20)
  assert.equal(
    host.reply({
      ...identity,
      generation: resumed.generation,
      kind: "plugin",
      id: plugin.toolUseId,
      result: { result: "late" },
    }).accepted,
    false
  )
  assert.equal((await connected.listTools()).tools.length, 1)
})

test("full close reaps active HTTP connections and pending calls promptly", async (t) => {
  const { host, client, event } = await setup(t)
  const pending = (await client()).callTool({ name: "echo", arguments: { value: "waiting" } })
  const outcome = pending.catch((error) => error)
  await event("permission_request")
  const deadline = new AbortController()
  const bounded = delay(1000, undefined, { signal: deadline.signal }).then(() => {
    throw new Error("Tool host close hung")
  })
  try {
    await Promise.race([host.stop(identity), bounded])
  } finally {
    deadline.abort()
  }
  await outcome
  assert.equal(
    host.reply({ ...identity, kind: "permission", id: "stale", result: {} }).accepted,
    false
  )
})

test("plugin descriptions and schema examples cannot bypass outbound PII review", async (t) => {
  const host = createToolHostManager({ emit: () => {} })
  t.after(() => host.close())
  for (const manifest of [
    { ...options.pluginTools[0], description: "Contact alice@example.com" },
    {
      ...options.pluginTools[0],
      jsonSchema: {
        type: "object",
        properties: { value: { type: "string", default: "alice@example.com" } },
      },
    },
  ]) {
    await assert.rejects(
      host.start({ ...identity, sendOptions: { ...options, pluginTools: [manifest] } }),
      /catalog blocked by the PII/
    )
    await assert.rejects(host.start({ ...identity, renew: true }), /expired/)
  }
})

test("post-tool review rewrites provider-visible output and is rechecked for PII", async (t) => {
  const { host, client, event } = await setup(t)
  await host.stop({ ...identity, pause: true })
  await host.start({
    ...identity,
    sendOptions: { ...options, permissionMode: "bypassPermissions", toolResultReviewEnabled: true },
  })
  const pending = (await client()).callTool({
    name: "echo",
    arguments: { value: "original input" },
  })
  const plugin = await event("plugin_tool_exec")
  host.reply({
    ...identity,
    kind: "plugin",
    id: plugin.toolUseId,
    result: { result: "original output" },
  })
  const review = await event("tool_result_review")
  assert.deepEqual(review.input, { value: "original input" })
  assert.equal(review.result, "original output")
  host.reply({
    ...identity,
    kind: "review",
    id: review.reviewId,
    result: { updatedResult: "reviewed alice@example.com" },
  })
  const result = await pending
  assert.match(JSON.stringify(result), /reviewed/)
  assert.doesNotMatch(JSON.stringify(result), /alice@example.com|original output/)
})

test("review timeout preserves safe output and pause cancels a waiting review", async (t) => {
  const { host, client, event, events } = await setup(t, { reviewTimeoutMs: 20 })
  await host.stop({ ...identity, pause: true })
  const sendOptions = {
    ...options,
    permissionMode: "bypassPermissions",
    toolResultReviewEnabled: true,
  }
  await host.start({ ...identity, sendOptions })
  const connected = await client()
  const first = connected.callTool({ name: "echo", arguments: { value: "first" } })
  const plugin = await event("plugin_tool_exec")
  host.reply({
    ...identity,
    kind: "plugin",
    id: plugin.toolUseId,
    result: { result: "safe output" },
  })
  assert.match(JSON.stringify(await first), /safe output/)
  events.length = 0
  const second = connected.callTool({ name: "echo", arguments: { value: "second" } })
  const next = await event("plugin_tool_exec")
  host.reply({
    ...identity,
    kind: "plugin",
    id: next.toolUseId,
    result: { result: "second output" },
  })
  const review = await event("tool_result_review")
  await host.stop({ ...identity, pause: true })
  assert.equal((await second).isError, true)
  assert.equal(
    host.reply({ ...identity, kind: "review", id: review.reviewId, result: {} }).accepted,
    false
  )
})

test("PreToolUse runs before bypassed native calls and validates modified arguments", async (t) => {
  const { host, client, event, events } = await setup(t, { autoPreflight: false })
  await host.stop({ ...identity, pause: true })
  await host.start({
    ...identity,
    sendOptions: { ...options, permissionMode: "bypassPermissions" },
  })
  const connected = await client(0)
  for (const decision of [
    { action: "deny", reason: "PreToolUse blocked read" },
    { action: "modify", modifiedArgs: { file_path: 123 } },
    { action: "modify", modifiedArgs: { file_path: `${process.cwd()}/package.json` } },
  ]) {
    events.length = 0
    const pending = connected.callTool({
      name: "read",
      arguments: { file_path: `${process.cwd()}/nonexistent-fixture` },
    })
    const preflight = await event("tool_host_pre_tool")
    assert.equal(preflight.toolName, "mcp__cognia-tools__read")
    host.reply({ ...identity, kind: "preflight", id: preflight.requestId, result: decision })
    const result = await pending
    if (decision.action === "deny") assert.match(JSON.stringify(result), /PreToolUse blocked read/)
    else if (typeof decision.modifiedArgs.file_path === "number") assert.equal(result.isError, true)
    else {
      assert.notEqual(result.isError, true)
      assert.match(JSON.stringify(result), /cognia/)
    }
    assert.equal(
      events.some((entry) => entry.event.type === "permission_request"),
      false
    )
  }
})

test("PreToolUse timeout fails closed and pause cancels the outstanding preflight", async (t) => {
  const { host, client, event, events } = await setup(t, {
    autoPreflight: false,
    reviewTimeoutMs: 20,
  })
  const connected = await client()
  const timedOut = await connected.callTool({ name: "echo", arguments: { value: "timeout" } })
  assert.equal(timedOut.isError, true)
  assert.match(JSON.stringify(timedOut), /timed out/)
  assert.equal(
    events.some((entry) => entry.event.type === "plugin_tool_exec"),
    false
  )
  events.length = 0
  const pending = connected.callTool({ name: "echo", arguments: { value: "cancel" } })
  const preflight = await event("tool_host_pre_tool")
  await host.stop({ ...identity, pause: true })
  assert.equal((await pending).isError, true)
  assert.equal(
    host.reply({
      ...identity,
      kind: "preflight",
      id: preflight.requestId,
      result: { action: "allow" },
    }).accepted,
    false
  )
})
