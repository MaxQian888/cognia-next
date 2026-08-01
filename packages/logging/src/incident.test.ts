import type { ObservabilityEventV1 } from "./observability-event"
import { assembleDiagnosticIncident, transitionIncident, type DiagnosticIncident } from "./incident"

function event(
  id: string,
  runtime: ObservabilityEventV1["scope"]["runtime"],
  sequence: number,
  occurredAt: string
): ObservabilityEventV1 {
  return {
    schemaVersion: 1,
    eventId: id,
    occurredAt,
    kind: "crash",
    severity: "fatal",
    name: "runtime.crash",
    code: "runtime.crash",
    scope: {
      tenantId: "tenant-1",
      installationId: "install-1",
      runtime,
      processId: `${runtime}-1`,
      module: "runtime",
      buildId: "build-1",
      appVersion: "0.1.0",
    },
    correlation: { traceId: "trace-1", sessionId: "session-1" },
    privacy: {
      redactionVersion: "privacy-v1",
      capturePolicy: "metadata-only",
      contentCaptured: false,
      removedFields: [],
    },
    delivery: { spoolSequence: sequence, flushWatermark: sequence - 1 },
    payload: { message: id },
  }
}

describe("diagnostic incident assembly", () => {
  it("orders cross-runtime events and records missing sources and watermarks", () => {
    const incident = assembleDiagnosticIncident({
      incidentId: "incident-1",
      detectedAt: "2026-08-01T14:00:00.000Z",
      events: [
        event("rust", "tauri", 8, "2026-08-01T13:59:59.900Z"),
        event("renderer", "browser", 3, "2026-08-01T13:59:59.100Z"),
      ],
      expectedSources: ["browser", "tauri", "sidecar"],
    })

    expect(incident.events.map((item) => item.eventId)).toEqual(["renderer", "rust"])
    expect(incident.missingSources).toEqual(["sidecar"])
    expect(incident.sourceWatermarks).toEqual({ browser: 2, tauri: 7 })
    expect(incident.state).toBe("detected")
  })

  it("keeps minidumps and screenshots unselected by default", () => {
    const incident = assembleDiagnosticIncident({
      incidentId: "incident-1",
      detectedAt: "2026-08-01T14:00:00.000Z",
      events: [event("renderer", "browser", 1, "2026-08-01T14:00:00.000Z")],
      expectedSources: ["browser"],
      attachments: [
        { id: "meta", kind: "metadata", name: "report.json", sizeBytes: 100 },
        { id: "dump", kind: "minidump", name: "crash.dmp", sizeBytes: 1_000 },
        { id: "shot", kind: "screenshot", name: "state.png", sizeBytes: 2_000 },
      ],
    })

    expect(incident.attachments.map(({ id, selected }) => ({ id, selected }))).toEqual([
      { id: "meta", selected: true },
      { id: "dump", selected: false },
      { id: "shot", selected: false },
    ])
  })

  it("enforces the consented upload lifecycle and rejects invalid jumps", () => {
    let incident: DiagnosticIncident = assembleDiagnosticIncident({
      incidentId: "incident-1",
      detectedAt: "2026-08-01T14:00:00.000Z",
      events: [event("renderer", "browser", 1, "2026-08-01T14:00:00.000Z")],
      expectedSources: ["browser"],
    })
    expect(() => transitionIncident(incident, { type: "upload-started" })).toThrow(
      "detected -> uploading"
    )
    for (const action of [
      { type: "package-created" },
      { type: "consent-required" },
      { type: "consent-granted" },
      { type: "upload-started" },
      { type: "upload-completed" },
      { type: "accepted", receiptId: "SUP-123" },
      { type: "deleted" },
    ] as const) {
      incident = transitionIncident(incident, action)
    }
    expect(incident.state).toBe("deleted")
    expect(incident.receiptId).toBe("SUP-123")
  })
})
