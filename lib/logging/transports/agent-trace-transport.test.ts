/**
 * @jest-environment jsdom
 */

import type { StructuredLogEntry } from "@/types/logging"
import type { AgentTraceSpan } from "@/types/agent-trace/span"
import { AGENT_TRACE_SPAN_KIND } from "@/types/agent-trace/span"
import { AgentTraceTransport } from "./agent-trace-transport"

function makeSpan(over: Partial<AgentTraceSpan> = {}): AgentTraceSpan {
  return {
    id: over.id ?? "span-" + Math.random().toString(36).slice(2, 8),
    spanId: over.spanId ?? over.id ?? "span-x",
    traceId: "trace-1",
    startTime: Date.now(),
    operationName: "invoke_agent",
    providerName: "anthropic",
    sessionId: "s1",
    surface: "chat",
    ...over,
  }
}

function makeEntry(span: AgentTraceSpan): StructuredLogEntry {
  return {
    id: span.id,
    timestamp: new Date(span.startTime).toISOString(),
    level: "info",
    message: "x",
    module: "agent.trace",
    data: { kind: AGENT_TRACE_SPAN_KIND, span },
  }
}

describe("AgentTraceTransport.log", () => {
  it("buffers span entries and flushes once the buffer fills", async () => {
    const captured: AgentTraceSpan[][] = []
    const writer = jest.fn(async (spans: AgentTraceSpan[]) => {
      captured.push(spans)
    })
    const t = new AgentTraceTransport({ bufferSize: 2, flushInterval: 0, writer })
    t.log(makeEntry(makeSpan({ id: "a" })))
    expect(writer).not.toHaveBeenCalled()
    t.log(makeEntry(makeSpan({ id: "b" })))
    // log triggers an async flush — wait one microtask
    await Promise.resolve()
    await Promise.resolve()
    expect(writer).toHaveBeenCalledTimes(1)
    expect(captured[0].map((s) => s.id)).toEqual(["a", "b"])
    await t.close()
  })

  it("ignores entries that are not span-shaped", async () => {
    const writer = jest.fn(async () => undefined)
    const t = new AgentTraceTransport({ bufferSize: 1, flushInterval: 0, writer })
    t.log({
      id: "1",
      timestamp: new Date().toISOString(),
      level: "info",
      message: "hello",
      module: "app",
    })
    t.log({
      id: "2",
      timestamp: new Date().toISOString(),
      level: "info",
      message: "with data",
      module: "x",
      data: { kind: "something-else" },
    })
    t.log({
      id: "3",
      timestamp: new Date().toISOString(),
      level: "info",
      message: "malformed",
      module: "agent.trace",
      data: { kind: AGENT_TRACE_SPAN_KIND, span: null },
    })
    await t.flush()
    expect(writer).not.toHaveBeenCalled()
    await t.close()
  })

  it("flush is a no-op when the buffer is empty", async () => {
    const writer = jest.fn(async () => undefined)
    const t = new AgentTraceTransport({ flushInterval: 0, writer })
    await t.flush()
    expect(writer).not.toHaveBeenCalled()
    await t.close()
  })
})

describe("AgentTraceTransport content capture gate", () => {
  it("strips content fields by default", async () => {
    let captured: AgentTraceSpan[] = []
    const t = new AgentTraceTransport({
      bufferSize: 1,
      flushInterval: 0,
      writer: async (spans) => {
        captured = spans
      },
    })
    t.log(makeEntry(makeSpan({ id: "a", inputPreview: "user prompt", outputPreview: "answer" })))
    await Promise.resolve()
    await Promise.resolve()
    expect(captured).toHaveLength(1)
    expect(captured[0].inputPreview).toBeUndefined()
    expect(captured[0].outputPreview).toBeUndefined()
    await t.close()
  })

  it("keeps content when captureContent is on and previews are clean", async () => {
    let captured: AgentTraceSpan[] = []
    const t = new AgentTraceTransport({
      bufferSize: 1,
      flushInterval: 0,
      captureContent: true,
      writer: async (spans) => {
        captured = spans
      },
    })
    t.log(makeEntry(makeSpan({ id: "a", inputPreview: "hello world", outputPreview: "thanks" })))
    await Promise.resolve()
    await Promise.resolve()
    expect(captured[0].inputPreview).toBe("hello world")
    expect(captured[0].outputPreview).toBe("thanks")
    await t.close()
  })

  it("drops fields that fail the PII gate", async () => {
    let captured: AgentTraceSpan[] = []
    const t = new AgentTraceTransport({
      bufferSize: 1,
      flushInterval: 0,
      captureContent: true,
      writer: async (spans) => {
        captured = spans
      },
    })
    t.log(
      makeEntry(
        makeSpan({
          id: "a",
          inputPreview: "email me at jane.doe@example.com",
          outputPreview: "ok",
        })
      )
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(captured[0].inputPreview).toBeUndefined()
    expect(captured[0].outputPreview).toBe("ok")
    await t.close()
  })

  it("truncates preview bytes when captureContent is on", async () => {
    let captured: AgentTraceSpan[] = []
    const t = new AgentTraceTransport({
      bufferSize: 1,
      flushInterval: 0,
      captureContent: true,
      maxPreviewBytes: 8,
      writer: async (spans) => {
        captured = spans
      },
    })
    t.log(
      makeEntry(makeSpan({ id: "a", inputPreview: "abcdefghijklmno", outputPreview: undefined }))
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(captured[0].inputPreview).toBe("abcdefgh")
    await t.close()
  })
})

describe("AgentTraceTransport health + lifecycle", () => {
  it("reports healthy after a successful flush", async () => {
    const t = new AgentTraceTransport({
      bufferSize: 1,
      flushInterval: 0,
      writer: async () => undefined,
    })
    t.log(makeEntry(makeSpan({ id: "h1" })))
    await Promise.resolve()
    await Promise.resolve()
    const snap = t.getHealth()
    expect(snap.transport).toBe("agent-trace")
    expect(snap.status).toBe("healthy")
    expect(snap.queueDepth).toBe(0)
    expect(snap.lastSuccessAt).toBeTruthy()
    await t.close()
  })

  it("reports degraded after a writer failure and counts dropped entries", async () => {
    const t = new AgentTraceTransport({
      bufferSize: 1,
      flushInterval: 0,
      writer: async () => {
        throw new Error("boom")
      },
    })
    t.log(makeEntry(makeSpan({ id: "h2" })))
    await Promise.resolve()
    await Promise.resolve()
    const snap = t.getHealth()
    expect(snap.status).toBe("degraded")
    expect(snap.lastError).toBe("boom")
    expect(snap.droppedEntries).toBe(1)
    await t.close()
  })

  it("updateOptions toggles captureContent at runtime", async () => {
    let captured: AgentTraceSpan[] = []
    const t = new AgentTraceTransport({
      bufferSize: 1,
      flushInterval: 0,
      writer: async (s) => {
        captured = s
      },
    })
    t.updateOptions({ captureContent: true, bufferSize: 1, maxPreviewBytes: 50 })
    t.log(makeEntry(makeSpan({ id: "u1", inputPreview: "ok" })))
    await Promise.resolve()
    await Promise.resolve()
    expect(captured[0].inputPreview).toBe("ok")
    await t.close()
  })

  it("close drains the buffer", async () => {
    const writer = jest.fn(async () => undefined)
    const t = new AgentTraceTransport({ bufferSize: 100, flushInterval: 0, writer })
    t.log(makeEntry(makeSpan({ id: "c1" })))
    expect(t.getPendingCount()).toBe(1)
    await t.close()
    expect(writer).toHaveBeenCalled()
    expect(t.getPendingCount()).toBe(0)
  })

  it("startFlushTimer respects non-positive intervals (no timer)", async () => {
    const t = new AgentTraceTransport({ flushInterval: 0, writer: async () => undefined })
    t.updateOptions({ flushInterval: -1 })
    // no error and no timer alive
    await t.close()
  })
})
