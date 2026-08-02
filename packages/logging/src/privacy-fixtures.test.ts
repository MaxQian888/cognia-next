import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

import { applyObservabilityPrivacy, createLocalDebugCaptureSession } from "./privacy-manifest"
import { minimalGoldenFixture } from "./observability-event-fixtures"
import type { ObservabilityEventV1, ObservabilityPayload } from "./observability-event"

interface PrivacyFixture {
  name: string
  debugSession: boolean
  input: ObservabilityPayload
  expected: {
    payload: ObservabilityPayload
    removedFields: string[]
    capturePolicy: ObservabilityEventV1["privacy"]["capturePolicy"]
    contentCaptured: boolean
  }
}

const FIXTURE_DIR = join(__dirname, "schemas", "privacy-fixtures")

function loadFixtures(): { file: string; fixture: PrivacyFixture }[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((file) => ({
      file,
      fixture: JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")) as PrivacyFixture,
    }))
}

/**
 * The same fixture corpus is replayed by the Rust privacy gate in
 * `crates/cognia-observability/src/privacy.rs`. A native producer that redacts
 * differently from the renderer is the failure this pins down: both halves must
 * strip the same fields, name the same removals, and reach the same policy.
 */
describe("cross-runtime privacy fixtures", () => {
  const fixtures = loadFixtures()

  it("has fixtures on disk", () => {
    expect(fixtures.length).toBeGreaterThan(0)
  })

  it.each(fixtures)("$file applies the shared manifest", ({ file, fixture }) => {
    const base = minimalGoldenFixture()
    const event: ObservabilityEventV1 = { ...base, payload: fixture.input }
    const now = new Date("2026-08-01T09:15:00.000Z")
    const debugSession = fixture.debugSession ? createLocalDebugCaptureSession(now) : undefined

    const result = applyObservabilityPrivacy(event, { debugSession, now })

    expect({ file, payload: result.payload }).toEqual({ file, payload: fixture.expected.payload })
    expect(result.privacy.removedFields).toEqual(fixture.expected.removedFields)
    expect(result.privacy.capturePolicy).toEqual(fixture.expected.capturePolicy)
    expect(result.privacy.contentCaptured).toEqual(fixture.expected.contentCaptured)
  })

  it("expires a debug session rather than extending capture indefinitely", () => {
    const startedAt = new Date("2026-08-01T09:00:00.000Z")
    const session = createLocalDebugCaptureSession(startedAt)
    const event: ObservabilityEventV1 = {
      ...minimalGoldenFixture(),
      payload: { message: "m", data: { prompt: "secret plan" } },
    }

    const during = applyObservabilityPrivacy(event, {
      debugSession: session,
      now: new Date("2026-08-01T09:29:00.000Z"),
    })
    expect(during.privacy.contentCaptured).toBe(true)

    const after = applyObservabilityPrivacy(event, {
      debugSession: session,
      now: new Date("2026-08-01T09:31:00.000Z"),
    })
    expect(after.privacy.contentCaptured).toBe(false)
    expect(after.privacy.removedFields).toEqual(["payload.data.prompt"])
  })
})
