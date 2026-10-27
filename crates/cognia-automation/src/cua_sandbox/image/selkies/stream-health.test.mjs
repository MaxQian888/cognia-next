import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import vm from "node:vm"

const source = readFileSync(new URL("./stream-health.js", import.meta.url), "utf8")

function client() {
  const listeners = new Map()
  const timers = []
  const messages = []
  let now = 0
  const parent = { postMessage: (data, origin) => messages.push({ data, origin }) }
  const document = {
    hidden: false,
    addEventListener: (type, callback) => listeners.set(`document:${type}`, [callback]),
  }
  const window = {
    parent,
    addEventListener: (type, handler) => {
      const handlers = listeners.get(type) ?? []
      handlers.push(handler)
      listeners.set(type, handlers)
    },
  }
  vm.runInNewContext(source, {
    window,
    document,
    performance: { now: () => now },
    setInterval: (callback) => timers.push(callback),
  })
  const emit = (type, data = {}) => listeners.get(type)?.forEach((handler) => handler(data))
  const observe = (overrides = {}) =>
    emit("message", {
      source: parent,
      origin: "http://localhost:3000",
      data: { type: "cognia-sandbox-stream-observe", version: 1, nonce: "fixture-nonce-123456" },
      ...overrides,
    })
  return {
    messages,
    document,
    emit,
    observe,
    tick(ms) {
      now += ms
      timers.forEach((callback) => callback())
    },
    elapse(ms) {
      now += ms
    },
  }
}

test("only a valid parent handshake receives a bounded liveness projection", () => {
  const c = client()
  c.observe({ source: {} })
  c.observe({ data: { type: "input", nonce: "fixture-nonce-123456" } })
  assert.equal(c.messages.length, 0)
  c.observe()
  assert.equal(c.messages.length, 1)
  assert.equal(c.messages[0].origin, "http://localhost:3000")
  assert.deepEqual(Object.keys(c.messages[0].data).sort(), [
    "connected",
    "failed",
    "nonce",
    "presented",
    "type",
    "version",
  ])
})

test("socket-open is not a first frame and an established idle display stays healthy", () => {
  const c = client()
  c.observe()
  c.emit("cognia-selkies-connected")
  assert.equal(c.messages.at(-1).data.presented, false)
  c.emit("cognia-selkies-output")
  c.tick(60_000)
  assert.equal(c.messages.at(-1).data.connected, true)
  assert.equal(c.messages.at(-1).data.presented, true)
  assert.equal(c.messages.at(-1).data.failed, null)
})

test("received chunks without output fail, but decoder progress clears the backlog", () => {
  const c = client()
  c.observe()
  c.emit("cognia-selkies-connected")
  c.emit("cognia-selkies-received")
  c.tick(9_000)
  c.emit("cognia-selkies-received")
  c.emit("cognia-selkies-output")
  c.tick(20_000)
  assert.equal(c.messages.at(-1).data.failed, null)
  c.emit("cognia-selkies-received")
  c.tick(10_001)
  assert.equal(c.messages.at(-1).data.failed, "decoder-stalled")
})

test("a background document does not accumulate decoder-stall time", () => {
  const c = client()
  c.observe()
  c.emit("cognia-selkies-connected")
  c.emit("cognia-selkies-output")
  c.emit("cognia-selkies-received")
  c.document.hidden = true
  c.tick(60_000)
  c.document.hidden = false
  c.tick(1_000)
  assert.equal(c.messages.at(-1).data.failed, null)
})

test("resuming a suspended hidden timer discards the old decode backlog", () => {
  const c = client()
  c.observe()
  c.emit("cognia-selkies-connected")
  c.emit("cognia-selkies-output")
  c.emit("cognia-selkies-received")
  c.document.hidden = true
  c.elapse(60_000)
  c.document.hidden = false
  c.emit("document:visibilitychange")
  c.observe()
  c.tick(1_000)
  assert.equal(c.messages.at(-1).data.failed, null)
})

for (const kind of ["closed", "error", "decoder-failed", "killed"]) {
  test(`a ${kind} signal reports failure immediately`, () => {
    const c = client()
    c.observe()
    c.emit("cognia-selkies-connected")
    c.emit(`cognia-selkies-${kind}`)
    assert.equal(c.messages.at(-1).data.connected, false)
    assert.equal(c.messages.at(-1).data.failed, kind)
  })
}
