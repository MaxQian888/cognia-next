import assert from "node:assert/strict"
import { test } from "node:test"

import {
  STREAM_IDLE_TIMEOUT_MS,
  StreamIdleTimeoutError,
  withIdleTimeout,
} from "./stream-watchdog.mjs"

async function* streamOf(items, { hangAfter = Infinity, delayMs = 0 } = {}) {
  let i = 0
  for (const item of items) {
    i += 1
    if (i > hangAfter) await new Promise(() => {}) // never settles
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
    yield item
  }
  // Hang when the consumer asks for the item past the end, too — a stalled
  // stream does not answer `next()` at all.
  if (items.length >= hangAfter) await new Promise(() => {})
}

test("passes every event through and ends on done", async () => {
  const seen = []
  for await (const evt of withIdleTimeout(streamOf([1, 2, 3]), 500)) seen.push(evt)
  assert.deepEqual(seen, [1, 2, 3])
})

test("times out when the source never yields again", async () => {
  const started = Date.now()
  await assert.rejects(
    async () => {
      for await (const evt of withIdleTimeout(streamOf(["a"], { hangAfter: 1 }), 30)) {
        void evt
      }
    },
    (err) => {
      assert.equal(err.name, "StreamIdleTimeoutError")
      assert.equal(err.idleMs, 30)
      return true
    }
  )
  assert.ok(Date.now() - started < 500)
})

test("slower-than-timeout gaps still pass through", async () => {
  const seen = []
  for await (const evt of withIdleTimeout(streamOf([1, 2], { delayMs: 15 }), 100)) seen.push(evt)
  assert.deepEqual(seen, [1, 2])
})

test("cancels the source iterator on timeout", async () => {
  let returned = false
  const source = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise(() => {}), // never settles
        return: async () => {
          returned = true
          return { done: true }
        },
      }
    },
  }
  await assert.rejects(async () => {
    for await (const evt of withIdleTimeout(source, 20)) void evt
  })
  assert.equal(returned, true)
})

test("propagates a source error untouched", async () => {
  const boom = new Error("provider blew up")
  async function* failing() {
    yield 1
    throw boom
  }
  await assert.rejects(
    async () => {
      for await (const evt of withIdleTimeout(failing(), 500)) void evt
    },
    (err) => err === boom
  )
})

test("default timeout matches the five-minute provider bound", () => {
  assert.equal(STREAM_IDLE_TIMEOUT_MS, 5 * 60 * 1000)
})
