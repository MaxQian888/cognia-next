import type { TestContext } from "node:test"
import type { ToolHostEvent, ToolHostOptions, ToolHostInput } from "./tool-host.ts"
import test from "node:test"
import assert from "node:assert/strict"
import net from "node:net"
import { setTimeout as delay } from "node:timers/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createToolHostManager } from "./tool-host.ts"

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

test("pending sandbox tools preserve their endpoint before any agent exists and revoke on close", async (t) => {
  const calls: string[] = []
  let registeredPort = 0
  const bridgeId = "00000000-0000-4000-8000-000000000019"
  const host = createToolHostManager({
    emit: () => {},
    hostRpc: {
      call: async (method, params) => {
        calls.push(method)
        if (method === "sandbox.toolHost.register") {
          const request = params as Record<string, unknown>
          assert.equal(request.agentId, "unspawned-parent")
          assert.equal(request.ownerSessionId, identity.ownerSessionId)
          assert.equal(request.originDeviceId, "paired-device")
          registeredPort = Number(request.port)
          return { bridgeId }
        }
        if (method === "sandbox.toolHost.renew") return { active: true }
        if (method === "sandbox.toolHost.close") {
          assert.equal((params as { bridgeId: string }).bridgeId, bridgeId)
          return { closed: true }
        }
        throw new Error("No agent has been spawned")
      },
    },
  })
  t.after(() => host.close())
  const input = {
    ...identity,
    sandboxAgentId: "unspawned-parent",
    deferSandbox: true,
    remoteExecutionContext: { originDeviceId: "paired-device" },
    sendOptions: { ...options },
  }
  const first = await host.start(input)
  assert.equal(first.sandboxToolHostLeaseId, bridgeId)
  assert.equal(new URL(first.mcpServers[1]!.url).port, String(registeredPort))
  const client = new Client({ name: "pending-sandbox", version: "1" })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(first.mcpServers[1]!.url), {
      requestInit: { headers: first.mcpServers[1]!.headers },
    })
  )
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    ["echo"]
  )
  await client.close()
  await host.stop({ ...identity, pause: true })
  const next = await host.start(input)
  assert.equal(next.sandboxToolHostLeaseId, bridgeId)
  assert.equal(next.mcpServers[1]!.url, first.mcpServers[1]!.url)
  assert.equal(calls.filter((method) => method === "sandbox.toolHost.register").length, 1)
  await host.stop(identity)
  assert.equal(calls.filter((method) => method === "sandbox.toolHost.close").length, 1)
})

test("pending sandbox tools fail closed when registration fails or identity is absent", async () => {
  const host = createToolHostManager({
    emit: () => {},
    hostRpc: {
      call: async () => {
        throw new Error("Host authority revoked")
      },
    },
  })
  await assert.rejects(
    host.start({
      ...identity,
      sandboxAgentId: "parent",
      deferSandbox: true,
      sendOptions: { ...options },
    }),
    /authority revoked/
  )
  await assert.rejects(
    host.start({ ...identity, deferSandbox: true, sendOptions: { ...options } }),
    /sandbox agent/
  )
  await host.close()
})

test("closing during pending registration revokes the late reference and cannot resurrect the lease", async () => {
  let registered!: () => void
  let finish!: (value: unknown) => void
  const entered = new Promise<void>((resolve) => {
    registered = resolve
  })
  const pending = new Promise<unknown>((resolve) => {
    finish = resolve
  })
  const revoked: string[] = []
  const bridgeId = "00000000-0000-4000-8000-000000000027"
  const host = createToolHostManager({
    emit: () => {},
    hostRpc: {
      call: async (method, params) => {
        if (method === "sandbox.toolHost.register") {
          registered()
          return pending
        }
        if (method === "sandbox.toolHost.close")
          revoked.push((params as { bridgeId: string }).bridgeId)
        return { closed: true }
      },
    },
  })
  const starting = host.start({
    ...identity,
    sandboxAgentId: "parent",
    deferSandbox: true,
    sendOptions: { ...options },
  })
  await entered
  await host.stop(identity)
  finish({ bridgeId })
  await assert.rejects(starting, /closed while registering/)
  assert.deepEqual(revoked, [bridgeId])
  await assert.rejects(host.start({ ...identity, renew: true }), /expired/)
  await host.close()
})

test("pending sandbox leases refuse revoked authority and a change to live-agent mode", async (t) => {
  let live = true
  let closed = 0
  const host = createToolHostManager({
    emit: () => {},
    hostRpc: {
      call: async (method) => {
        if (method === "sandbox.toolHost.register")
          return { bridgeId: "00000000-0000-4000-8000-000000000033" }
        if (method === "sandbox.toolHost.renew") return { active: live }
        if (method === "sandbox.toolHost.close") closed++
        return { closed: true }
      },
    },
  })
  t.after(() => host.close())
  const input = {
    ...identity,
    sandboxAgentId: "parent",
    deferSandbox: true,
    sendOptions: { ...options },
  }
  await host.start(input)
  await host.stop({ ...identity, pause: true })
  live = false
  await assert.rejects(host.start(input), /authority expired/)
  assert.equal(closed, 1)
  live = true
  await host.start(input)
  await host.stop({ ...identity, pause: true })
  await assert.rejects(host.start({ ...input, deferSandbox: false }), /mode cannot change/)
  assert.equal(closed, 2)
})

test("sandbox descriptor uses only its private bridge authority and keeps bearer and Origin checks", async (t) => {
  let upstreamPort = 0
  let sandboxPort = 0
  let closed = false
  const sockets = new Set<net.Socket>()
  const proxy = net.createServer((client) => {
    const upstream = net.connect(upstreamPort, "127.0.0.1")
    for (const socket of [client, upstream]) {
      sockets.add(socket)
      socket.on("error", () => socket.destroy())
      socket.on("close", () => sockets.delete(socket))
    }
    client.pipe(upstream).pipe(client)
  })
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
  sandboxPort = (proxy.address() as net.AddressInfo).port
  const bridgeId = "00000000-0000-4000-8000-000000000007"
  const host = createToolHostManager({
    emit: () => {},
    hostRpc: {
      call: async (method, params) => {
        if (method === "sandbox.toolHost.open") {
          const input = params as Record<string, unknown>
          assert.equal(input.agentId, "sandbox-agent")
          assert.equal(input.ownerSessionId, identity.ownerSessionId)
          assert.equal(input.originDeviceId, "paired-device")
          upstreamPort = input.port as number
          return { bridgeId, port: sandboxPort }
        }
        if (method === "sandbox.toolHost.close") {
          closed = true
          return { closed: true }
        }
        return { active: true }
      },
    },
  })
  t.after(async () => {
    await host.close()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => proxy.close(() => resolve()))
  })
  const descriptor = await host.start({
    ...identity,
    sandboxAgentId: "sandbox-agent",
    remoteExecutionContext: { originDeviceId: "paired-device" },
    sendOptions: { ...options },
  })
  const endpoint = descriptor.mcpServers[1]!
  assert.equal(new URL(endpoint.url).port, String(sandboxPort))
  const client = new Client({ name: "sandbox-test", version: "1" })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: { headers: endpoint.headers },
    })
  )
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    ["echo"]
  )
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
  await client.close()
  await host.stop(identity)
  assert.equal(closed, true)
})

test("sandbox bridge startup failure does not return a Host loopback fallback", async () => {
  const host = createToolHostManager({
    emit: () => {},
    hostRpc: {
      call: async () => {
        throw new Error("old bundle")
      },
    },
  })
  await assert.rejects(
    host.start({ ...identity, sandboxAgentId: "agent", sendOptions: { ...options } }),
    /old bundle/
  )
  await host.close()
})

test("a paused sandbox lease immediately rebinds after respawn without disturbing siblings", async (t) => {
  let generation = 1
  let running = true
  const bridges = new Map<string, number>()
  const closed: string[] = []
  let next = 0
  const host = createToolHostManager({
    emit: () => {},
    hostRpc: {
      call: async (method, params) => {
        const id = (params as { bridgeId: string }).bridgeId
        if (method === "sandbox.toolHost.open") {
          if (!running) throw new Error("Agent is not running")
          const bridgeId = `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`
          bridges.set(bridgeId, generation)
          return { bridgeId, port: 34000 + next }
        }
        if (method === "sandbox.toolHost.renew")
          return { active: running && bridges.get(id) === generation }
        if (method === "sandbox.toolHost.close") {
          closed.push(id)
          bridges.delete(id)
        }
        return { closed: true }
      },
    },
  })
  t.after(() => host.close())
  const input = { ...identity, sandboxAgentId: "agent", sendOptions: { ...options } }
  const first = await host.start(input)
  const siblingInput = {
    ...input,
    leaseId: `${identity.leaseId}-sibling`,
    ownerSessionId: "sibling",
  }
  await host.start(siblingInput)
  await host.stop({ ...identity, pause: true })
  generation++
  const replacement = await host.start(input)
  assert.notEqual(first.mcpServers[1]!.url, replacement.mcpServers[1]!.url)
  assert.equal(closed.length, 1)
  assert.equal(bridges.size, 2)
  await host.stop({ ...identity, pause: true })
  const unchanged = await host.start(input)
  assert.equal(unchanged.mcpServers[1]!.url, replacement.mcpServers[1]!.url)
  await host.stop({ ...identity, pause: true })
  running = false
  await assert.rejects(host.start(input), /Agent is not running/)
  assert.equal(bridges.size, 1, "failed restart must preserve its sibling lease")
})
async function setup(
  t: TestContext,
  configuration: Partial<ToolHostOptions> & { autoPreflight?: boolean } = {}
) {
  const events: ToolHostEvent[] = []
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
    const endpoint = descriptor.mcpServers[index]!
    const client = new Client({ name: "cognia-test", version: "1.0.0" })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint.url), {
        requestInit: { headers: endpoint.headers },
      })
    )
    t.after(() => client.close())
    return client
  }
  async function event(type: string) {
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
  const endpoint = descriptor.mcpServers[0]!
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
  assert.equal((await fetch(descriptor.mcpServers[0]!.url)).status, 403)
  await delay(50)
  await assert.rejects(host.start({ ...identity, renew: true }), /expired/)
  await assert.rejects(fetch(descriptor.mcpServers[0]!.url))
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
    await assert.rejects(host.start(input as ToolHostInput), /requires a lease/)
  }
  await assert.rejects(
    host.start({ leaseId: "missing-options-012345", ownerSessionId: "owner" }),
    /sendOptions/
  )
  const endpoint = descriptor.mcpServers[0]!
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
    else if (typeof decision.modifiedArgs!.file_path === "number")
      assert.equal(result.isError, true)
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

test("remote tool-host lifecycle frames retain device targeting", async (t) => {
  const frames: ToolHostEvent[] = []
  const host = createToolHostManager({ emit: (event) => frames.push(event) })
  t.after(() => host.close())
  const remoteExecutionContext = { originDeviceId: "device-a", sessionId: "chat-owner" }
  await host.start({ ...identity, remoteExecutionContext, sendOptions: options })
  await host.stop({ ...identity })
  assert.ok(frames.length > 0)
  assert.ok(frames.every((frame) => frame.remoteExecutionContext === remoteExecutionContext))
})
