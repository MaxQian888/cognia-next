// Sidecar tests use Node's built-in --test runner (see package.json).
// Run via `pnpm sidecar:test` once the sidecar TypeScript is compiled
// into `dist/`. These tests exercise the RPC framing without spawning
// a real child process.

import { test } from "node:test"
import assert from "node:assert/strict"
import { Readable, Writable } from "node:stream"

// We dynamically require dist/ output; the test runner expects
// `pnpm --filter=@cognia/vscode-ext-host build` to have produced it.
const { RpcConnection, ErrorCode } = await import("../dist/rpc.js")

function makeStreams() {
  const incoming = new Readable({ read() {} })
  const outgoingChunks = []
  const outgoing = new Writable({
    write(chunk, _encoding, callback) {
      outgoingChunks.push(chunk.toString("utf-8"))
      callback()
    },
  })
  return { incoming, outgoing, outgoingChunks }
}

function readFrames(chunks) {
  const all = chunks.join("")
  return all
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
}

test("RpcConnection dispatches request to a registered handler", async () => {
  const { incoming, outgoing, outgoingChunks } = makeStreams()
  const conn = new RpcConnection(incoming, outgoing)
  conn.onRequest("echo", async (params) => params)
  incoming.push(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "echo", params: { x: 7 } }) + "\n")
  await new Promise((r) => setTimeout(r, 10))
  const frames = readFrames(outgoingChunks)
  assert.deepEqual(frames[0], { jsonrpc: "2.0", id: 1, result: { x: 7 } })
  conn.close()
})

test("RpcConnection emits MethodNotFound for unknown methods", async () => {
  const { incoming, outgoing, outgoingChunks } = makeStreams()
  const conn = new RpcConnection(incoming, outgoing)
  incoming.push(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "unknown" }) + "\n")
  await new Promise((r) => setTimeout(r, 10))
  const frames = readFrames(outgoingChunks)
  assert.equal(frames[0].error.code, ErrorCode.MethodNotFound)
  conn.close()
})

test("RpcConnection sends requests and resolves on matching response", async () => {
  const { incoming, outgoing, outgoingChunks } = makeStreams()
  const conn = new RpcConnection(incoming, outgoing)
  const requestPromise = conn.sendRequest("ping", { hi: true })
  await new Promise((r) => setTimeout(r, 10))
  const frames = readFrames(outgoingChunks)
  const id = frames[0].id
  incoming.push(JSON.stringify({ jsonrpc: "2.0", id, result: "pong" }) + "\n")
  const result = await requestPromise
  assert.equal(result, "pong")
  conn.close()
})

test("Notifications dispatch to registered handlers", async () => {
  const { incoming, outgoing } = makeStreams()
  const conn = new RpcConnection(incoming, outgoing)
  let received
  conn.onNotification("hello", (params) => {
    received = params
  })
  incoming.push(JSON.stringify({ jsonrpc: "2.0", method: "hello", params: { hi: 1 } }) + "\n")
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(received, { hi: 1 })
  conn.close()
})

test("Malformed JSON produces a parse error frame", async () => {
  const { incoming, outgoing, outgoingChunks } = makeStreams()
  const conn = new RpcConnection(incoming, outgoing)
  incoming.push("not json\n")
  await new Promise((r) => setTimeout(r, 10))
  const frames = readFrames(outgoingChunks)
  assert.equal(frames[0].error.code, ErrorCode.ParseError)
  conn.close()
})
