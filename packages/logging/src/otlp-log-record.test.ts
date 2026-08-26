import { structuredLogEntriesToOtlpLogs } from "./otlp-log-record"
import type { StructuredLogEntry } from "./types"

const entry: StructuredLogEntry = {
  id: "log-01",
  timestamp: "2026-08-26T08:09:10.123Z",
  level: "error",
  message: "Sync request failed",
  module: "network:sync",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  parentSpanId: "b7ad6b7169203331",
  requestId: "request-01",
  executionId: "execution-01",
  workflowId: "workflow-01",
  stepId: "step-01",
  code: "sync.request.failed",
  runtime: "browser",
  origin: "web-runtime",
  sessionId: "session-01",
  phase: "end",
  attempt: 2,
  durationMs: 425,
  data: { status: 503, retryable: true },
  tags: ["sync", "retry"],
}

describe("StructuredLogEntry OTLP Logs adapter", () => {
  it("maps a structured entry to one correlated OTLP LogRecord", () => {
    expect(
      structuredLogEntriesToOtlpLogs([entry], {
        serviceName: "cognia-renderer",
        serviceVersion: "0.1.0",
        environment: "production",
      })
    ).toEqual({
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "cognia-renderer" } },
              { key: "service.version", value: { stringValue: "0.1.0" } },
              {
                key: "deployment.environment.name",
                value: { stringValue: "production" },
              },
            ],
          },
          scopeLogs: [
            {
              scope: { name: "@cognia/logging", version: "1.0.0" },
              logRecords: [
                {
                  timeUnixNano: "1787731750123000000",
                  observedTimeUnixNano: "1787731750123000000",
                  severityNumber: 17,
                  severityText: "ERROR",
                  body: { stringValue: "Sync request failed" },
                  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
                  spanId: "00f067aa0ba902b7",
                  flags: 1,
                  attributes: [
                    { key: "log.record.uid", value: { stringValue: "log-01" } },
                    { key: "event.name", value: { stringValue: "sync.request.failed" } },
                    { key: "code.namespace", value: { stringValue: "network:sync" } },
                    { key: "cognia.runtime", value: { stringValue: "browser" } },
                    { key: "cognia.origin", value: { stringValue: "web-runtime" } },
                    { key: "session.id", value: { stringValue: "session-01" } },
                    { key: "cognia.request.id", value: { stringValue: "request-01" } },
                    {
                      key: "cognia.parent_span.id",
                      value: { stringValue: "b7ad6b7169203331" },
                    },
                    { key: "cognia.execution.id", value: { stringValue: "execution-01" } },
                    { key: "cognia.workflow.id", value: { stringValue: "workflow-01" } },
                    { key: "cognia.step.id", value: { stringValue: "step-01" } },
                    { key: "cognia.phase", value: { stringValue: "end" } },
                    { key: "cognia.attempt", value: { intValue: "2" } },
                    { key: "cognia.duration_ms", value: { doubleValue: 425 } },
                    {
                      key: "cognia.tags",
                      value: {
                        arrayValue: {
                          values: [{ stringValue: "sync" }, { stringValue: "retry" }],
                        },
                      },
                    },
                    {
                      key: "cognia.log.data",
                      value: { stringValue: '{"status":503,"retryable":true}' },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })
  })

  it("does not promote malformed trace identifiers to OTLP correlation fields", () => {
    const payload = structuredLogEntriesToOtlpLogs([
      { ...entry, traceId: "trace-local", spanId: "span-local" },
    ])
    const record = payload.resourceLogs[0].scopeLogs[0].logRecords[0]

    expect(record.traceId).toBeUndefined()
    expect(record.spanId).toBeUndefined()
    expect(record.flags).toBeUndefined()
  })

  it("handles optional metadata, invalid timestamps, and unserializable data", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const payload = structuredLogEntriesToOtlpLogs(
      [
        {
          ...entry,
          timestamp: "invalid",
          traceId: "00000000000000000000000000000000",
          spanId: "0000000000000000",
          attempt: Number.NaN,
          durationMs: Number.POSITIVE_INFINITY,
          tags: [],
          data: circular,
          stack: "Error: failed",
          source: { file: "sync.ts", line: 42, function: "sync" },
        },
      ],
      { serviceName: " " }
    )
    const record = payload.resourceLogs[0].scopeLogs[0].logRecords[0]

    expect(payload.resourceLogs[0].resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "cognia-ai" } },
    ])
    expect(record).toMatchObject({ timeUnixNano: "0", observedTimeUnixNano: "0" })
    expect(record.traceId).toBeUndefined()
    expect(record.attributes).toEqual(
      expect.arrayContaining([
        { key: "exception.stacktrace", value: { stringValue: "Error: failed" } },
        { key: "code.file.path", value: { stringValue: "sync.ts" } },
        { key: "code.function.name", value: { stringValue: "sync" } },
        { key: "code.line.number", value: { intValue: "42" } },
      ])
    )
    expect(record.attributes.map((attribute) => attribute.key)).not.toContain("cognia.log.data")
  })
})
