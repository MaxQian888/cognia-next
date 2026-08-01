import type { ObservabilityEventV1 } from "./observability-event"
import {
  CLIENT_PRIVACY_MANIFEST_V1,
  applyObservabilityPrivacy,
  createLocalDebugCaptureSession,
  scanHighConfidenceCredentials,
} from "./privacy-manifest"

const event: ObservabilityEventV1 = {
  schemaVersion: 1,
  eventId: "evt-1",
  occurredAt: "2026-08-01T11:00:00.000Z",
  kind: "log",
  severity: "error",
  name: "provider.failed",
  code: "provider.request.failed",
  scope: {
    tenantId: "tenant-1",
    installationId: "install-1",
    runtime: "browser",
    processId: "renderer-1",
    module: "provider",
    buildId: "build-1",
    appVersion: "0.1.0",
  },
  correlation: {},
  privacy: {
    redactionVersion: "old",
    capturePolicy: "metadata-only",
    contentCaptured: false,
    removedFields: [],
  },
  delivery: { spoolSequence: 1, flushWatermark: 0 },
  payload: {
    message: "Request for ada@example.com failed with Bearer abcdefghijklmnopqrstuvwxyz",
    data: {
      prompt: "Explain private roadmap",
      toolInput: { path: "/Users/ada/private.txt" },
      model: "gpt-test",
      authorization: "Bearer should-never-survive",
      email: "ada@example.com",
    },
  },
}

describe("client privacy manifest", () => {
  it("removes content fields and redacts PII before persistence", () => {
    const sanitized = applyObservabilityPrivacy(event)

    expect(sanitized).not.toBe(event)
    expect(sanitized.payload.message).toBe("Request for [REDACTED_EMAIL] failed with [REDACTED]")
    expect(sanitized.payload.data).toEqual({
      model: "gpt-test",
      authorization: "[REDACTED]",
      email: "[REDACTED_EMAIL]",
    })
    expect(sanitized.privacy).toEqual({
      redactionVersion: CLIENT_PRIVACY_MANIFEST_V1.version,
      capturePolicy: "metadata-only",
      contentCaptured: false,
      removedFields: ["payload.data.prompt", "payload.data.toolInput"],
    })
  })

  it("allows redacted content only for an unexpired local debug session", () => {
    const session = createLocalDebugCaptureSession(new Date("2026-08-01T11:00:00.000Z"))
    const active = applyObservabilityPrivacy(event, {
      debugSession: session,
      now: new Date("2026-08-01T11:20:00.000Z"),
    })
    const expired = applyObservabilityPrivacy(event, {
      debugSession: session,
      now: new Date("2026-08-01T11:31:00.000Z"),
    })

    expect(active.payload.data).toMatchObject({
      prompt: "Explain private roadmap",
      toolInput: { path: "[REDACTED_PATH]" },
    })
    expect(active.privacy.capturePolicy).toBe("debug-session")
    expect(active.privacy.contentCaptured).toBe(true)
    expect(session.remoteAllowed).toBe(false)
    expect(expired.payload.data).not.toHaveProperty("prompt")
    expect(expired.privacy.capturePolicy).toBe("metadata-only")
  })

  it("detects credentials without returning their source values", () => {
    const result = scanHighConfidenceCredentials(
      "header sk-1234567890abcdefghijklmnop and -----BEGIN PRIVATE KEY-----"
    )

    expect(result.reject).toBe(true)
    expect(result.findings.map((finding) => finding.kind)).toEqual([
      "private-key",
      "provider-secret",
    ])
    expect(JSON.stringify(result)).not.toContain("1234567890abcdefghijklmnop")
  })
})
