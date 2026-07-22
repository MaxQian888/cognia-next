import { test } from "node:test"
import assert from "node:assert/strict"
import { makeInputStream } from "./input-stream.mjs"

test("push reports acceptance for queued and waiting consumers", async () => {
  const queued = makeInputStream()
  assert.equal(queued.push("queued"), true)
  const queuedIterator = queued.iterable[Symbol.asyncIterator]()
  assert.deepEqual(await queuedIterator.next(), { value: "queued", done: false })

  const waiting = makeInputStream()
  const waitingIterator = waiting.iterable[Symbol.asyncIterator]()
  const next = waitingIterator.next()
  assert.equal(waiting.push("waiting"), true)
  assert.deepEqual(await next, { value: "waiting", done: false })
})

test("close settles waiters and rejects every later push", async () => {
  const stream = makeInputStream()
  const iterator = stream.iterable[Symbol.asyncIterator]()
  const next = iterator.next()
  stream.close()

  assert.deepEqual(await next, { value: undefined, done: true })
  assert.equal(stream.push("too late"), false)
  assert.deepEqual(await iterator.next(), { value: undefined, done: true })
})
