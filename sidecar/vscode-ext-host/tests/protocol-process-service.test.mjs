import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const { ProtocolProcessService } = await import("../dist/protocol-process-service.js")
const fixture = fileURLToPath(new URL("./fixtures/echo-protocol.mjs", import.meta.url))

test("DAP stdio uses Content-Length framing and correlates request_seq", async (t) => {
  const service = new ProtocolProcessService(() => undefined)
  t.after(() => service.stopAll())
  await service.start({
    ownerId: "managed-pro:acme",
    serverId: "debug",
    family: "dap",
    command: process.execPath,
    args: [fixture, "dap"],
    transport: "stdio",
  })
  const response = await service.request({
    ownerId: "managed-pro:acme",
    serverId: "debug",
    message: { seq: 7, type: "request", command: "launch", arguments: { program: "a" } },
  })
  assert.equal(response.request_seq, 7)
  assert.deepEqual(response.body, { echoed: { program: "a" } })
})

test("DAP cancellation rejects the pending request and forwards a cancel request", async (t) => {
  const service = new ProtocolProcessService(() => undefined)
  t.after(() => service.stopAll())
  await service.start({
    ownerId: "managed-pro:acme",
    serverId: "debug",
    family: "dap",
    command: process.execPath,
    args: [fixture, "dap"],
    transport: "stdio",
  })
  const pending = service.request({
    ownerId: "managed-pro:acme",
    serverId: "debug",
    requestId: "broker-request-1",
    message: { seq: 9, type: "request", command: "hang" },
  })
  assert.equal(service.cancel("managed-pro:acme", "debug", "broker-request-1"), true)
  await assert.rejects(pending, /IDE_PROTOCOL_REQUEST_CANCELLED/)
})

test("MCP stdio is exposed through an authenticated loopback HTTP relay", async (t) => {
  const service = new ProtocolProcessService(() => undefined)
  t.after(() => service.stopAll())
  const started = await service.start({
    ownerId: "managed-pro:acme",
    serverId: "tools",
    family: "mcp",
    command: process.execPath,
    args: [fixture, "mcp"],
    transport: "stdio",
  })
  assert.match(started.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  const unauthorized = await fetch(started.endpoint, { method: "POST", body: "{}" })
  assert.equal(unauthorized.status, 401)
  const response = await fetch(started.endpoint, {
    method: "POST",
    headers: { ...started.headers, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { jsonrpc: "2.0", id: 1, result: { echoed: {} } })
})

test("unsupported non-loopback endpoints fail before spawning", async () => {
  const service = new ProtocolProcessService(() => undefined)
  await assert.rejects(
    service.start({
      ownerId: "managed-pro:acme",
      serverId: "remote",
      family: "mcp",
      command: process.execPath,
      transport: "http",
      endpoint: "https://example.com/mcp",
    }),
    /IDE_PROTOCOL_ENDPOINT_NOT_LOOPBACK/
  )
})

test("invalid process resource limits fail before spawning", async () => {
  const service = new ProtocolProcessService(() => undefined)
  await assert.rejects(
    service.start({
      ownerId: "managed-pro:acme",
      serverId: "invalid-limit",
      family: "dap",
      command: process.execPath,
      transport: "stdio",
      memoryLimitMb: 1,
    }),
    /IDE_PROTOCOL_MEMORY_LIMIT_INVALID/
  )
})
