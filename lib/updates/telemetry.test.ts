import { newAttemptId, sanitizeTelemetryEvent, type UpdateTelemetryEvent } from "./telemetry"

function event(overrides: Partial<UpdateTelemetryEvent> = {}): UpdateTelemetryEvent {
  return {
    attemptId: "att-1",
    kind: "desktop",
    executor: "tauri",
    channel: "stable",
    fromVersion: "1.0.0",
    toVersion: "1.1.0",
    phase: "installing",
    outcome: "started",
    ...overrides,
  }
}

describe("sanitizeTelemetryEvent", () => {
  it("keeps the declared fields", () => {
    const out = sanitizeTelemetryEvent(event({ bytes: 12, durationMs: 5 }))
    expect(out).toMatchObject({ attemptId: "att-1", bytes: 12, durationMs: 5 })
  })

  it("strips release notes and URLs an adapter smuggled in", () => {
    const dirty = { ...event(), releaseNotes: "secret", externalUrl: "https://x.test" }
    const out = sanitizeTelemetryEvent(dirty as UpdateTelemetryEvent)
    expect(JSON.stringify(out)).not.toContain("secret")
    expect(JSON.stringify(out)).not.toContain("x.test")
  })

  it("strips proxy and header details", () => {
    const dirty = { ...event(), proxy: "http://user:pw@host", headers: { cookie: "a" } }
    const out = sanitizeTelemetryEvent(dirty as unknown as UpdateTelemetryEvent)
    expect(JSON.stringify(out)).not.toContain("user:pw")
    expect(JSON.stringify(out)).not.toContain("cookie")
  })

  it("drops undefined rather than emitting null fields", () => {
    expect(Object.keys(sanitizeTelemetryEvent(event({ bytes: undefined })))).not.toContain("bytes")
  })
})

describe("newAttemptId", () => {
  it("is unique per attempt", () => {
    const ids = new Set(Array.from({ length: 20 }, () => newAttemptId()))
    expect(ids.size).toBe(20)
  })
})
