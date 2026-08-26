import type { StructuredLogEntry } from "@/types/logging"
import { structuredLogEntriesToOtlpLogs } from "@cognia/logging/otlp-log-record"
import {
  createOtlpLogTransport,
  OtlpLogTransport,
  type OtlpLogTransportOptions,
} from "./otlp-log-transport"

function entry(overrides: Partial<StructuredLogEntry> = {}): StructuredLogEntry {
  return {
    id: "log-01",
    timestamp: "2026-08-26T08:09:10.123Z",
    level: "warn",
    message: "Connection retry scheduled",
    module: "network:sync",
    data: { attempt: 2 },
    ...overrides,
  }
}

describe("OTLP Logs transport", () => {
  it("exports ordinary structured logs and excludes synthetic Agent Trace entries", async () => {
    const fetchImpl = jest.fn(async () => new Response("", { status: 200 }))
    const transport = new OtlpLogTransport({
      endpoint: "https://collector.example/v1/logs",
      resource: { serviceName: "cognia-renderer" },
      bufferSize: 10,
      flushInterval: 0,
      fetchImpl,
    })

    transport.log(entry())
    transport.log(
      entry({
        id: "span-log",
        module: "agent.trace",
        data: { kind: "agent-trace-span", span: { id: "span-01" } },
      })
    )
    await transport.flush()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [endpoint, init] = fetchImpl.mock.calls[0]
    expect(endpoint).toBe("https://collector.example/v1/logs")
    expect(init?.method).toBe("POST")
    const payload = JSON.parse(String(init?.body))
    expect(payload.resourceLogs[0].scopeLogs[0].logRecords).toHaveLength(1)
    expect(payload.resourceLogs[0].scopeLogs[0].logRecords[0]).toMatchObject({
      severityNumber: 13,
      severityText: "WARN",
      body: { stringValue: "Connection retry scheduled" },
    })
    expect(transport.getHealth()).toMatchObject({
      transport: "otlp-logs",
      status: "healthy",
      queueDepth: 0,
      droppedEntries: 0,
    })
  })

  it("rejects a leaking entry before it reaches the sender", async () => {
    const fetchImpl = jest.fn(async () => new Response("", { status: 200 }))
    const transport = new OtlpLogTransport({
      endpoint: "https://collector.example/v1/logs",
      flushInterval: 0,
      fetchImpl,
    })

    transport.log(entry({ message: "email alice@example.com" }))
    await transport.flush()

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(transport.getHealth()).toMatchObject({
      status: "degraded",
      droppedEntries: 1,
      droppedByReason: { "entry-rejected": 1 },
      lastError: "OTLP log payload rejected by privacy gate",
    })
  })

  it("retries transient failures without losing the batch", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }))
    const sleepImpl = jest.fn(async () => undefined)
    const transport = new OtlpLogTransport({
      endpoint: "https://collector.example/v1/logs",
      flushInterval: 0,
      maxRetries: 1,
      fetchImpl,
      sleepImpl,
      randomImpl: () => 0,
    })

    transport.log(entry())
    await transport.flush()

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(sleepImpl).toHaveBeenCalledTimes(1)
    expect(transport.getHealth()).toMatchObject({ status: "healthy", retryCount: 1 })
  })

  it("updates runtime options and bounds the queue across discard and shutdown", async () => {
    const replacementFetch = jest.fn(async () => new Response("", { status: 200 }))
    const initialFetch = jest.fn(async () => new Response("", { status: 200 }))
    const transport = createOtlpLogTransport({
      endpoint: "",
      flushInterval: 0,
      fetchImpl: initialFetch,
    })

    transport.updateOptions({
      endpoint: "https://collector.example/v1/logs",
      resource: { serviceName: "updated-service" },
      bufferSize: 100,
      maxQueueEntries: 1,
      flushInterval: 50,
      maxRetries: 0,
      retryBaseMs: 0,
      requestTimeoutMs: 0,
      maxRequestBytes: 10_000,
      fetchImpl: replacementFetch,
      sleepImpl: async () => undefined,
      randomImpl: () => 1,
    })
    transport.log(entry({ id: "evicted" }))
    transport.log(entry({ id: "pending" }))

    expect(transport.getPendingCount()).toBe(1)
    expect(transport.getHealth()).toMatchObject({
      droppedEntries: 1,
      droppedByReason: { "overflow-evicted": 1 },
    })

    transport.discardPending()
    await transport.close()
    transport.log(entry({ id: "after-close" }))

    expect(replacementFetch).not.toHaveBeenCalled()
    expect(transport.getHealth()).toMatchObject({
      queueDepth: 0,
      droppedEntries: 3,
      droppedByReason: {
        "overflow-evicted": 1,
        "shutdown-discarded": 2,
      },
    })
  })

  it("splits oversized batches and rejects an oversized singleton", async () => {
    const first = entry({ id: "log-01", message: "first safe payload" })
    const second = entry({ id: "log-02", message: "second safe payload" })
    const resource = { serviceName: "cognia-renderer" }
    const bytes = (entries: StructuredLogEntry[]) =>
      new TextEncoder().encode(JSON.stringify(structuredLogEntriesToOtlpLogs(entries, resource)))
        .byteLength
    const splitLimit = Math.floor((bytes([first]) + bytes([first, second])) / 2)
    const fetchImpl = jest.fn(async () => new Response("", { status: 200 }))
    const splitTransport = new OtlpLogTransport({
      endpoint: "https://collector.example/v1/logs",
      resource,
      bufferSize: 10,
      flushInterval: 0,
      maxRequestBytes: splitLimit,
      fetchImpl,
    })

    splitTransport.log(first)
    splitTransport.log(second)
    await splitTransport.flush()

    expect(fetchImpl).toHaveBeenCalledTimes(2)

    const rejectingTransport = new OtlpLogTransport({
      endpoint: "https://collector.example/v1/logs",
      resource,
      flushInterval: 0,
      maxRequestBytes: bytes([first]) - 1,
      fetchImpl,
    })
    rejectingTransport.log(first)
    await rejectingTransport.flush()

    expect(rejectingTransport.getHealth()).toMatchObject({
      status: "degraded",
      droppedEntries: 1,
      droppedByReason: { "entry-rejected": 1 },
      lastError: expect.stringContaining("byte limit"),
    })
  })

  it("records permanent responses and thrown sender failures", async () => {
    const rejected = new OtlpLogTransport({
      endpoint: "https://collector.example/v1/logs",
      flushInterval: 0,
      maxRetries: 2,
      requestTimeoutMs: 0,
      fetchImpl: async () => new Response("", { status: 400 }),
    })
    rejected.log(entry())
    await rejected.flush()
    expect(rejected.getHealth()).toMatchObject({
      droppedByReason: { "ship-failed": 1 },
      lastError: "OTLP Logs rejected with 400",
    })

    const threw = new OtlpLogTransport({
      endpoint: "https://collector.example/v1/logs",
      flushInterval: 0,
      maxRetries: 0,
      fetchImpl: async () => {
        throw "network unavailable"
      },
    })
    threw.log(entry())
    await threw.flush()
    expect(threw.getHealth()).toMatchObject({
      droppedByReason: { "ship-failed": 1 },
      lastError: "network unavailable",
    })
  })

  it.each([408, 429, 502, 504])("classifies HTTP %i as retryable", async (status) => {
    const transport = new OtlpLogTransport({
      endpoint: "https://collector.example/v1/logs",
      flushInterval: 0,
      maxRetries: 0,
      fetchImpl: async () => new Response("", { status }),
    })
    transport.log(entry())
    await transport.flush()

    expect(transport.getHealth()).toMatchObject({
      droppedByReason: { "ship-failed": 1 },
      lastError: `OTLP Logs rejected with ${status}`,
    })
  })

  it("uses the default retry delay when no scheduler is injected", async () => {
    jest.useFakeTimers()
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }))
    const transport = new OtlpLogTransport({
      endpoint: "https://collector.example/v1/logs",
      flushInterval: 0,
      maxRetries: 1,
      retryBaseMs: 1,
      fetchImpl,
    })

    transport.log(entry())
    const flushing = transport.flush()
    await jest.advanceTimersByTimeAsync(2)
    await flushing
    jest.useRealTimers()

    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("requires a policy-selected platform sender", () => {
    expect(
      () =>
        new OtlpLogTransport({
          endpoint: "https://collector.example/v1/logs",
          flushInterval: 0,
        } as OtlpLogTransportOptions)
    ).toThrow(/platform-owned sender/)
  })
})

describe("withdrawn consent", () => {
  it("abandons an in-flight batch when discardPending fires mid-retry", async () => {
    let releaseFirstAttempt: (() => void) | undefined
    const fetchImpl = jest.fn(async () => {
      // Hold the transport inside its retry loop until the toggle goes off.
      await new Promise<void>((resolve) => {
        releaseFirstAttempt = resolve
      })
      return new Response("", { status: 503 })
    })
    const transport = new OtlpLogTransport({
      endpoint: "https://collector.example/v1/logs",
      bufferSize: 10,
      flushInterval: 0,
      maxRetries: 3,
      retryBaseMs: 0,
      sleepImpl: async () => {},
      fetchImpl,
    })

    transport.log(entry())
    const flushed = transport.flush()
    await Promise.resolve()

    // The user turns the OTLP-logs consent switch off while the first attempt
    // is still open. No further POST may leave the process.
    transport.discardPending()
    releaseFirstAttempt?.()
    await flushed

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
