import assert from "node:assert/strict"
import { test } from "node:test"

import { signalingRelay, smokeFailureCount } from "./compose-smoke.mjs"

test("signaling relay observes both sockets opening in the same event-loop turn", async (t) => {
  const originalWebSocket = globalThis.WebSocket
  const clients = []
  const failuresBefore = smokeFailureCount()
  t.after(() => {
    globalThis.WebSocket = originalWebSocket
  })
  globalThis.WebSocket = class extends EventTarget {
    closed = false

    constructor() {
      super()
      clients.push(this)
      queueMicrotask(() => {
        this.dispatchEvent(new Event("open"))
        this.receive({ kind: "challenge", challenge: "test-challenge" })
      })
    }

    receive(frame) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }))
    }

    send(raw) {
      const frame = JSON.parse(raw)
      if (frame.kind === "subscribe") this.receive({ kind: "subscribed" })
      if (frame.kind === "relay") {
        clients.find((client) => client !== this).receive(frame)
      }
    }

    close() {
      this.closed = true
    }
  }

  let timer
  try {
    await Promise.race([
      signalingRelay(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("relay missed an open event after both sockets opened")),
          1000
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
  assert.equal(clients.length, 2)
  assert.ok(clients.every((client) => client.closed))
  assert.equal(smokeFailureCount(), failuresBefore)
})
