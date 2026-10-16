import assert from "node:assert/strict"
import { test } from "node:test"

import {
  STREAM_IDLE_TIMEOUT_MS,
  StreamIdleTimeoutError,
  trackExecutingToolCall,
  withIdleTimeout,
} from "./stream-watchdog.ts"

async function* streamOf<T>(
  items: readonly T[],
  { hangAfter = Infinity, delayMs = 0 }: { hangAfter?: number; delayMs?: number } = {}
) {
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
    (err: unknown) => {
      assert.ok(err instanceof StreamIdleTimeoutError)
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
  const source: AsyncIterable<never> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<never>>(() => {}), // never settles
        return: async () => {
          returned = true
          return { done: true as const, value: undefined }
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

test("does not bound a gap while a tool call executes, then bounds the next one", async () => {
  // A tool call, a silent tool run three times the bound, its result, then a
  // provider that never answers again.
  async function* toolTurn() {
    yield { type: "tool-call", toolCallId: "c1" }
    await new Promise((r) => setTimeout(r, 90))
    yield { type: "tool-result", toolCallId: "c1" }
    await new Promise(() => {})
  }
  const executing = new Set<string>()
  const seen: string[] = []
  await assert.rejects(
    async () => {
      for await (const part of withIdleTimeout(toolTurn(), 30, {
        suspended: () => executing.size > 0,
      })) {
        trackExecutingToolCall(executing, part)
        seen.push(part.type)
      }
    },
    (err: unknown) => err instanceof StreamIdleTimeoutError
  )
  assert.deepEqual(seen, ["tool-call", "tool-result"])
})

test("trackExecutingToolCall follows locally executed calls only", () => {
  const executing = new Set<string>()
  trackExecutingToolCall(executing, { type: "tool-call", toolCallId: "a" })
  trackExecutingToolCall(executing, { type: "tool-call", toolCallId: "b" })
  trackExecutingToolCall(executing, { type: "tool-call", toolCallId: "p", providerExecuted: true })
  trackExecutingToolCall(executing, { type: "tool-call", toolCallId: "bad", invalid: true })
  trackExecutingToolCall(executing, { type: "text-delta", text: "x" })
  trackExecutingToolCall(executing, null)
  assert.deepEqual([...executing], ["a", "b"])
  trackExecutingToolCall(executing, { type: "tool-error", toolCallId: "a" })
  assert.deepEqual([...executing], ["b"])
  trackExecutingToolCall(executing, { type: "tool-output-denied", toolCallId: "b" })
  assert.equal(executing.size, 0)
  trackExecutingToolCall(executing, { type: "tool-call", toolCallId: "c" })
  trackExecutingToolCall(executing, { type: "tool-result", toolCallId: "c" })
  assert.equal(executing.size, 0)
})
