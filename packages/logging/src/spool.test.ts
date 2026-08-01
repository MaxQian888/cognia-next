import type { ObservabilityEventV1 } from "./observability-event"
import { MemoryObservabilitySpoolStore, ObservabilitySpool } from "./spool"

function makeEvent(id: string, severity: ObservabilityEventV1["severity"]): ObservabilityEventV1 {
  return {
    schemaVersion: 1,
    eventId: id,
    occurredAt: "2026-08-01T12:00:00.000Z",
    kind: "log",
    severity,
    name: id,
    code: `test.${id}`,
    scope: {
      tenantId: "tenant-1",
      installationId: "install-1",
      runtime: "browser",
      processId: "renderer-1",
      module: "test",
      buildId: "build-1",
      appVersion: "0.1.0",
    },
    correlation: {},
    privacy: {
      redactionVersion: "privacy-v1",
      capturePolicy: "metadata-only",
      contentCaptured: false,
      removedFields: [],
    },
    delivery: { spoolSequence: 0, flushWatermark: 0 },
    payload: { message: id },
  }
}

describe("ObservabilitySpool", () => {
  it("assigns monotonic sequence numbers and advances the flush watermark on ack", async () => {
    const spool = new ObservabilitySpool(new MemoryObservabilitySpoolStore(), {
      maxEvents: 10,
      maxBytes: 100_000,
    })

    await spool.enqueue(makeEvent("a", "info"))
    await spool.enqueue(makeEvent("b", "warn"))
    const firstBatch = await spool.readBatch({ limit: 10 })

    expect(firstBatch.map((record) => record.sequence)).toEqual([1, 2])
    expect(firstBatch[0].event.delivery).toEqual({ spoolSequence: 1, flushWatermark: 0 })
    await spool.ackThrough(1)
    await spool.enqueue(makeEvent("c", "error"))

    const secondBatch = await spool.readBatch({ limit: 10 })
    expect(secondBatch.map((record) => record.event.eventId)).toEqual(["b", "c"])
    expect(secondBatch[1].event.delivery).toEqual({ spoolSequence: 3, flushWatermark: 1 })
  })

  it("evicts the oldest low-severity record before dropping warn or error", async () => {
    const spool = new ObservabilitySpool(new MemoryObservabilitySpoolStore(), {
      maxEvents: 3,
      maxBytes: 100_000,
    })

    await spool.enqueue(makeEvent("warn", "warn"))
    await spool.enqueue(makeEvent("info-1", "info"))
    await spool.enqueue(makeEvent("error", "error"))
    const result = await spool.enqueue(makeEvent("info-2", "info"))

    expect(result.status).toBe("stored")
    expect(result.evicted.map((record) => record.event.eventId)).toEqual(["info-1"])
    expect((await spool.readBatch({ limit: 10 })).map((record) => record.event.eventId)).toEqual([
      "warn",
      "error",
      "info-2",
    ])
  })

  it("returns an explicit capacity error instead of silently losing warn+ records", async () => {
    const spool = new ObservabilitySpool(new MemoryObservabilitySpoolStore(), {
      maxEvents: 2,
      maxBytes: 100_000,
    })

    await spool.enqueue(makeEvent("warn", "warn"))
    await spool.enqueue(makeEvent("error", "error"))
    const rejected = await spool.enqueue(makeEvent("fatal", "fatal"))

    expect(rejected).toMatchObject({
      status: "capacity-exhausted",
      reason: "protected-severity-capacity",
    })
    expect((await spool.getStats()).rejectedProtectedEvents).toBe(1)
  })

  it("drains acknowledged batches and reports unfinished records at the deadline", async () => {
    let now = 0
    const spool = new ObservabilitySpool(new MemoryObservabilitySpoolStore(), {
      maxEvents: 10,
      maxBytes: 100_000,
    })
    await spool.enqueue(makeEvent("a", "info"))
    await spool.enqueue(makeEvent("b", "info"))
    await spool.enqueue(makeEvent("c", "warn"))

    const result = await spool.drain(
      async (records) => {
        now += 6
        return records[records.length - 1].sequence
      },
      { batchSize: 1, timeoutMs: 10, now: () => now }
    )

    expect(result).toEqual({ acknowledged: 2, unfinished: 1, timedOut: true })
    expect((await spool.readBatch({ limit: 10 })).map((record) => record.event.eventId)).toEqual([
      "c",
    ])
  })
})
