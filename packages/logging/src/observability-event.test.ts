import Ajv2020 from "ajv/dist/2020"

import {
  OBSERVABILITY_EVENT_V1_SCHEMA,
  observabilityEventToStructuredLogEntry,
  structuredLogEntryToObservabilityEvent,
  type ObservabilityEventScope,
} from "./observability-event"
import type { StructuredLogEntry } from "./types"

const scope: ObservabilityEventScope = {
  tenantId: "tenant-acme",
  installationId: "install-01",
  runtime: "browser",
  processId: "renderer-1",
  module: "network:sync",
  buildId: "desktop-2026.08.01",
  appVersion: "0.1.0",
}

const legacyEntry: StructuredLogEntry = {
  id: "log-01",
  timestamp: "2026-08-01T10:00:00.000Z",
  level: "error",
  message: "Sync request failed",
  module: "network:sync",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  requestId: "request-01",
  sessionId: "session-01",
  code: "sync.request.failed",
  phase: "end",
  attempt: 2,
  durationMs: 425,
  runtime: "browser",
  origin: "web-runtime",
  data: { status: 503 },
  stack: "Error: unavailable",
  tags: ["sync", "retry"],
}

describe("ObservabilityEventV1 compatibility contract", () => {
  it("converts a structured log into a schema-valid V1 event", () => {
    const event = structuredLogEntryToObservabilityEvent(legacyEntry, {
      scope,
      redactionVersion: "privacy-2026-08-01",
      removedFields: ["data.authorization"],
      spoolSequence: 41,
      flushWatermark: 38,
    })

    const ajv = new Ajv2020({ allErrors: true, strict: false })
    ajv.addFormat("date-time", (value: string) => !Number.isNaN(Date.parse(value)))
    const validate = ajv.compile(OBSERVABILITY_EVENT_V1_SCHEMA)

    expect(validate(event)).toBe(true)
    expect(validate.errors).toBeNull()
    expect(event).toMatchObject({
      schemaVersion: 1,
      eventId: "log-01",
      occurredAt: "2026-08-01T10:00:00.000Z",
      kind: "log",
      severity: "error",
      name: "Sync request failed",
      code: "sync.request.failed",
      scope,
      correlation: {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        requestId: "request-01",
        sessionId: "session-01",
      },
      privacy: {
        capturePolicy: "metadata-only",
        contentCaptured: false,
        redactionVersion: "privacy-2026-08-01",
        removedFields: ["data.authorization"],
      },
      delivery: { spoolSequence: 41, flushWatermark: 38 },
      payload: {
        message: "Sync request failed",
        data: { status: 503 },
        stack: "Error: unavailable",
        phase: "end",
        attempt: 2,
        durationMs: 425,
        tags: ["sync", "retry"],
      },
    })
  })

  it("round-trips V1 log events through the legacy reader without losing correlation", () => {
    const event = structuredLogEntryToObservabilityEvent(legacyEntry, {
      scope,
      redactionVersion: "privacy-2026-08-01",
      spoolSequence: 1,
      flushWatermark: 1,
    })

    expect(observabilityEventToStructuredLogEntry(event)).toEqual(legacyEntry)
  })

  it("does not synthesize traceparent from invalid W3C identifiers", () => {
    const event = structuredLogEntryToObservabilityEvent(
      { ...legacyEntry, traceId: "trace-local", spanId: "span-local" },
      {
        scope,
        redactionVersion: "privacy-2026-08-01",
        spoolSequence: 2,
        flushWatermark: 1,
      }
    )

    expect(event.correlation.traceparent).toBeUndefined()
    expect(event.correlation.traceId).toBe("trace-local")
    expect(event.correlation.spanId).toBe("span-local")
  })
})
