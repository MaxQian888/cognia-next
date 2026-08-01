import type { StructuredLogEntry, TransportDiagnosticEvent } from "../types"
import { MemoryObservabilitySpoolStore, ObservabilitySpool } from "../spool"
import { ObservabilitySpoolTransport } from "./observability-spool-transport"

const entry: StructuredLogEntry = {
  id: "log-1",
  timestamp: "2026-08-01T13:00:00.000Z",
  level: "error",
  message: "Provider request failed",
  module: "provider",
  code: "provider.request.failed",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  data: {
    prompt: "private input",
    model: "gpt-test",
  },
}

function createTransport(
  diagnostics: TransportDiagnosticEvent[] = [],
  limits = { maxEvents: 10, maxBytes: 100_000 }
) {
  const spool = new ObservabilitySpool(new MemoryObservabilitySpoolStore(), limits)
  const transport = new ObservabilitySpoolTransport({
    spool,
    scope: {
      tenantId: "tenant-1",
      installationId: "install-1",
      runtime: "browser",
      processId: "renderer-1",
      module: "app",
      buildId: "build-1",
      appVersion: "0.1.0",
    },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  })
  return { spool, transport }
}

describe("ObservabilitySpoolTransport", () => {
  it("dual-writes a privacy-gated V1 event while preserving legacy correlation", async () => {
    const { spool, transport } = createTransport()

    await transport.log(entry)
    const [record] = await spool.readBatch({ limit: 10 })

    expect(record.event).toMatchObject({
      schemaVersion: 1,
      eventId: "log-1",
      code: "provider.request.failed",
      correlation: {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
      payload: { data: { model: "gpt-test" } },
      privacy: {
        capturePolicy: "metadata-only",
        contentCaptured: false,
        removedFields: ["payload.data.prompt"],
      },
    })
    expect(transport.getHealth().status).toBe("healthy")
  })

  it("surfaces protected-capacity exhaustion as a transport diagnostic", async () => {
    const diagnostics: TransportDiagnosticEvent[] = []
    const { transport } = createTransport(diagnostics, { maxEvents: 1, maxBytes: 100_000 })

    await transport.log(entry)
    await transport.log({ ...entry, id: "log-2", level: "fatal" })

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "observability.spool.capacity_exhausted",
        level: "error",
        sourceTransport: "observability-spool",
        data: expect.objectContaining({ reason: "protected-severity-capacity" }),
      }),
    ])
    expect(transport.getHealth()).toMatchObject({ status: "degraded", droppedEntries: 1 })
  })
})
