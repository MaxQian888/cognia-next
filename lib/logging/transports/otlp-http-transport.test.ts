/**
 * @jest-environment jsdom
 */

import type { StructuredLogEntry } from "@/types/logging"
import type { AgentTraceSpan } from "@/types/agent-trace/span"
import { AGENT_TRACE_SPAN_KIND } from "@/types/agent-trace/span"
import { OtlpHttpTransport } from "./otlp-http-transport"

function makeSpan(over: Partial<AgentTraceSpan> = {}): AgentTraceSpan {
  return {
    id: over.id ?? "1111222233334444",
    spanId: over.spanId ?? over.id ?? "1111222233334444",
    traceId: "deadbeefdeadbeefdeadbeefdeadbeef",
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_000_250,
    durationMs: 250,
    operationName: "invoke_agent",
    providerName: "anthropic",
    sessionId: "session-1",
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

function makeOkResponse(): Response {
  return new Response("", { status: 200 })
}

function makeErrorResponse(status: number): Response {
  return new Response("rejected", { status })
}

describe("OtlpHttpTransport buffering & flush", () => {
  it("buffers and auto-flushes once the buffer fills", async () => {
    // Typed signature so `fetchMock.mock.calls[0]` destructures into
    // [url, init] instead of jest's default empty tuple inference.
    const fetchMock = jest.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      makeOkResponse()
    )
    const t = new OtlpHttpTransport({
      endpoint: "http://collector.local/v1/traces",
      bufferSize: 2,
      flushInterval: 0,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    t.log(makeEntry(makeSpan({ id: "a" })))
    expect(fetchMock).not.toHaveBeenCalled()
    t.log(makeEntry(makeSpan({ id: "b" })))
    await Promise.resolve()
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]
    expect(init?.method).toBe("POST")
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json")
    const body = JSON.parse(init!.body as string)
    expect(body.resourceSpans).toBeDefined()
    expect(body.resourceSpans[0].scopeSpans[0].spans).toHaveLength(2)
    await t.close()
  })

  it("ignores non-span log entries", async () => {
    const fetchMock = jest.fn(async () => makeOkResponse())
    const t = new OtlpHttpTransport({
      endpoint: "http://collector.local/v1/traces",
      bufferSize: 1,
      flushInterval: 0,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    t.log({
      id: "1",
      timestamp: new Date().toISOString(),
      level: "info",
      message: "hello",
      module: "app",
    })
    await t.flush()
    expect(fetchMock).not.toHaveBeenCalled()
    await t.close()
  })

  it("silently drops spans when endpoint is empty (degraded transport)", async () => {
    const fetchMock = jest.fn()
    const t = new OtlpHttpTransport({
      endpoint: "",
      bufferSize: 1,
      flushInterval: 0,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    t.log(makeEntry(makeSpan({ id: "a" })))
    await Promise.resolve()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(t.getHealth().status).toBe("degraded")
    await t.close()
  })

  it("flush no-ops when buffer is empty", async () => {
    const fetchMock = jest.fn(async () => makeOkResponse())
    const t = new OtlpHttpTransport({
      endpoint: "http://collector.local/v1/traces",
      flushInterval: 0,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    await t.flush()
    expect(fetchMock).not.toHaveBeenCalled()
    await t.close()
  })

  it("close drains the buffer", async () => {
    const fetchMock = jest.fn(async () => makeOkResponse())
    const t = new OtlpHttpTransport({
      endpoint: "http://collector.local/v1/traces",
      bufferSize: 100,
      flushInterval: 0,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    t.log(makeEntry(makeSpan({ id: "a" })))
    expect(t.getPendingCount()).toBe(1)
    await t.close()
    expect(fetchMock).toHaveBeenCalled()
    expect(t.getPendingCount()).toBe(0)
  })

  it("can discard a pending batch without sending after consent withdrawal", async () => {
    const fetchMock = jest.fn(async () => makeOkResponse())
    const t = new OtlpHttpTransport({
      endpoint: "http://collector.local/v1/traces",
      bufferSize: 10,
      flushInterval: 0,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    t.log(makeEntry(makeSpan({ id: "pending" })))
    t.discardPending()
    await t.close()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(t.getHealth().droppedEntries).toBe(1)
  })

  it("splits serialized requests at the configured byte limit", async () => {
    const maxRequestBytes = 1_600
    const bodies: string[] = []
    const fetchMock = jest.fn(async (_url, init) => {
      bodies.push(init!.body as string)
      return makeOkResponse()
    })
    const t = new OtlpHttpTransport({
      endpoint: "http://collector.local/v1/traces",
      bufferSize: 10,
      flushInterval: 0,
      maxRequestBytes,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    t.log(makeEntry(makeSpan({ id: "a", providerName: "a".repeat(300) })))
    t.log(makeEntry(makeSpan({ id: "b", providerName: "b".repeat(300) })))

    await t.close()

    expect(bodies.length).toBeGreaterThan(1)
    expect(
      bodies.every((body) => new TextEncoder().encode(body).byteLength <= maxRequestBytes)
    ).toBe(true)
  })

  it("waits for an already in-flight flush before close resolves", async () => {
    let resolveFirst!: (response: Response) => void
    const firstRequest = new Promise<Response>((resolve) => {
      resolveFirst = resolve
    })
    const fetchMock = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockImplementationOnce(async () => firstRequest)
      .mockImplementation(async () => makeOkResponse())
    const t = new OtlpHttpTransport({
      endpoint: "http://collector.local/v1/traces",
      bufferSize: 1,
      flushInterval: 0,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    t.log(makeEntry(makeSpan({ id: "first" })))
    await Promise.resolve()
    t.log(makeEntry(makeSpan({ id: "second" })))

    let closed = false
    const close = t.close().then(() => {
      closed = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(closed).toBe(false)

    resolveFirst(makeOkResponse())
    await close
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("aborts an in-flight request when consent is withdrawn", async () => {
    let resolveRequest!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => {
      resolveRequest = resolve
    })
    const fetchMock = jest.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => pending)
    const t = new OtlpHttpTransport({
      endpoint: "http://collector.local/v1/traces",
      bufferSize: 1,
      flushInterval: 0,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    t.log(makeEntry(makeSpan({ id: "in-flight" })))
    await Promise.resolve()
    const signal = fetchMock.mock.calls[0]?.[1]?.signal

    t.discardPending()

    expect(signal?.aborted).toBe(true)
    resolveRequest(makeOkResponse())
    await t.close()
  })

  it("does not send a later split after consent is withdrawn during the first request", async () => {
    let resolveFirst!: (response: Response) => void
    const firstRequest = new Promise<Response>((resolve) => {
      resolveFirst = resolve
    })
    const fetchMock = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockImplementationOnce(async () => firstRequest)
      .mockImplementation(async () => makeOkResponse())
    const t = new OtlpHttpTransport({
      endpoint: "http://collector.local/v1/traces",
      bufferSize: 10,
      flushInterval: 0,
      maxRequestBytes: 1_600,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    t.log(makeEntry(makeSpan({ id: "a", providerName: "a".repeat(300) })))
    t.log(makeEntry(makeSpan({ id: "b", providerName: "b".repeat(300) })))
    const flush = t.flush()
    await Promise.resolve()
    await Promise.resolve()

    t.discardPending()
    resolveFirst(makeOkResponse())
    await flush
    await t.close()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(t.getHealth().droppedEntries).toBe(2)
  })

  it("drops one span that cannot fit and reports the byte-limit failure", async () => {
    const fetchMock = jest.fn(async () => makeOkResponse())
    const t = new OtlpHttpTransport({
      endpoint: "http://collector.local/v1/traces",
      bufferSize: 1,
      flushInterval: 0,
      maxRequestBytes: 100,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    t.log(makeEntry(makeSpan({ id: "oversized" })))
    await t.close()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(t.getHealth()).toMatchObject({
      status: "degraded",
      droppedEntries: 1,
      lastError: "OTLP payload exceeds 100 byte limit",
    })
  })
})

describe("OtlpHttpTransport retry & failure handling", () => {
  it("retries transient 5xx with exponential backoff and recovers", async () => {
    const responses = [makeErrorResponse(503), makeErrorResponse(502), makeOkResponse()]
    const fetchMock = jest.fn(async () => responses.shift()!)
    const sleepMock = jest.fn(async () => {})
    const t = new OtlpHttpTransport({
      endpoint: "http://collector.local/v1/traces",
      bufferSize: 1,
      flushInterval: 0,
      maxRetries: 3,
      retryBaseMs: 1,
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleepImpl: sleepMock,
    })
    t.log(makeEntry(makeSpan({ id: "a" })))
    await Promise.resolve()
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 5))
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const health = t.getHealth()
    expect(health.status).toBe("healthy")
    expect(health.lastSuccessAt).toBeTruthy()
    expect(health.retryCount).toBeGreaterThanOrEqual(2)
    await t.close()
  })

  it("does not retry 4xx (non-retryable) and counts the batch as dropped", async () => {
    const fetchMock = jest.fn(async () => makeErrorResponse(401))
    const sleepMock = jest.fn(async () => {})
    const t = new OtlpHttpTransport({
      endpoint: "http://collector.local/v1/traces",
      bufferSize: 1,
      flushInterval: 0,
      maxRetries: 5,
      retryBaseMs: 1,
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleepImpl: sleepMock,
    })
    t.log(makeEntry(makeSpan({ id: "a" })))
    await Promise.resolve()
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 5))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sleepMock).not.toHaveBeenCalled()
    const health = t.getHealth()
    expect(health.status).toBe("degraded")
    expect(health.droppedEntries).toBe(1)
    expect(health.lastError).toMatch(/401/)
    await t.close()
  })

  it("retries 429 (rate-limited) as a transient failure", async () => {
    const responses = [makeErrorResponse(429), makeOkResponse()]
    const fetchMock = jest.fn(async () => responses.shift()!)
    const t = new OtlpHttpTransport({
      endpoint: "http://collector.local/v1/traces",
      bufferSize: 1,
      flushInterval: 0,
      maxRetries: 3,
      retryBaseMs: 1,
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleepImpl: async () => {},
    })
    t.log(makeEntry(makeSpan({ id: "a" })))
    await new Promise((r) => setTimeout(r, 5))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(t.getHealth().status).toBe("healthy")
    await t.close()
  })

  it("does not retry an OTLP 500 response", async () => {
    const fetchMock = jest.fn(async () => makeErrorResponse(500))
    const sleepMock = jest.fn(async () => {})
    const t = new OtlpHttpTransport({
      endpoint: "http://collector.local/v1/traces",
      bufferSize: 1,
      flushInterval: 0,
      maxRetries: 3,
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleepImpl: sleepMock,
    })
    t.log(makeEntry(makeSpan({ id: "a" })))
    await t.close()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sleepMock).not.toHaveBeenCalled()
    expect(t.getHealth().droppedEntries).toBe(1)
  })

  it("honors Retry-After on retryable responses", async () => {
    const responses = [
      new Response("rate limited", { status: 429, headers: { "Retry-After": "2" } }),
      makeOkResponse(),
    ]
    const fetchMock = jest.fn(async () => responses.shift()!)
    const sleepMock = jest.fn(async () => {})
    const t = new OtlpHttpTransport({
      endpoint: "http://collector.local/v1/traces",
      bufferSize: 1,
      flushInterval: 0,
      maxRetries: 1,
      retryBaseMs: 1,
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleepImpl: sleepMock,
      randomImpl: () => 0,
    })
    t.log(makeEntry(makeSpan({ id: "a" })))
    await t.close()

    expect(sleepMock).toHaveBeenCalledWith(2_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("drops the batch after exhausting retries on network errors", async () => {
    const fetchMock = jest.fn(async () => {
      throw new Error("network down")
    })
    const t = new OtlpHttpTransport({
      endpoint: "http://collector.local/v1/traces",
      bufferSize: 1,
      flushInterval: 0,
      maxRetries: 2,
      retryBaseMs: 1,
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleepImpl: async () => {},
    })
    t.log(makeEntry(makeSpan({ id: "a" })))
    await new Promise((r) => setTimeout(r, 5))
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const health = t.getHealth()
    expect(health.droppedEntries).toBe(1)
    expect(health.lastError).toMatch(/network down/)
    await t.close()
  })
})

describe("OtlpHttpTransport content gate", () => {
  it("drops the final serialized batch when an allowed identifier contains PII", async () => {
    const fetchMock = jest.fn(async () => makeOkResponse())
    const t = new OtlpHttpTransport({
      endpoint: "http://collector.local/v1/traces",
      bufferSize: 1,
      flushInterval: 0,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    t.log(makeEntry(makeSpan({ providerName: "jane.doe@example.com" })))

    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(t.getHealth()).toMatchObject({
      status: "degraded",
      droppedEntries: 1,
      lastError: "OTLP payload rejected by privacy gate",
    })
    await t.close()
  })

  it("strips content and exception messages when captureContent is off", async () => {
    let captured: unknown = null
    const fetchMock = jest.fn(async (_url, init) => {
      captured = JSON.parse(init!.body as string)
      return makeOkResponse()
    })
    const t = new OtlpHttpTransport({
      endpoint: "http://collector.local/v1/traces",
      bufferSize: 1,
      flushInterval: 0,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    t.log(
      makeEntry(
        makeSpan({
          id: "a",
          inputPreview: "secret prompt",
          outputPreview: "secret reply",
          errorMessage: "private exception body",
          agentName: "private agent description",
          metadata: { filePath: "/private/file.txt", arbitrary: "private metadata" },
          events: [
            { at: 1_700_000_000_100, name: "exception", attributes: { message: "private event" } },
          ],
        })
      )
    )
    await new Promise((r) => setTimeout(r, 5))
    const body = captured as {
      resourceSpans: Array<{
        scopeSpans: Array<{ spans: Array<{ attributes: Array<{ key: string }> }> }>
      }>
    }
    const attrs = body.resourceSpans[0].scopeSpans[0].spans[0].attributes
    expect(attrs.find((a) => a.key === "gen_ai.input.messages")).toBeUndefined()
    expect(attrs.find((a) => a.key === "gen_ai.output.messages")).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain("private exception body")
    expect(JSON.stringify(body)).not.toContain("private metadata")
    expect(JSON.stringify(body)).not.toContain("private event")
    await t.close()
  })

  it("keeps content when captureContent is on and previews are clean", async () => {
    let captured: unknown = null
    const fetchMock = jest.fn(async (_url, init) => {
      captured = JSON.parse(init!.body as string)
      return makeOkResponse()
    })
    const t = new OtlpHttpTransport({
      endpoint: "http://collector.local/v1/traces",
      bufferSize: 1,
      flushInterval: 0,
      captureContent: true,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    t.log(makeEntry(makeSpan({ id: "a", inputPreview: "hello", outputPreview: "world" })))
    await new Promise((r) => setTimeout(r, 5))
    const body = captured as {
      resourceSpans: Array<{
        scopeSpans: Array<{
          spans: Array<{ attributes: Array<{ key: string; value: { stringValue?: string } }> }>
        }>
      }>
    }
    const attrs = body.resourceSpans[0].scopeSpans[0].spans[0].attributes
    expect(attrs.find((a) => a.key === "gen_ai.input.messages")?.value.stringValue).toBe("hello")
    await t.close()
  })

  it("strips fields that fail the PII gate when capture is on", async () => {
    let captured: unknown = null
    const fetchMock = jest.fn(async (_url, init) => {
      captured = JSON.parse(init!.body as string)
      return makeOkResponse()
    })
    const t = new OtlpHttpTransport({
      endpoint: "http://collector.local/v1/traces",
      bufferSize: 1,
      flushInterval: 0,
      captureContent: true,
      fetchImpl: fetchMock as unknown as typeof fetch,
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
    await new Promise((r) => setTimeout(r, 5))
    const body = captured as {
      resourceSpans: Array<{
        scopeSpans: Array<{ spans: Array<{ attributes: Array<{ key: string }> }> }>
      }>
    }
    const attrs = body.resourceSpans[0].scopeSpans[0].spans[0].attributes
    expect(attrs.find((a) => a.key === "gen_ai.input.messages")).toBeUndefined()
    expect(attrs.find((a) => a.key === "gen_ai.output.messages")).toBeDefined()
    await t.close()
  })
})

describe("OtlpHttpTransport options + resource", () => {
  it("forwards configured headers verbatim and applies resource metadata", async () => {
    let lastInit: RequestInit | undefined
    let body: unknown = null
    const fetchMock = jest.fn(async (_url, init) => {
      lastInit = init
      body = JSON.parse(init!.body as string)
      return makeOkResponse()
    })
    const t = new OtlpHttpTransport({
      endpoint: "https://otlp-gateway.example/v1/traces",
      headers: { Authorization: "Basic abc==" },
      resource: { serviceName: "svc-test", environment: "prod", serviceVersion: "1.2.3" },
      bufferSize: 1,
      flushInterval: 0,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    t.log(makeEntry(makeSpan()))
    await new Promise((r) => setTimeout(r, 5))
    expect((lastInit?.headers as Record<string, string>).Authorization).toBe("Basic abc==")
    const resAttrs = (
      body as {
        resourceSpans: Array<{
          resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> }
        }>
      }
    ).resourceSpans[0].resource.attributes
    expect(resAttrs.find((a) => a.key === "service.name")?.value.stringValue).toBe("svc-test")
    expect(resAttrs.find((a) => a.key === "deployment.environment.name")?.value.stringValue).toBe(
      "prod"
    )
    expect(resAttrs.find((a) => a.key === "service.version")?.value.stringValue).toBe("1.2.3")
    await t.close()
  })

  it("updateOptions can change endpoint and headers at runtime", async () => {
    const fetchMock = jest.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      makeOkResponse()
    )
    const t = new OtlpHttpTransport({
      endpoint: "http://a.local/v1/traces",
      headers: { "X-Tenant": "v1" },
      bufferSize: 1,
      flushInterval: 0,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    t.updateOptions({ endpoint: "http://b.local/v1/traces", headers: { "X-Tenant": "v2" } })
    t.log(makeEntry(makeSpan()))
    await new Promise((r) => setTimeout(r, 5))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("http://b.local/v1/traces")
    expect((init?.headers as Record<string, string>)["X-Tenant"]).toBe("v2")
    await t.close()
  })

  it("discards old in-flight work before switching an authenticated destination", async () => {
    let resolveFirst!: (response: Response) => void
    const firstRequest = new Promise<Response>((resolve) => {
      resolveFirst = resolve
    })
    const fetchMock = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockImplementationOnce(async () => firstRequest)
      .mockImplementation(async () => makeOkResponse())
    const t = new OtlpHttpTransport({
      endpoint: "http://a.local/v1/traces",
      destinationFingerprint: "project-a",
      bufferSize: 1,
      flushInterval: 0,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    t.log(makeEntry(makeSpan({ id: "old" })))
    await Promise.resolve()
    const oldSignal = fetchMock.mock.calls[0]?.[1]?.signal

    t.updateOptions({
      endpoint: "http://b.local/v1/traces",
      destinationFingerprint: "project-b",
    })
    t.log(makeEntry(makeSpan({ id: "new" })))
    resolveFirst(makeOkResponse())
    await t.close()

    expect(oldSignal?.aborted).toBe(true)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://a.local/v1/traces",
      "http://b.local/v1/traces",
    ])
  })
})

describe("drop attribution", () => {
  it("attributes an export failure to ship-failed and keeps the totals honest", async () => {
    const { dropCountsSumTo } = await import("@cognia/logging/types/transport")
    const t = new OtlpHttpTransport({
      endpoint: "http://collector.local/v1/traces",
      bufferSize: 1,
      flushInterval: 0,
      maxRetries: 0,
      fetchImpl: (async () => makeErrorResponse(500)) as unknown as typeof fetch,
    })
    t.log(makeEntry(makeSpan({ id: "a" })))
    await t.flush()

    const health = t.getHealth()
    expect(health.droppedEntries).toBeGreaterThan(0)
    expect(health.droppedByReason?.["ship-failed"]).toBe(health.droppedEntries)
    expect(dropCountsSumTo(health)).toBe(true)
  })

  it("attributes a consent discard to shutdown-discarded, not to a shipping failure", async () => {
    const { dropCountsSumTo } = await import("@cognia/logging/types/transport")
    const t = new OtlpHttpTransport({
      endpoint: "http://collector.local/v1/traces",
      bufferSize: 100,
      flushInterval: 0,
      fetchImpl: (async () => makeOkResponse()) as unknown as typeof fetch,
    })
    t.log(makeEntry(makeSpan({ id: "a" })))
    t.discardPending()

    const health = t.getHealth()
    expect(health.droppedEntries).toBeGreaterThan(0)
    expect(health.droppedByReason?.["shutdown-discarded"]).toBe(health.droppedEntries)
    expect(health.droppedByReason?.["ship-failed"]).toBeUndefined()
    expect(dropCountsSumTo(health)).toBe(true)
  })

  it("starts with nothing lost and nothing to explain", async () => {
    const { dropCountsSumTo } = await import("@cognia/logging/types/transport")
    const t = new OtlpHttpTransport({
      endpoint: "http://collector.local/v1/traces",
      flushInterval: 0,
      fetchImpl: (async () => makeOkResponse()) as unknown as typeof fetch,
    })
    const health = t.getHealth()
    expect(health.droppedEntries).toBe(0)
    expect(dropCountsSumTo(health)).toBe(true)
  })
})
