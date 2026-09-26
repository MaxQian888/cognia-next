// The sidecar used to emit spans ONLY through OTLP, so a default install (no
// collector configured) recorded nothing for the out-of-process half of a turn.

import assert from "node:assert/strict"
import test from "node:test"

import { randomSpanId, traceAsyncIterable } from "./local-spans.ts"
import type { LocalSpan } from "./local-spans.ts"

type Emitted = { type: "agent_trace_span" } & LocalSpan

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const seen: T[] = []
  for await (const item of iterable) seen.push(item)
  return seen
}

test("stays a plain pass-through when neither an exporter nor an emitter exists", async () => {
  const source = (async function* () {
    yield 1
  })()
  // Identity, not a wrapper: no proxy on the hot path when nothing consumes it.
  assert.equal(traceAsyncIterable("n", undefined, {}, source), source)
})

test("repatriates a finished span to the emitter with no OTLP endpoint", async () => {
  const emitted: Emitted[] = []
  const source = (async function* () {
    yield "a"
    yield "b"
  })()
  const wrapped = traceAsyncIterable(
    "gen_ai.invoke_agent",
    "00-" + "a".repeat(32) + "-" + "b".repeat(16) + "-01",
    { "gen_ai.request.model": "claude-opus-5" },
    source,
    { emit: (event) => emitted.push(event), sessionId: "session-1" }
  )
  assert.deepEqual(await drain(wrapped), ["a", "b"])
  assert.equal(emitted.length, 1)
  const span = emitted[0]
  assert.ok(span)
  assert.equal(span.type, "agent_trace_span")
  assert.equal(span.sessionId, "session-1")
  assert.equal(span.operationName, "invoke_agent")
  assert.equal(span.providerName, "anthropic")
  // The traceparent is echoed back verbatim so the renderer — which owns the
  // W3C parser — reattaches the span under the turn that spawned it.
  assert.equal(span.traceparent, "00-" + "a".repeat(32) + "-" + "b".repeat(16) + "-01")
  assert.match(span.spanId, /^[0-9a-f]{16}$/)
  assert.equal(typeof span.startTime, "number")
  assert.ok(span.durationMs >= 0)
  assert.deepEqual(span.attributes, { "gen_ai.request.model": "claude-opus-5" })
  assert.equal(span.errorType, undefined)
})

test("repatriates a failed stream with its error and emits exactly once", async () => {
  const emitted: Emitted[] = []
  const source = (async function* () {
    yield "a"
    throw new TypeError("stream died")
  })()
  const wrapped = traceAsyncIterable("gen_ai.invoke_agent", undefined, {}, source, {
    emit: (event) => emitted.push(event),
  })
  await assert.rejects(() => drain(wrapped), /stream died/)
  // `finish` runs from both the catch and the finally — the span must not double.
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0]?.errorType, "TypeError")
  assert.equal(emitted[0]?.errorMessage, "stream died")
})

test("mints a distinct span id per wrapped stream", () => {
  const ids = new Set<string>()
  for (let i = 0; i < 50; i++) ids.add(randomSpanId())
  assert.equal(ids.size, 50)
  for (const id of ids) assert.match(id, /^[0-9a-f]{16}$/)
})

test("a throwing emitter never breaks the stream it measures", async () => {
  const source = (async function* () {
    yield "a"
  })()
  const wrapped = traceAsyncIterable("n", undefined, {}, source, {
    emit: () => {
      throw new Error("host channel closed")
    },
  })
  assert.deepEqual(await drain(wrapped), ["a"])
})

test("forwards non-iterator properties to the wrapped query object", async () => {
  let reconnected: string | null = null
  const source = {
    reconnectMcpServer(name: string) {
      reconnected = name
      return "ok"
    },
    async *[Symbol.asyncIterator]() {
      yield "a"
    },
  }
  const wrapped = traceAsyncIterable("n", undefined, {}, source, { emit: () => {} })
  // The SDK's query object carries control methods the dispatcher calls.
  assert.equal(wrapped.reconnectMcpServer("lark"), "ok")
  assert.equal(reconnected, "lark")
  assert.deepEqual(await drain(wrapped), ["a"])
})
