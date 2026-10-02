import { MAX_TITLE_CHARS, STATUS_SCHEMA_VERSION, type ObservationBatch } from "./contract"
import { createStatusFixture, FIXTURE_ACTIVE_INCIDENT } from "./fixtures"
import {
  isUnsupportedSchemaError,
  parseConfirmResult,
  parseDeliveryRetry,
  parseErrorBody,
  parseIncidentCreate,
  parseIncidentDetail,
  parseIncidentPage,
  parseIncidentResolve,
  parseIncidentUpdate,
  parseMaintenanceChange,
  parseMaintenanceSchedule,
  parseManageRequest,
  parseManageResult,
  parseObservationBatch,
  parseProbeDisable,
  parseProbeEnroll,
  parseProbeSetReference,
  parsePublicSnapshot,
  parseSubscribeRequest,
  parseTokenRequest,
} from "./validate"

const TOKEN = "a".repeat(43)

function batch(overrides: Partial<ObservationBatch> = {}): Record<string, unknown> {
  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    probeId: "ext-1",
    runId: "run_01",
    registryRevision: 3,
    scheduledAt: "2026-10-02T10:00:00.000Z",
    startedAt: "2026-10-02T10:00:00.120Z",
    finishedAt: "2026-10-02T10:00:02.000Z",
    profileId: "native",
    checks: [
      {
        checkId: "signalingHttp",
        result: "pass",
        durationMs: 80,
        reason: null,
        attempted: true,
        dependsOn: null,
      },
      {
        checkId: "signalingAuth",
        result: "fail",
        durationMs: 5000,
        reason: "auth_timeout",
        attempted: true,
        dependsOn: null,
      },
      {
        checkId: "relayData",
        result: "unknown",
        durationMs: null,
        reason: "dependency_failed",
        attempted: false,
        dependsOn: "signalingAuth",
      },
    ],
    ...overrides,
  }
}

describe("parsePublicSnapshot", () => {
  it.each(["operational", "degraded", "major_outage", "maintenance", "unknown", "empty"] as const)(
    "accepts the %s fixture unchanged",
    (variant) => {
      const fixture = createStatusFixture(variant)
      const result = parsePublicSnapshot(JSON.parse(JSON.stringify(fixture)))
      expect(result).toEqual({ ok: true, value: fixture })
    }
  )

  it("reports an unsupported schema version distinctly", () => {
    const result = parsePublicSnapshot({ ...createStatusFixture(), schemaVersion: 2 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(isUnsupportedSchemaError(result.error)).toBe(true)
  })

  it("refuses preview mode, bad percentages and duplicate components", () => {
    const fixture = createStatusFixture()
    expect(parsePublicSnapshot({ ...fixture, mode: "preview" }).ok).toBe(false)
    const badPercent = JSON.parse(JSON.stringify(fixture))
    badPercent.components[0].availability.observedAvailability = 140
    expect(parsePublicSnapshot(badPercent).ok).toBe(false)
    expect(
      parsePublicSnapshot({
        ...fixture,
        components: [fixture.components[0], fixture.components[0]],
      }).ok
    ).toBe(false)
  })

  it("only accepts https links in capabilities", () => {
    const fixture = createStatusFixture()
    const result = parsePublicSnapshot({
      ...fixture,
      capabilities: { ...fixture.capabilities, mirrorUrl: "javascript:alert(1)" },
    })
    expect(result.ok).toBe(false)
  })
})

describe("incident reads", () => {
  it("parses a page and a detail", () => {
    expect(
      parseIncidentPage({
        schemaVersion: 1,
        incidents: [FIXTURE_ACTIVE_INCIDENT],
        nextCursor: null,
      }).ok
    ).toBe(true)
    const detail = parseIncidentDetail({
      schemaVersion: 1,
      incident: { ...FIXTURE_ACTIVE_INCIDENT, updates: [FIXTURE_ACTIVE_INCIDENT.latestUpdate] },
    })
    expect(detail.ok && detail.value.updates).toHaveLength(1)
  })

  it("rejects control characters in operator text", () => {
    const result = parseIncidentPage({
      schemaVersion: 1,
      incidents: [{ ...FIXTURE_ACTIVE_INCIDENT, title: { en: "bad\u0007" } }],
      nextCursor: null,
    })
    expect(result.ok).toBe(false)
  })
})

describe("parseObservationBatch", () => {
  it("accepts a well-formed run with a dependency-skipped check", () => {
    const result = parseObservationBatch(batch())
    expect(result.ok).toBe(true)
  })

  it("normalises timestamps to UTC ISO form", () => {
    const result = parseObservationBatch(batch({ scheduledAt: "2026-10-02T18:00:00+08:00" }))
    expect(result.ok && result.value.scheduledAt).toBe("2026-10-02T10:00:00.000Z")
  })

  it.each([
    ["unordered times", batch({ finishedAt: "2026-10-02T09:59:00.000Z" })],
    ["unknown profile", { ...batch(), profileId: "desktop" }],
    ["future schema", { ...batch(), schemaVersion: 2 }],
    ["duplicate checks", { ...batch(), checks: [batch().checks, batch().checks].flat() }],
    [
      "pass without duration",
      {
        ...batch(),
        checks: [
          {
            checkId: "signalingHttp",
            result: "pass",
            durationMs: null,
            reason: null,
            attempted: true,
            dependsOn: null,
          },
        ],
      },
    ],
    [
      "unattempted pass",
      {
        ...batch(),
        checks: [
          {
            checkId: "relayData",
            result: "pass",
            durationMs: null,
            reason: null,
            attempted: false,
            dependsOn: null,
          },
        ],
      },
    ],
    [
      "failure without reason",
      {
        ...batch(),
        checks: [
          {
            checkId: "signalingHttp",
            result: "fail",
            durationMs: 5,
            reason: null,
            attempted: true,
            dependsOn: null,
          },
        ],
      },
    ],
    [
      "negative duration",
      {
        ...batch(),
        checks: [
          {
            checkId: "signalingHttp",
            result: "pass",
            durationMs: -1,
            reason: null,
            attempted: true,
            dependsOn: null,
          },
        ],
      },
    ],
    [
      "unknown reason",
      { ...batch(), checks: [{ ...(batch().checks as object[])[1], reason: "Error: boom" }] },
    ],
    ["bad probe id", { ...batch(), probeId: "../etc" }],
  ])("rejects %s", (_label, body) => {
    expect(parseObservationBatch(body).ok).toBe(false)
  })
})

describe("subscription bodies", () => {
  it("accepts a subscribe request and rejects duplicate components", () => {
    expect(
      parseSubscribeRequest({
        email: "a@example.com",
        locale: "zh-CN",
        componentIds: [],
        consentVersion: 1,
      }).ok
    ).toBe(true)
    expect(
      parseSubscribeRequest({
        email: "a@example.com",
        locale: "en",
        componentIds: ["relayData", "relayData"],
        consentVersion: 1,
      }).ok
    ).toBe(false)
  })

  it("accepts only base64url tokens of a plausible length", () => {
    expect(parseTokenRequest({ token: TOKEN }).ok).toBe(true)
    expect(parseTokenRequest({ token: "short" }).ok).toBe(false)
    expect(parseTokenRequest({ token: `${TOKEN}=` }).ok).toBe(false)
  })

  it("distinguishes manage reads from revision-checked updates", () => {
    expect(parseManageRequest({ token: TOKEN, operation: "read" })).toEqual({
      ok: true,
      value: { token: TOKEN, operation: "read" },
    })
    expect(
      parseManageRequest({ token: TOKEN, operation: "update", locale: "en", componentIds: [] }).ok
    ).toBe(false)
    expect(
      parseManageRequest({
        token: TOKEN,
        operation: "update",
        expectedRevision: 2,
        locale: "en",
        componentIds: ["signalingHttp"],
      }).ok
    ).toBe(true)
  })

  it("parses confirmation and manage results", () => {
    const preferences = {
      locale: "en",
      componentIds: [],
      maskedEmail: "a•••@example.com",
      revision: 1,
    }
    expect(parseConfirmResult({ status: "confirmed", preferences }).ok).toBe(true)
    expect(parseManageResult({ status: "ok", preferences }).ok).toBe(true)
    expect(parseConfirmResult({ status: "ok", preferences }).ok).toBe(false)
  })
})

describe("operator writes", () => {
  const op = { operationId: "op_000000001" }
  const text = { en: "Investigating" }

  it("validates incident create, update and resolve", () => {
    expect(
      parseIncidentCreate({
        ...op,
        title: text,
        message: text,
        impact: "major_outage",
        componentIds: ["signalingAuth"],
        state: "investigating",
      }).ok
    ).toBe(true)
    expect(
      parseIncidentCreate({
        ...op,
        title: text,
        message: text,
        impact: "major_outage",
        componentIds: [],
        state: "investigating",
      }).ok
    ).toBe(false)
    expect(
      parseIncidentCreate({
        ...op,
        title: { en: "x".repeat(MAX_TITLE_CHARS + 1) },
        message: text,
        impact: "degraded",
        componentIds: ["relayData"],
        state: "identified",
      }).ok
    ).toBe(false)
    const update = parseIncidentUpdate({ ...op, expectedRevision: 2, message: text, pin: true })
    expect(update.ok && update.value).toEqual({
      ...op,
      expectedRevision: 2,
      message: text,
      pin: true,
    })
    expect(parseIncidentResolve({ ...op, expectedRevision: 2, message: text, reason: "" }).ok).toBe(
      false
    )
  })

  it("requires minute-aligned, ordered maintenance windows", () => {
    const schedule = {
      ...op,
      title: text,
      description: text,
      componentIds: ["relayData"],
      startsAt: "2026-10-03T01:00:00.000Z",
      endsAt: "2026-10-03T02:00:00.000Z",
      excludeFromAvailability: true,
    }
    expect(parseMaintenanceSchedule(schedule).ok).toBe(true)
    expect(parseMaintenanceSchedule({ ...schedule, startsAt: "2026-10-03T01:00:30.000Z" }).ok).toBe(
      false
    )
    expect(parseMaintenanceSchedule({ ...schedule, endsAt: schedule.startsAt }).ok).toBe(false)
    expect(
      parseMaintenanceChange({ ...op, expectedRevision: 1, endsAt: "2026-10-03T03:00:00.000Z" }).ok
    ).toBe(true)
  })

  it("validates probe and delivery commands", () => {
    expect(
      parseProbeDisable({ ...op, probeId: "ext-1", disabled: true, reason: "host retired" }).ok
    ).toBe(true)
    expect(
      parseProbeSetReference({
        ...op,
        probeId: "ext-1",
        effectiveAt: "2026-10-03T00:00:00.000Z",
        reason: "enrol",
      }).ok
    ).toBe(true)
    expect(parseDeliveryRetry({ ...op, outboxId: "obx_1", acknowledgeUncertain: false }).ok).toBe(
      true
    )
    const enroll = {
      ...op,
      probeId: "ext-hk-1",
      source: "external",
      label: { en: "External probe", "zh-CN": "外部探针" },
      location: { en: "Hong Kong" },
      provider: "Example VPS",
      enrolledAt: "2026-10-03T00:00:00.000Z",
      profiles: [
        { id: "native", httpCadenceSeconds: 60, protocolCadenceSeconds: 60 },
        { id: "android", httpCadenceSeconds: null, protocolCadenceSeconds: 300 },
      ],
      keyId: "ext-hk-1-k1",
    }
    expect(parseProbeEnroll(enroll).ok).toBe(true)
    expect(
      parseProbeEnroll({
        ...enroll,
        profiles: [{ id: "web", httpCadenceSeconds: null, protocolCadenceSeconds: null }],
      }).ok
    ).toBe(false)
    expect(
      parseProbeEnroll({ ...enroll, profiles: [enroll.profiles[0], enroll.profiles[0]] }).ok
    ).toBe(false)
    expect(
      parseProbeEnroll({
        ...enroll,
        profiles: [{ id: "native", httpCadenceSeconds: 30, protocolCadenceSeconds: 60 }],
      }).ok
    ).toBe(false)
    expect(
      parseDeliveryRetry({ operationId: "short", outboxId: "obx_1", acknowledgeUncertain: false })
        .ok
    ).toBe(false)
  })
})

describe("parseErrorBody", () => {
  it("accepts the error envelope with an optional revision", () => {
    expect(
      parseErrorBody({ code: "revision_conflict", requestId: "r1", currentRevision: 4 })
    ).toEqual({
      ok: true,
      value: { code: "revision_conflict", requestId: "r1", currentRevision: 4 },
    })
    expect(parseErrorBody({ code: "teapot", requestId: "r1" }).ok).toBe(false)
  })
})
