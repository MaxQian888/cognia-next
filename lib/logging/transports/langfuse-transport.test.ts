/**
 * @jest-environment jsdom
 */

import type { StructuredLogEntry } from "@cognia/logging/types"
import {
  buildLangfuseIngestionBatch,
  createLangfuseTransport,
  LangfuseTransport,
} from "./langfuse-transport"

const mockHasNoLeakingPiiDeep = jest.fn((_value?: unknown) => true)
jest.mock("@cognia/redact", () => ({
  hasNoLeakingPiiDeep: (value: unknown) => mockHasNoLeakingPiiDeep(value),
}))

function makeEntry(overrides: Partial<StructuredLogEntry> = {}): StructuredLogEntry {
  return {
    id: "log-1",
    timestamp: "2026-04-30T10:00:00.000Z",
    level: overrides.level ?? "warn",
    message: "hello",
    module: "test",
    ...overrides,
  }
}

describe("Langfuse ingestion serialization", () => {
  it("groups entries into one trace and preserves configured metadata", () => {
    const batch = buildLangfuseIngestionBatch(
      [
        makeEntry({
          traceId: "trace-1",
          data: { ok: true },
          stack: "stack",
          source: { file: "a.ts" },
        }),
        makeEntry({ id: "log-2", traceId: "trace-1", level: "error", message: "failed" }),
      ],
      { includeData: true, includeStack: true, eventPrefix: "cognia" }
    )

    expect(batch.batch.filter((item) => item.type === "trace-create")).toHaveLength(1)
    const events = batch.batch.filter((item) => item.type === "event-create")
    expect(events).toHaveLength(2)
    expect(events[0].body).toMatchObject({
      traceId: "trace-1",
      name: "cognia.warn.test",
      input: "hello",
      level: "WARNING",
      metadata: expect.objectContaining({ data: { ok: true }, stack: "stack" }),
    })
    expect(events[1].body).toMatchObject({ level: "ERROR", input: "failed" })
  })
})

describe("LangfuseTransport", () => {
  beforeEach(() => {
    mockHasNoLeakingPiiDeep.mockReturnValue(true)
  })

  it("uses the same serialized batch for the Tauri exporter without resolving a web secret", async () => {
    const exportBatch = jest.fn(async () => undefined)
    const resolveSecretKey = jest.fn(async () => "should-not-be-read")
    const transport = new LangfuseTransport({
      publicKey: "pk-native",
      batchSize: 99,
      flushInterval: 60_000,
      exportBatch,
      resolveSecretKey,
    })
    transport.log(makeEntry({ traceId: "native-trace", level: "error" }))

    await transport.flush()

    expect(exportBatch).toHaveBeenCalledWith({
      batch: expect.arrayContaining([
        expect.objectContaining({ type: "trace-create" }),
        expect.objectContaining({ type: "event-create" }),
      ]),
    })
    expect(resolveSecretKey).not.toHaveBeenCalled()
    await transport.close()
  })

  it("posts a Basic-authenticated ingestion batch on Web", async () => {
    const fetchFn = jest.fn(async () => ({ ok: true, status: 200 }) as Response)
    const resolveSecretKey = jest.fn(async () => "sk-secret")
    const transport = new LangfuseTransport({
      publicKey: "pk-public",
      resolveSecretKey,
      host: "https://langfuse.example/",
      batchSize: 99,
      flushInterval: 60_000,
      fetchFn,
    })
    transport.log(makeEntry({ sessionId: "session-1", level: "error" }))

    await transport.flush()

    expect(resolveSecretKey).toHaveBeenCalledTimes(1)
    expect(fetchFn).toHaveBeenCalledWith(
      "https://langfuse.example/api/public/ingestion",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Basic " + btoa("pk-public:sk-secret"),
          "Content-Type": "application/json",
        }),
        body: expect.stringContaining('"event-create"'),
      })
    )
    await transport.close()
  })

  it("re-buffers a failed batch within the existing bound", async () => {
    const exportBatch = jest
      .fn<Promise<void>, [unknown]>()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValue(undefined)
    const transport = new LangfuseTransport({
      publicKey: "pk-native",
      batchSize: 99,
      flushInterval: 60_000,
      exportBatch: exportBatch as never,
    })
    transport.log(makeEntry({ level: "error" }))

    await transport.flush()
    await transport.flush()

    expect(exportBatch).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(exportBatch.mock.calls[1][0])).toContain("hello")
    await transport.close()
  })

  it("drops an empty-credential Web batch without retrying forever", async () => {
    const fetchFn = jest.fn()
    const resolveSecretKey = jest.fn(async () => null)
    const transport = new LangfuseTransport({
      publicKey: "pk-public",
      resolveSecretKey,
      batchSize: 99,
      flushInterval: 60_000,
      fetchFn: fetchFn as typeof fetch,
    })
    transport.log(makeEntry({ level: "error" }))

    await transport.flush()
    await transport.flush()

    expect(resolveSecretKey).toHaveBeenCalledTimes(1)
    expect(fetchFn).not.toHaveBeenCalled()
    await transport.close()
  })

  it("fails closed before either exporter when the serialized batch leaks PII", async () => {
    const exportBatch = jest.fn(async () => undefined)
    mockHasNoLeakingPiiDeep.mockReturnValue(false)
    const transport = new LangfuseTransport({
      publicKey: "pk-native",
      batchSize: 99,
      flushInterval: 60_000,
      exportBatch,
    })
    transport.log(makeEntry({ level: "error", message: "alice@example.com" }))

    await transport.flush()

    expect(mockHasNoLeakingPiiDeep).toHaveBeenCalledWith({
      batch: expect.arrayContaining([expect.objectContaining({ type: "event-create" })]),
    })
    expect(exportBatch).not.toHaveBeenCalled()
    await transport.close()
  })

  it("does not call the native exporter or retry when its public key is empty", async () => {
    const exportBatch = jest.fn(async () => undefined)
    const transport = new LangfuseTransport({
      batchSize: 99,
      flushInterval: 60_000,
      exportBatch,
    })
    transport.log(makeEntry({ level: "error" }))

    await transport.flush()
    await transport.flush()

    expect(exportBatch).not.toHaveBeenCalled()
    await transport.close()
  })

  it("keeps ingestion ids stable when a failed batch is retried", async () => {
    const exported: unknown[] = []
    const exportBatch = jest.fn(async (batch: unknown) => {
      exported.push(batch)
      if (exported.length === 1) throw new Error("response lost")
    })
    const transport = new LangfuseTransport({
      publicKey: "pk-native",
      batchSize: 99,
      flushInterval: 60_000,
      exportBatch,
    })
    transport.log(makeEntry({ id: "stable-log", traceId: "stable-trace", level: "error" }))

    await transport.flush()
    await transport.flush()

    expect(exported).toHaveLength(2)
    expect(exported[1]).toEqual(exported[0])
    await transport.close()
  })

  it("filters below minLevel and supports the existing factory", async () => {
    const exportBatch = jest.fn(async () => undefined)
    const transport = createLangfuseTransport({
      publicKey: "pk-native",
      minLevel: "error",
      batchSize: 99,
      flushInterval: 60_000,
      exportBatch,
    })
    transport.log(makeEntry({ level: "warn" }))
    await transport.close()
    expect(transport.name).toBe("langfuse")
    expect(exportBatch).not.toHaveBeenCalled()
  })
})
