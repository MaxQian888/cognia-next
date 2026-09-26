import { test } from "node:test"
import assert from "node:assert/strict"
import { makeInputStream } from "./input-stream.ts"

test("push reports acceptance for queued and waiting consumers", async () => {
  const queued = makeInputStream<string>()
  assert.equal(queued.push("queued"), true)
  const queuedIterator = queued.iterable[Symbol.asyncIterator]()
  assert.deepEqual(await queuedIterator.next(), { value: "queued", done: false })

  const waiting = makeInputStream<string>()
  const waitingIterator = waiting.iterable[Symbol.asyncIterator]()
  const next = waitingIterator.next()
  assert.equal(waiting.push("waiting"), true)
  assert.deepEqual(await next, { value: "waiting", done: false })
})

test("close settles waiters and rejects every later push", async () => {
  const stream = makeInputStream<string>()
  const iterator = stream.iterable[Symbol.asyncIterator]()
  const next = iterator.next()
  stream.close()

  assert.deepEqual(await next, { value: undefined, done: true })
  assert.equal(stream.push("too late"), false)
  assert.deepEqual(await iterator.next(), { value: undefined, done: true })
})

test("queued items drain in order before the stream reports done", async () => {
  const stream = makeInputStream<number>()
  stream.push(1)
  stream.push(2)
  stream.close()
  const seen: number[] = []
  for await (const item of stream.iterable) seen.push(item)
  assert.deepEqual(seen, [1, 2])
})

test("returning from the iterator (a for-await break) closes the stream", async () => {
  const stream = makeInputStream<string>()
  stream.push("first")
  for await (const item of stream.iterable) {
    assert.equal(item, "first")
    break
  }
  assert.equal(stream.push("after break"), false)
})
