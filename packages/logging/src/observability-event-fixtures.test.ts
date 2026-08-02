import { readdirSync } from "node:fs"
import { join } from "node:path"

import Ajv2020 from "ajv/dist/2020"

import {
  OBSERVABILITY_GOLDEN_FIXTURES,
  maximalGoldenFixture,
  minimalGoldenFixture,
} from "./observability-event-fixtures"
import {
  OBSERVABILITY_EVENT_V1_SCHEMA,
  observabilityEventToStructuredLogEntry,
  structuredLogEntryToObservabilityEvent,
} from "./observability-event"
import type { ObservabilityEventKind } from "./observability-event"

function compileSchema() {
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  ajv.addFormat("date-time", (value: string) => !Number.isNaN(Date.parse(value)))
  return ajv.compile(OBSERVABILITY_EVENT_V1_SCHEMA)
}

describe("observability golden fixtures", () => {
  it("exports every fixture file on disk", () => {
    // The Rust suite globs the directory; this list is hand-maintained because
    // TypeScript needs static imports. Without this check a fixture added for
    // Rust would silently escape the TypeScript half of the parity proof.
    const onDisk = readdirSync(join(__dirname, "schemas", "fixtures"))
      .filter((name) => name.endsWith(".json"))
      .sort()
    const exported = OBSERVABILITY_GOLDEN_FIXTURES.map((fixture) => fixture.file).sort()
    expect(exported).toEqual(onDisk)
  })

  it("validates every fixture against the checked-in schema", () => {
    const validate = compileSchema()
    for (const { file, event } of OBSERVABILITY_GOLDEN_FIXTURES) {
      const valid = validate(event)
      expect({ file, valid, errors: validate.errors }).toEqual({
        file,
        valid: true,
        errors: null,
      })
    }
  })

  it("covers every event kind", () => {
    const kinds = new Set(OBSERVABILITY_GOLDEN_FIXTURES.map((fixture) => fixture.event.kind))
    const expected: ObservabilityEventKind[] = ["log", "span", "crash", "lifecycle", "metric"]
    for (const kind of expected) {
      expect(kinds.has(kind)).toBe(true)
    }
  })

  it("covers every documented runtime family at least once", () => {
    const runtimes = new Set(
      OBSERVABILITY_GOLDEN_FIXTURES.map((fixture) => fixture.event.scope.runtime)
    )
    for (const runtime of ["browser", "tauri", "sidecar", "cli"] as const) {
      expect(runtimes.has(runtime)).toBe(true)
    }
  })

  it("keeps the maximal fixture exercising every optional root field", () => {
    const event = maximalGoldenFixture()
    expect(event.scope.pluginId).toBeDefined()
    expect(event.scope.origin).toBeDefined()
    expect(event.correlation.traceparent).toBeDefined()
    expect(event.correlation.tracestate).toBeDefined()
    expect(event.privacy.removedFields.length).toBeGreaterThan(0)
    expect(event.payload.stack).toBeDefined()
    expect(event.payload.tags).toBeDefined()
    expect(event.payload.source).toBeDefined()
    expect(event.payload.legacyEventId).toBeDefined()
  })

  it("keeps the minimal fixture free of optional fields", () => {
    const event = minimalGoldenFixture()
    expect(event.correlation).toEqual({})
    expect(event.privacy.removedFields).toEqual([])
    expect(Object.keys(event.payload)).toEqual(["message"])
  })

  it("round-trips log fixtures through the legacy adapter without losing scope", () => {
    for (const { file, event } of OBSERVABILITY_GOLDEN_FIXTURES) {
      if (event.kind !== "log") continue
      const legacy = observabilityEventToStructuredLogEntry(event)
      const back = structuredLogEntryToObservabilityEvent(legacy, {
        scope: event.scope,
        redactionVersion: event.privacy.redactionVersion,
        removedFields: event.privacy.removedFields,
        spoolSequence: event.delivery.spoolSequence,
        flushWatermark: event.delivery.flushWatermark,
        traceparent: event.correlation.traceparent,
        tracestate: event.correlation.tracestate,
      })
      expect({ file, scope: back.scope }).toEqual({ file, scope: event.scope })
      expect(back.delivery).toEqual(event.delivery)
      expect(back.privacy).toEqual(event.privacy)
      expect(back.correlation).toEqual(event.correlation)
    }
  })

  it("keeps every fixture's payload message non-empty", () => {
    for (const { file, event } of OBSERVABILITY_GOLDEN_FIXTURES) {
      expect({ file, empty: event.payload.message.length === 0 }).toEqual({ file, empty: false })
    }
  })

  it("rejects a fixture mutated to an unsupported schema version", () => {
    const validate = compileSchema()
    const broken = { ...minimalGoldenFixture(), schemaVersion: 2 }
    expect(validate(broken)).toBe(false)
  })
})
