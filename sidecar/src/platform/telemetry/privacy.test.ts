import assert from "node:assert/strict"
import test from "node:test"
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base"

import { PrivacyFilteringSpanExporter, sanitizeReadableSpan } from "./privacy.ts"

/** A partial span literal standing in for the SDK's ReadableSpan. */
const span = (value: object): ReadableSpan => value as unknown as ReadableSpan
/** A partial exporter literal standing in for an SDK exporter. */
const exporterOf = (value: object): SpanExporter => value as unknown as SpanExporter

test("remote span filtering removes content, tool arguments, files, URLs, and exception text", () => {
  const sanitized = sanitizeReadableSpan(
    span({
      spanContext() {
        return { traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 }
      },
      attributes: {
        "gen_ai.request.model": "gpt-5",
        "gen_ai.input.messages": "private prompt",
        "tool.arguments": "private tool args",
        "cognia.file.path": "/private/file.txt",
        "http.url": "https://private.example/path",
        "exception.message": "private exception",
      },
      status: { code: 2, message: "private failure" },
      resource: {
        attributes: {
          "service.name": "cognia-sidecar",
          "process.command": "/Users/private/bin/node",
        },
      },
      events: [
        {
          name: "generation.status",
          attributes: { "exception.stacktrace": "private stack", "cognia.span.status": "failed" },
        },
      ],
    })
  )
  const payload = JSON.stringify(sanitized)
  assert.equal(payload.includes("private"), false)
  assert.equal(sanitized.attributes["gen_ai.request.model"], "gpt-5")
  assert.equal(sanitized.events[0]?.attributes?.["cognia.span.status"], "failed")
  assert.deepEqual(sanitized.status, { code: 2 })
  assert.deepEqual(sanitized.resource.attributes, { "service.name": "cognia-sidecar" })
  assert.equal(sanitized.spanContext().traceId, "a".repeat(32))
})

test("remote span filtering drops a sanitized span when an allowed value still contains PII", () => {
  let delegated = false
  let result: unknown
  const exporter = new PrivacyFilteringSpanExporter(
    exporterOf({
      export() {
        delegated = true
      },
      shutdown: async () => undefined,
    })
  )
  exporter.export(
    [
      span({
        name: "chat jane.doe@example.com",
        attributes: { "gen_ai.request.model": "model@example.com" },
        events: [],
      }),
    ],
    (value) => {
      result = value
    }
  )

  assert.equal(delegated, false)
  assert.deepEqual(result, { code: 0 })
})

test("remote span filtering forwards safe spans and removes only unsafe members of a batch", () => {
  let delegatedSpans: ReadableSpan[] = []
  const exporter = new PrivacyFilteringSpanExporter(
    exporterOf({
      export(spans: ReadableSpan[], callback: (result: { code: number }) => void) {
        delegatedSpans = spans
        callback({ code: 0 })
      },
      shutdown: async () => undefined,
    })
  )
  exporter.export(
    [
      span({
        name: "chat jane.doe@example.com",
        attributes: { "gen_ai.request.model": "model@example.com" },
        events: [],
      }),
      span({
        name: "chat gpt-5",
        attributes: { "gen_ai.request.model": "gpt-5" },
        events: [],
      }),
    ],
    () => undefined
  )

  assert.equal(delegatedSpans.length, 1)
  assert.equal(delegatedSpans[0]?.name, "chat gpt-5")
})

test("privacy filtering exporter forwards lifecycle calls when supported", async () => {
  let shutdownCalls = 0
  let flushCalls = 0
  const exporter = new PrivacyFilteringSpanExporter(
    exporterOf({
      export() {},
      shutdown: async () => {
        shutdownCalls += 1
      },
      forceFlush: async () => {
        flushCalls += 1
      },
    })
  )

  await exporter.forceFlush()
  await exporter.shutdown()

  assert.equal(flushCalls, 1)
  assert.equal(shutdownCalls, 1)

  const exporterWithoutFlush = new PrivacyFilteringSpanExporter(
    exporterOf({
      export() {},
      shutdown: async () => undefined,
    })
  )
  await exporterWithoutFlush.forceFlush()
})
