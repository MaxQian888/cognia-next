import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import * as net from "node:net"
import { afterEach, describe, test } from "node:test"

import { AgentBridge } from "../src/agent-bridge.mjs"
import { deriveSessionKey } from "../src/broker-credential.mjs"
import { ContentLengthDecoder, serializeContentLength } from "../src/jsonrpc.mjs"

// The real connection class against a stand-in host on a real loopback socket.

const CATALOG = "sha256:catalog"
const ALL_CAPS = [
  "cancel",
  "progress",
  "structured-errors",
  "content-handles",
  "contribution-transactions",
]

/**
 * A minimal broker host: authenticates challenge/hello against the credentials
 * it knows (bootstrap secrets and derived sessions) and records every frame.
 */
async function startHost({ bootstrap, capabilities = ALL_CAPS, refuseHello = null } = {}) {
  const host = {
    connections: [],
    frames: [],
    credentials: new Map([[bootstrap.tokenId, Buffer.from(bootstrap.secret)]]),
    sessions: [],
  }
  const server = net.createServer((socket) => {
    const decoder = new ContentLengthDecoder()
    const conn = { socket, challenge: null, clientNonce: null, tokenId: null, frames: [] }
    host.connections.push(conn)
    const send = (message) => socket.write(serializeContentLength(message))
    conn.send = send
    socket.on("error", () => {})
    socket.on("data", (chunk) => {
      for (const message of decoder.push(chunk)) {
        conn.frames.push(message)
        host.frames.push(message)
        if (message.method === "cognia/auth/challenge") {
          conn.tokenId = message.params.tokenId
          conn.clientNonce = message.params.clientNonce
          conn.challenge = `server-${host.connections.length}`
          if (!host.credentials.has(conn.tokenId)) {
            send({ jsonrpc: "2.0", id: message.id, error: { code: -32002, message: "invalid" } })
            continue
          }
          send({ jsonrpc: "2.0", id: message.id, result: { challenge: conn.challenge } })
        } else if (message.method === "cognia/hello") {
          const secret = host.credentials.get(conn.tokenId)
          const proof = createHmac("sha256", secret).update(conn.challenge).digest("hex")
          if (proof !== message.params.proof) {
            send({ jsonrpc: "2.0", id: message.id, error: { code: -32002, message: "bad proof" } })
            continue
          }
          if (refuseHello) {
            send({ jsonrpc: "2.0", id: message.id, error: refuseHello })
            continue
          }
          const sessionId = `session-${host.sessions.length + 1}`
          host.credentials.delete(conn.tokenId)
          host.credentials.set(
            sessionId,
            deriveSessionKey(secret, conn.challenge, conn.clientNonce)
          )
          host.sessions.push(sessionId)
          send({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "1.0",
              codeApiVersion: "1.128.0",
              catalogHash: CATALOG,
              generation: host.connections.length,
              sessionId,
              capabilities,
              requestDeadlinesMs: { default: 200 },
            },
          })
        }
      }
    })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  host.port = server.address().port
  host.close = () => {
    for (const conn of host.connections) conn.socket.destroy()
    return new Promise((resolve) => server.close(resolve))
  }
  return host
}

const bridges = []
const hosts = []
afterEach(async () => {
  for (const bridge of bridges.splice(0)) bridge.dispose()
  for (const host of hosts.splice(0)) await host.close()
})

function bridgeFor(host, bootstrap, overrides = {}) {
  let reads = 0
  const bridge = new AgentBridge({
    port: host.port,
    credentialFile: "/unused",
    hostId: "local",
    workspace: "/work",
    catalogHash: CATALOG,
    dispatch: async () => null,
    readCredential: async () => {
      reads += 1
      return {
        kind: "bootstrap",
        tokenId: bootstrap.tokenId,
        secret: Buffer.from(bootstrap.secret),
      }
    },
    reconnectDelayMs: 10,
    eventCoalesceMs: 20,
    ...overrides,
  })
  bridge.credentialReads = () => reads
  bridges.push(bridge)
  return bridge
}

async function until(condition, label = "condition") {
  // Generous: real sockets under a loaded test run, and the happy path exits early.
  for (let i = 0; i < 500; i += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const bootstrap = { tokenId: "boot-1", secret: "bootstrap-secret" }

describe("handshake and reconnect", () => {
  test("authenticates with the bootstrap, then reconnects with the derived session", async () => {
    const host = await startHost({ bootstrap })
    hosts.push(host)
    const changes = []
    const bridge = bridgeFor(host, bootstrap, { onConnectionChange: (c) => changes.push(c) })
    bridge.start()
    await until(() => bridge.connected, "first hello")
    assert.equal(host.connections[0].tokenId, "boot-1")
    assert.match(bridge.contentBearer(), /^session-1\.[0-9a-f]{64}$/)

    host.connections[0].socket.destroy()
    await until(() => host.sessions.length === 2, "session reconnect")
    assert.equal(host.connections[1].tokenId, "session-1")
    assert.equal(bridge.credentialReads(), 1)
    assert.deepEqual(changes, [true, false, true])
  })

  test("a refused credential is dropped and a fresh bootstrap is read", async () => {
    const host = await startHost({ bootstrap })
    hosts.push(host)
    host.credentials.clear()
    const bridge = bridgeFor(host, bootstrap)
    bridge.start()
    await until(() => bridge.credentialReads() >= 2, "re-read after refusal")
    assert.equal(bridge.connected, false)
  })

  test("a protocol refusal stops reconnecting", async () => {
    const host = await startHost({
      bootstrap,
      refuseHello: { code: -32001, message: "IDE_BROKER_PROTOCOL_INCOMPATIBLE" },
    })
    hosts.push(host)
    const bridge = bridgeFor(host, bootstrap)
    bridge.start()
    await until(() => bridge.incompatible, "incompatible flag")
    const attempts = host.connections.length
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(host.connections.length, attempts)
  })
})

describe("whenReady", () => {
  test("waits for the hello a proxy activating at startup would otherwise race", async () => {
    const host = await startHost({ bootstrap })
    hosts.push(host)
    const bridge = bridgeFor(host, bootstrap)
    const ready = bridge.whenReady(5_000)
    // Not started yet: a request now is refused, which is the race.
    await assert.rejects(bridge.request("cognia/state/keys", {}), /not ready/)
    bridge.start()
    await ready
    assert.equal(bridge.connected, true)
    // Already connected: at once.
    await bridge.whenReady(1)
  })

  test("gives up after its timeout, on dispose, and on a protocol refusal", async () => {
    const host = await startHost({ bootstrap })
    hosts.push(host)
    const idle = bridgeFor(host, bootstrap)
    await assert.rejects(idle.whenReady(20), /did not connect within 20 ms/)
    const disposed = bridgeFor(host, bootstrap)
    const pending = disposed.whenReady(5_000)
    disposed.dispose()
    await assert.rejects(pending, /disposed/)
    await assert.rejects(disposed.whenReady(5_000), /disposed/)

    const refusing = await startHost({
      bootstrap,
      refuseHello: { code: -32001, message: "IDE_BROKER_PROTOCOL_INCOMPATIBLE" },
    })
    hosts.push(refusing)
    const refused = bridgeFor(refusing, bootstrap)
    const waiting = refused.whenReady(5_000)
    refused.start()
    await assert.rejects(waiting, /IDE_BROKER_PROTOCOL_INCOMPATIBLE/)
  })
})

describe("requests from the host", () => {
  test("a withdrawn request aborts the verb and answers RequestCancelled", async () => {
    const host = await startHost({ bootstrap })
    hosts.push(host)
    let seenSignal = null
    const bridge = bridgeFor(host, bootstrap, {
      dispatch: (_method, _params, { signal }) => {
        seenSignal = signal
        return new Promise((resolve) => signal.addEventListener("abort", () => resolve("late")))
      },
    })
    bridge.start()
    await until(() => bridge.connected)
    const conn = host.connections[0]
    conn.send({ jsonrpc: "2.0", id: 7, method: "saveAll", params: {} })
    await until(() => seenSignal !== null)
    conn.send({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 7 } })
    await until(() => conn.frames.some((f) => f.id === 7))
    const reply = conn.frames.find((f) => f.id === 7)
    assert.equal(reply.error.code, -32800)
  })

  test("progress reports carry the request id, only when negotiated", async () => {
    for (const [capabilities, expected] of [
      [ALL_CAPS, 1],
      [["structured-errors", "content-handles", "contribution-transactions"], 0],
    ]) {
      const host = await startHost({ bootstrap, capabilities })
      hosts.push(host)
      const bridge = bridgeFor(host, bootstrap, {
        dispatch: async (_m, _p, { reportProgress }) => {
          reportProgress({ kind: "begin", operation: "saveAll" })
          return { saved: [] }
        },
      })
      bridge.start()
      await until(() => bridge.connected)
      const conn = host.connections[0]
      conn.send({ jsonrpc: "2.0", id: 3, method: "saveAll", params: {} })
      await until(() => conn.frames.some((f) => f.id === 3))
      const progress = conn.frames.filter((f) => f.method === "$/progress")
      assert.equal(progress.length, expected)
      if (expected)
        assert.deepEqual(progress[0].params, {
          token: 3,
          value: { kind: "begin", operation: "saveAll" },
        })
      bridge.dispose()
    }
  })
})

describe("requests to the host", () => {
  test("a request past the host-supplied deadline is withdrawn with $/cancelRequest", async () => {
    const host = await startHost({ bootstrap })
    hosts.push(host)
    const bridge = bridgeFor(host, bootstrap)
    bridge.start()
    await until(() => bridge.connected)
    // The hello reply set every deadline to 200 ms.
    await assert.rejects(bridge.request("cognia/provider/invoke", {}), /timed out/)
    const conn = host.connections[0]
    await until(() => conn.frames.some((f) => f.method === "$/cancelRequest"))
    const sent = conn.frames.find((f) => f.method === "cognia/provider/invoke")
    const cancel = conn.frames.find((f) => f.method === "$/cancelRequest")
    assert.deepEqual(cancel.params, { id: sent.id })
  })

  test("a disconnect fails every pending request", async () => {
    const host = await startHost({ bootstrap })
    hosts.push(host)
    const bridge = bridgeFor(host, bootstrap)
    bridge.start()
    await until(() => bridge.connected)
    const pending = bridge.request("cognia/state/get", {}, { timeoutMs: 5000 })
    host.connections[0].socket.destroy()
    await assert.rejects(pending, /disconnected/)
  })
})

describe("events", () => {
  test("state events coalesce; user-initiated events each go out at once", async () => {
    const host = await startHost({ bootstrap })
    hosts.push(host)
    const bridge = bridgeFor(host, bootstrap)
    bridge.start()
    await until(() => bridge.connected)
    for (let i = 0; i < 5; i += 1) bridge.emit("selectionChanged", () => ({ i }))
    bridge.emit("chatContextRequested", () => ({ action: "explain" }), { coalesce: false })
    bridge.emit("chatContextRequested", () => ({ action: "fix" }), { coalesce: false })
    const events = () =>
      host.connections[0].frames.filter((f) => f.method === "cognia/event").map((f) => f.params)
    await until(() => events().length === 3, "three events")
    assert.deepEqual(events(), [
      { name: "chatContextRequested", payload: { action: "explain" } },
      { name: "chatContextRequested", payload: { action: "fix" } },
      { name: "selectionChanged", payload: { i: 4 } },
    ])
  })

  test("a user-initiated event while disconnected is reported as not sent", () => {
    const bridge = new AgentBridge({
      port: 1,
      credentialFile: "/unused",
      hostId: "local",
      workspace: "",
      catalogHash: CATALOG,
      dispatch: async () => null,
    })
    bridges.push(bridge)
    assert.equal(
      bridge.emit("diagnosticsHandoffRequested", () => ({}), { coalesce: false }),
      false
    )
  })
})
