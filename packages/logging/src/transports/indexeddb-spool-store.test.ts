/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { IDBFactory } from "fake-indexeddb"

import type { ObservabilityEventV1 } from "../observability-event"
import { ObservabilitySpool } from "../spool"
import { IndexedDBObservabilitySpoolStore } from "./indexeddb-spool-store"

function makeEvent(id: string, severity: ObservabilityEventV1["severity"]): ObservabilityEventV1 {
  return {
    schemaVersion: 1,
    eventId: id,
    occurredAt: "2026-08-01T12:30:00.000Z",
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

beforeEach(() => {
  const factory = new IDBFactory()
  ;(globalThis as { indexedDB: IDBFactory }).indexedDB = factory
  ;(window as unknown as { indexedDB: IDBFactory }).indexedDB = factory
})

describe("IndexedDBObservabilitySpoolStore", () => {
  it("restores unacknowledged records and sequence metadata after reopening", async () => {
    const first = new ObservabilitySpool(
      new IndexedDBObservabilitySpoolStore({ dbName: "spool-restart" }),
      { maxEvents: 10, maxBytes: 100_000 }
    )
    await first.enqueue(makeEvent("a", "info"))
    await first.close()

    const second = new ObservabilitySpool(
      new IndexedDBObservabilitySpoolStore({ dbName: "spool-restart" }),
      { maxEvents: 10, maxBytes: 100_000 }
    )
    const restored = await second.readBatch({ limit: 10 })
    await second.enqueue(makeEvent("b", "warn"))

    expect(restored.map((record) => record.event.eventId)).toEqual(["a"])
    expect((await second.readBatch({ limit: 10 })).map((record) => record.sequence)).toEqual([1, 2])
    await second.close()
  })

  it("persists eviction and protects warn+ records", async () => {
    const spool = new ObservabilitySpool(
      new IndexedDBObservabilitySpoolStore({ dbName: "spool-priority" }),
      { maxEvents: 2, maxBytes: 100_000 }
    )
    await spool.enqueue(makeEvent("warn", "warn"))
    await spool.enqueue(makeEvent("info", "info"))
    const result = await spool.enqueue(makeEvent("error", "error"))

    expect(result.status).toBe("stored")
    expect((await spool.readBatch({ limit: 10 })).map((record) => record.event.eventId)).toEqual([
      "warn",
      "error",
    ])
    expect((await spool.getStats()).droppedLowSeverityEvents).toBe(1)
    await spool.close()
  })

  it("persists acknowledgements as the next event flush watermark", async () => {
    const spool = new ObservabilitySpool(
      new IndexedDBObservabilitySpoolStore({ dbName: "spool-ack" }),
      { maxEvents: 10, maxBytes: 100_000 }
    )
    await spool.enqueue(makeEvent("a", "info"))
    await spool.ackThrough(1)
    await spool.enqueue(makeEvent("b", "warn"))

    expect((await spool.readBatch({ limit: 10 }))[0].event.delivery).toEqual({
      spoolSequence: 2,
      flushWatermark: 1,
    })
    await spool.close()
  })
})
