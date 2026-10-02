/**
 * Boundary validation for the public status contract (v1).
 *
 * Every byte that crosses a trust boundary goes through one of these parsers:
 * the public snapshot the page and mirror read, probe observations the Worker
 * ingests, subscription bodies from anonymous browsers, and operator writes.
 * Hand-written on purpose: the same file is bundled into the status Worker and
 * the Node probe, which carry no schema library, and a parser that reports the
 * first failing path is all any caller needs.
 */

import {
  CHECK_IDS,
  CHECK_RESULTS,
  COMPONENT_IDS,
  CONFIDENCE_LEVELS,
  DISPLAY_STATUSES,
  ERROR_CODES,
  HISTORY_RANGES,
  INCIDENT_IMPACTS,
  INCIDENT_STATES,
  MAINTENANCE_STATES,
  MAINTENANCE_UPDATE_KINDS,
  MAX_MESSAGE_CHARS,
  MAX_TITLE_CHARS,
  MONITORING_STATUSES,
  PROBE_SOURCES,
  PROFILE_IDS,
  REASON_CODES,
  STATUS_LOCALES,
  STATUS_SCHEMA_VERSION,
  UPDATE_SOURCES,
  type AvailabilityCounts,
  type AvailabilitySummary,
  type CheckObservation,
  type ComponentId,
  type ComponentSnapshot,
  type ConfirmResult,
  type DeliveryRetryRequest,
  type EvidenceSummary,
  type HistoryBucket,
  type IncidentCreateRequest,
  type IncidentDetail,
  type IncidentPage,
  type IncidentResolveRequest,
  type IncidentSummary,
  type IncidentUpdateRequest,
  type IncidentUpdateView,
  type LatencyBucket,
  type LocalizedText,
  type MaintenanceChangeRequest,
  type MaintenanceScheduleRequest,
  type MaintenanceUpdateView,
  type MaintenanceView,
  type ManageRequest,
  type ManageResult,
  type ObservationBatch,
  type ProbeDisableRequest,
  type ProbeEnrollRequest,
  type ProbeSetReferenceRequest,
  type ProbeSummary,
  type PublicStatusSnapshot,
  type StatusCapabilities,
  type StatusErrorBody,
  type SubscribeRequest,
  type SubscriptionPreferences,
  type TokenRequest,
} from "./contract"
import { isMinuteAligned, parseIsoMs } from "./derive"

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

class ParseError extends Error {}

type Reader<T> = (value: unknown, path: string) => T

function fail(path: string, message: string): never {
  throw new ParseError(`${path}: ${message}`)
}

function run<T>(reader: Reader<T>, value: unknown): ParseResult<T> {
  try {
    return { ok: true, value: reader(value, "$") }
  } catch (error) {
    if (error instanceof ParseError) return { ok: false, error: error.message }
    throw error
  }
}

// --- primitives -------------------------------------------------------------

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "expected object")
  return value as Record<string, unknown>
}

function str(value: unknown, path: string, opts: { min?: number; max?: number } = {}): string {
  if (typeof value !== "string") fail(path, "expected string")
  const length = [...value].length
  if (length < (opts.min ?? 0)) fail(path, "too short")
  if (opts.max !== undefined && length > opts.max) fail(path, "too long")
  return value
}

function nullable<T>(reader: Reader<T>): Reader<T | null> {
  return (value, path) => (value === null ? null : reader(value, path))
}

function optional<T>(reader: Reader<T>): Reader<T | undefined> {
  return (value, path) => (value === undefined ? undefined : reader(value, path))
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "expected boolean")
  return value
}

function num(
  value: unknown,
  path: string,
  opts: { min?: number; max?: number; integer?: boolean } = {}
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "expected finite number")
  if (opts.integer && !Number.isInteger(value)) fail(path, "expected integer")
  if (opts.min !== undefined && value < opts.min) fail(path, `below ${opts.min}`)
  if (opts.max !== undefined && value > opts.max) fail(path, `above ${opts.max}`)
  return value
}

const nonNegInt: Reader<number> = (value, path) => num(value, path, { min: 0, integer: true })
const percent: Reader<number | null> = nullable((value, path) =>
  num(value, path, { min: 0, max: 100 })
)

function oneOf<const T extends readonly string[]>(values: T): Reader<T[number]> {
  return (value, path) => {
    if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
      fail(path, `expected one of ${values.join("|")}`)
    }
    return value as T[number]
  }
}

function list<T>(reader: Reader<T>, opts: { max?: number; min?: number } = {}): Reader<T[]> {
  return (value, path) => {
    if (!Array.isArray(value)) fail(path, "expected array")
    if (opts.max !== undefined && value.length > opts.max) fail(path, "too many items")
    if (opts.min !== undefined && value.length < opts.min) fail(path, "too few items")
    return value.map((item, index) => reader(item, `${path}[${index}]`))
  }
}

function uniqueList<T extends string>(reader: Reader<T>, opts: { max?: number } = {}): Reader<T[]> {
  return (value, path) => {
    const items = list(reader, opts)(value, path)
    if (new Set(items).size !== items.length) fail(path, "duplicate items")
    return items
  }
}

/** A full ISO-8601 timestamp, normalised to UTC `toISOString()` form. */
const iso: Reader<string> = (value, path) => {
  const text = str(value, path, { max: 40 })
  const ms = parseIsoMs(text)
  if (ms === null) fail(path, "expected ISO-8601 timestamp")
  return new Date(ms).toISOString()
}

const minuteIso: Reader<string> = (value, path) => {
  const normalized = iso(value, path)
  if (!isMinuteAligned(Date.parse(normalized))) fail(path, "must be minute-aligned")
  return normalized
}

/** Opaque identifiers (incidents, runs, probes): letters, digits, `-`, `_`, `.`, `:`. */
export const STATUS_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const ID_PATTERN = STATUS_ID_PATTERN
const opaqueId: Reader<string> = (value, path) => {
  const text = str(value, path)
  if (!ID_PATTERN.test(text)) fail(path, "invalid identifier")
  return text
}

/** Plain text: no control characters other than newline and tab. */
function plainText(max: number, min = 0): Reader<string> {
  return (value, path) => {
    const text = str(value, path, { min, max })

    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
      fail(path, "control characters not allowed")
    }
    return text
  }
}

function localized(max: number): Reader<LocalizedText> {
  return (value, path) => {
    const raw = record(value, path)
    const en = plainText(max, 1)(raw.en, `${path}.en`)
    if (en.trim().length === 0) fail(`${path}.en`, "must not be blank")
    const zh = optional(plainText(max))(raw["zh-CN"], `${path}.zh-CN`)
    return zh === undefined || zh.trim().length === 0 ? { en } : { en, "zh-CN": zh }
  }
}

const componentId = oneOf(COMPONENT_IDS)
const componentIds = uniqueList(componentId, { max: COMPONENT_IDS.length })

/** HTTPS URL, or null. Used for mirror/primary links shown to the public. */
const httpsUrl: Reader<string> = (value, path) => {
  const text = str(value, path, { max: 2048 })
  let url: URL
  try {
    url = new URL(text)
  } catch {
    fail(path, "invalid URL")
  }
  if (url.protocol !== "https:" || url.username || url.password) fail(path, "expected https URL")
  return url.toString()
}

// --- snapshot ---------------------------------------------------------------

const countsReader: Reader<AvailabilityCounts> = (value, path) => {
  const raw = record(value, path)
  return {
    passCount: nonNegInt(raw.passCount, `${path}.passCount`),
    failCount: nonNegInt(raw.failCount, `${path}.failCount`),
    unknownCount: nonNegInt(raw.unknownCount, `${path}.unknownCount`),
    expectedSlots: nonNegInt(raw.expectedSlots, `${path}.expectedSlots`),
  }
}

const availabilityReader: Reader<AvailabilitySummary> = (value, path) => {
  const raw = record(value, path)
  const counts = countsReader(raw, path)
  const adjustedRaw = record(raw.maintenanceAdjusted, `${path}.maintenanceAdjusted`)
  return {
    ...counts,
    observedAvailability: percent(raw.observedAvailability, `${path}.observedAvailability`),
    coverage: percent(raw.coverage, `${path}.coverage`),
    excludedSlots: nonNegInt(raw.excludedSlots, `${path}.excludedSlots`),
    maintenanceAdjusted: {
      ...countsReader(adjustedRaw, `${path}.maintenanceAdjusted`),
      observedAvailability: percent(
        adjustedRaw.observedAvailability,
        `${path}.maintenanceAdjusted.observedAvailability`
      ),
      coverage: percent(adjustedRaw.coverage, `${path}.maintenanceAdjusted.coverage`),
    },
  }
}

const historyBucketReader: Reader<HistoryBucket> = (value, path) => {
  const raw = record(value, path)
  return {
    start: iso(raw.start, `${path}.start`),
    end: iso(raw.end, `${path}.end`),
    partial: bool(raw.partial, `${path}.partial`),
    status: oneOf([...DISPLAY_STATUSES, "no_data"] as const)(raw.status, `${path}.status`),
    availability: availabilityReader(raw.availability, `${path}.availability`),
  }
}

const latencyBucketReader: Reader<LatencyBucket> = (value, path) => {
  const raw = record(value, path)
  const ms = nullable((v: unknown, p: string) => num(v, p, { min: 0 }))
  return {
    start: iso(raw.start, `${path}.start`),
    end: iso(raw.end, `${path}.end`),
    sampleCount: nonNegInt(raw.sampleCount, `${path}.sampleCount`),
    p50Ms: ms(raw.p50Ms, `${path}.p50Ms`),
    p95Ms: ms(raw.p95Ms, `${path}.p95Ms`),
  }
}

const evidenceReader: Reader<EvidenceSummary> = (value, path) => {
  const raw = record(value, path)
  return {
    probeId: opaqueId(raw.probeId, `${path}.probeId`),
    profileId: oneOf(PROFILE_IDS)(raw.profileId, `${path}.profileId`),
    source: oneOf(PROBE_SOURCES)(raw.source, `${path}.source`),
    reference: bool(raw.reference, `${path}.reference`),
    result: oneOf(CHECK_RESULTS)(raw.result, `${path}.result`),
    reason: nullable(oneOf(REASON_CODES))(raw.reason, `${path}.reason`),
    checkedAt: nullable(iso)(raw.checkedAt, `${path}.checkedAt`),
    fresh: bool(raw.fresh, `${path}.fresh`),
    consecutiveFailures: nonNegInt(raw.consecutiveFailures, `${path}.consecutiveFailures`),
    simulatedOrigin: bool(raw.simulatedOrigin, `${path}.simulatedOrigin`),
  }
}

const componentReader: Reader<ComponentSnapshot> = (value, path) => {
  const raw = record(value, path)
  const latency = record(raw.latency, `${path}.latency`)
  return {
    id: componentId(raw.id, `${path}.id`),
    status: oneOf(DISPLAY_STATUSES)(raw.status, `${path}.status`),
    confidence: oneOf(CONFIDENCE_LEVELS)(raw.confidence, `${path}.confidence`),
    latestEvidenceAt: nullable(iso)(raw.latestEvidenceAt, `${path}.latestEvidenceAt`),
    inMaintenance: bool(raw.inMaintenance, `${path}.inMaintenance`),
    availability: availabilityReader(raw.availability, `${path}.availability`),
    history: list(historyBucketReader, { max: 90 })(raw.history, `${path}.history`),
    latency: {
      phase: oneOf(["http", "auth", "data"] as const)(latency.phase, `${path}.latency.phase`),
      minSamples: nonNegInt(latency.minSamples, `${path}.latency.minSamples`),
      summary: latencyBucketReader(latency.summary, `${path}.latency.summary`),
      buckets: list(latencyBucketReader, { max: 90 })(latency.buckets, `${path}.latency.buckets`),
    },
    evidence: list(evidenceReader, { max: 64 })(raw.evidence, `${path}.evidence`),
  }
}

const probeReader: Reader<ProbeSummary> = (value, path) => {
  const raw = record(value, path)
  return {
    id: opaqueId(raw.id, `${path}.id`),
    label: localized(MAX_TITLE_CHARS)(raw.label, `${path}.label`),
    source: oneOf(PROBE_SOURCES)(raw.source, `${path}.source`),
    location: nullable(localized(MAX_TITLE_CHARS))(raw.location, `${path}.location`),
    provider: nullable((v: unknown, p: string) => plainText(80)(v, p))(
      raw.provider,
      `${path}.provider`
    ),
    profiles: list(
      (item, itemPath) => {
        const profile = record(item, itemPath)
        return {
          id: oneOf(PROFILE_IDS)(profile.id, `${itemPath}.id`),
          cadenceSeconds: num(profile.cadenceSeconds, `${itemPath}.cadenceSeconds`, {
            min: 1,
            integer: true,
          }),
          simulatedOrigin: bool(profile.simulatedOrigin, `${itemPath}.simulatedOrigin`),
        }
      },
      { max: PROFILE_IDS.length }
    )(raw.profiles, `${path}.profiles`),
    reference: bool(raw.reference, `${path}.reference`),
    enrolledAt: iso(raw.enrolledAt, `${path}.enrolledAt`),
    lastAttemptAt: nullable(iso)(raw.lastAttemptAt, `${path}.lastAttemptAt`),
    lastSuccessAt: nullable(iso)(raw.lastSuccessAt, `${path}.lastSuccessAt`),
    health: oneOf(["healthy", "stale", "error", "disabled", "unknown"] as const)(
      raw.health,
      `${path}.health`
    ),
    reason: nullable(oneOf(REASON_CODES))(raw.reason, `${path}.reason`),
  }
}

const incidentUpdateReader: Reader<IncidentUpdateView> = (value, path) => {
  const raw = record(value, path)
  return {
    id: opaqueId(raw.id, `${path}.id`),
    state: oneOf(INCIDENT_STATES)(raw.state, `${path}.state`),
    impact: oneOf(INCIDENT_IMPACTS)(raw.impact, `${path}.impact`),
    componentIds: componentIds(raw.componentIds, `${path}.componentIds`),
    message: localized(MAX_MESSAGE_CHARS)(raw.message, `${path}.message`),
    source: oneOf(UPDATE_SOURCES)(raw.source, `${path}.source`),
    at: iso(raw.at, `${path}.at`),
    correctionOf: nullable(opaqueId)(raw.correctionOf, `${path}.correctionOf`),
  }
}

const incidentSummaryReader: Reader<IncidentSummary> = (value, path) => {
  const raw = record(value, path)
  return {
    id: opaqueId(raw.id, `${path}.id`),
    title: localized(MAX_TITLE_CHARS)(raw.title, `${path}.title`),
    state: oneOf(INCIDENT_STATES)(raw.state, `${path}.state`),
    impact: oneOf(INCIDENT_IMPACTS)(raw.impact, `${path}.impact`),
    componentIds: componentIds(raw.componentIds, `${path}.componentIds`),
    source: oneOf(UPDATE_SOURCES)(raw.source, `${path}.source`),
    startedAt: iso(raw.startedAt, `${path}.startedAt`),
    resolvedAt: nullable(iso)(raw.resolvedAt, `${path}.resolvedAt`),
    updatedAt: iso(raw.updatedAt, `${path}.updatedAt`),
    revision: nonNegInt(raw.revision, `${path}.revision`),
    predecessorId: nullable(opaqueId)(raw.predecessorId, `${path}.predecessorId`),
    latestUpdate: nullable(incidentUpdateReader)(raw.latestUpdate, `${path}.latestUpdate`),
  }
}

const incidentDetailReader: Reader<IncidentDetail> = (value, path) => {
  const raw = record(value, path)
  return {
    ...incidentSummaryReader(raw, path),
    updates: list(incidentUpdateReader, { max: 500 })(raw.updates, `${path}.updates`),
  }
}

const maintenanceUpdateReader: Reader<MaintenanceUpdateView> = (value, path) => {
  const raw = record(value, path)
  return {
    id: opaqueId(raw.id, `${path}.id`),
    kind: oneOf(MAINTENANCE_UPDATE_KINDS)(raw.kind, `${path}.kind`),
    message: nullable(localized(MAX_MESSAGE_CHARS))(raw.message, `${path}.message`),
    at: iso(raw.at, `${path}.at`),
  }
}

const maintenanceReader: Reader<MaintenanceView> = (value, path) => {
  const raw = record(value, path)
  return {
    id: opaqueId(raw.id, `${path}.id`),
    title: localized(MAX_TITLE_CHARS)(raw.title, `${path}.title`),
    description: localized(MAX_MESSAGE_CHARS)(raw.description, `${path}.description`),
    componentIds: componentIds(raw.componentIds, `${path}.componentIds`),
    state: oneOf(MAINTENANCE_STATES)(raw.state, `${path}.state`),
    startsAt: iso(raw.startsAt, `${path}.startsAt`),
    endsAt: iso(raw.endsAt, `${path}.endsAt`),
    actualEndAt: nullable(iso)(raw.actualEndAt, `${path}.actualEndAt`),
    excludeFromAvailability: bool(raw.excludeFromAvailability, `${path}.excludeFromAvailability`),
    revision: nonNegInt(raw.revision, `${path}.revision`),
    updates: list(maintenanceUpdateReader, { max: 200 })(raw.updates, `${path}.updates`),
  }
}

const capabilitiesReader: Reader<StatusCapabilities> = (value, path) => {
  const raw = record(value, path)
  return {
    email: bool(raw.email, `${path}.email`),
    feeds: bool(raw.feeds, `${path}.feeds`),
    locales: uniqueList(oneOf(STATUS_LOCALES))(raw.locales, `${path}.locales`),
    historyRanges: uniqueList(oneOf(HISTORY_RANGES))(raw.historyRanges, `${path}.historyRanges`),
    mirrorUrl: nullable(httpsUrl)(raw.mirrorUrl, `${path}.mirrorUrl`),
    primaryUrl: nullable(httpsUrl)(raw.primaryUrl, `${path}.primaryUrl`),
  }
}

function schemaVersion(value: unknown, path: string): typeof STATUS_SCHEMA_VERSION {
  if (value !== STATUS_SCHEMA_VERSION) fail(path, "unsupported_schema")
  return STATUS_SCHEMA_VERSION
}

const snapshotReader: Reader<PublicStatusSnapshot> = (value, path) => {
  const raw = record(value, path)
  schemaVersion(raw.schemaVersion, `${path}.schemaVersion`)
  if (raw.mode !== "live") fail(`${path}.mode`, "expected live")
  const freshness = record(raw.freshness, `${path}.freshness`)
  const overall = record(raw.overall, `${path}.overall`)
  const components = list(componentReader, { max: COMPONENT_IDS.length })(
    raw.components,
    `${path}.components`
  )
  if (new Set(components.map((component) => component.id)).size !== components.length) {
    fail(`${path}.components`, "duplicate component")
  }
  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    mode: "live",
    revision: nonNegInt(raw.revision, `${path}.revision`),
    generatedAt: iso(raw.generatedAt, `${path}.generatedAt`),
    serverTime: iso(raw.serverTime, `${path}.serverTime`),
    observationStartedAt: nullable(iso)(raw.observationStartedAt, `${path}.observationStartedAt`),
    range: oneOf(HISTORY_RANGES)(raw.range, `${path}.range`),
    staleAfterMs: num(raw.staleAfterMs, `${path}.staleAfterMs`, { min: 1, integer: true }),
    freshness: {
      referenceFreshMs: num(freshness.referenceFreshMs, `${path}.freshness.referenceFreshMs`, {
        min: 1,
        integer: true,
      }),
      profileFreshMs: num(freshness.profileFreshMs, `${path}.freshness.profileFreshMs`, {
        min: 1,
        integer: true,
      }),
    },
    overallStatus: oneOf(DISPLAY_STATUSES)(raw.overallStatus, `${path}.overallStatus`),
    monitoringStatus: oneOf(MONITORING_STATUSES)(raw.monitoringStatus, `${path}.monitoringStatus`),
    overall: {
      availability: availabilityReader(overall.availability, `${path}.overall.availability`),
      history: list(historyBucketReader, { max: 90 })(overall.history, `${path}.overall.history`),
    },
    components,
    probes: list(probeReader, { max: 32 })(raw.probes, `${path}.probes`),
    activeIncidents: list(incidentSummaryReader, { max: 50 })(
      raw.activeIncidents,
      `${path}.activeIncidents`
    ),
    pastIncidents: list(incidentSummaryReader, { max: 50 })(
      raw.pastIncidents,
      `${path}.pastIncidents`
    ),
    scheduledMaintenance: list(maintenanceReader, { max: 50 })(
      raw.scheduledMaintenance,
      `${path}.scheduledMaintenance`
    ),
    capabilities: capabilitiesReader(raw.capabilities, `${path}.capabilities`),
  }
}

export function parsePublicSnapshot(value: unknown): ParseResult<PublicStatusSnapshot> {
  return run(snapshotReader, value)
}

/** True when the failure is a schema-version mismatch rather than a bad body. */
export function isUnsupportedSchemaError(error: string): boolean {
  return error.endsWith("unsupported_schema")
}

export function parseIncidentPage(value: unknown): ParseResult<IncidentPage> {
  return run((raw, path) => {
    const body = record(raw, path)
    return {
      schemaVersion: schemaVersion(body.schemaVersion, `${path}.schemaVersion`),
      incidents: list(incidentSummaryReader, { max: 50 })(body.incidents, `${path}.incidents`),
      nextCursor: nullable((v: unknown, p: string) => str(v, p, { min: 1, max: 256 }))(
        body.nextCursor,
        `${path}.nextCursor`
      ),
    }
  }, value)
}

export function parseIncidentDetail(value: unknown): ParseResult<IncidentDetail> {
  return run((raw, path) => {
    const body = record(raw, path)
    schemaVersion(body.schemaVersion, `${path}.schemaVersion`)
    return incidentDetailReader(body.incident, `${path}.incident`)
  }, value)
}

export function parseErrorBody(value: unknown): ParseResult<StatusErrorBody> {
  return run((raw, path) => {
    const body = record(raw, path)
    return {
      code: oneOf(ERROR_CODES)(body.code, `${path}.code`),
      requestId: str(body.requestId, `${path}.requestId`, { max: 128 }),
      ...(body.currentRevision === undefined
        ? {}
        : { currentRevision: nonNegInt(body.currentRevision, `${path}.currentRevision`) }),
    }
  }, value)
}

// --- probe ingestion ----------------------------------------------------------

const checkObservationReader: Reader<CheckObservation> = (value, path) => {
  const raw = record(value, path)
  const attempted = bool(raw.attempted, `${path}.attempted`)
  const result = oneOf(CHECK_RESULTS)(raw.result, `${path}.result`)
  const durationMs = nullable((v: unknown, p: string) => num(v, p, { min: 0, max: 600_000 }))(
    raw.durationMs,
    `${path}.durationMs`
  )
  if (!attempted && result !== "unknown")
    fail(`${path}.result`, "unattempted check must be unknown")
  if (!attempted && durationMs !== null)
    fail(`${path}.durationMs`, "unattempted check has no duration")
  if (result === "pass" && durationMs === null) fail(`${path}.durationMs`, "pass needs a duration")
  const reason = nullable(oneOf(REASON_CODES))(raw.reason, `${path}.reason`)
  if (result === "pass" && reason !== null) fail(`${path}.reason`, "pass has no reason")
  if (result !== "pass" && reason === null) fail(`${path}.reason`, "non-pass needs a reason")
  return {
    checkId: oneOf(CHECK_IDS)(raw.checkId, `${path}.checkId`),
    result,
    durationMs,
    reason,
    attempted,
    dependsOn: nullable(oneOf(CHECK_IDS))(raw.dependsOn, `${path}.dependsOn`),
  }
}

export function parseObservationBatch(value: unknown): ParseResult<ObservationBatch> {
  return run((raw, path) => {
    const body = record(raw, path)
    const scheduledAt = iso(body.scheduledAt, `${path}.scheduledAt`)
    const startedAt = iso(body.startedAt, `${path}.startedAt`)
    const finishedAt = iso(body.finishedAt, `${path}.finishedAt`)
    if (Date.parse(finishedAt) < Date.parse(startedAt)) {
      fail(`${path}.finishedAt`, "before startedAt")
    }
    const checks = list(checkObservationReader, { min: 1, max: CHECK_IDS.length })(
      body.checks,
      `${path}.checks`
    )
    if (new Set(checks.map((check) => check.checkId)).size !== checks.length) {
      fail(`${path}.checks`, "duplicate checkId")
    }
    return {
      schemaVersion: schemaVersion(body.schemaVersion, `${path}.schemaVersion`),
      probeId: opaqueId(body.probeId, `${path}.probeId`),
      runId: opaqueId(body.runId, `${path}.runId`),
      registryRevision: nonNegInt(body.registryRevision, `${path}.registryRevision`),
      scheduledAt,
      startedAt,
      finishedAt,
      profileId: oneOf(PROFILE_IDS)(body.profileId, `${path}.profileId`),
      checks,
    }
  }, value)
}

// --- subscriptions ------------------------------------------------------------

/** Tokens are 32 random bytes as base64url (43 chars); allow some headroom. */
const tokenReader: Reader<string> = (value, path) => {
  const text = str(value, path, { min: 32, max: 128 })
  if (!/^[A-Za-z0-9_-]+$/.test(text)) fail(path, "invalid token")
  return text
}

export function parseSubscribeRequest(value: unknown): ParseResult<SubscribeRequest> {
  return run((raw, path) => {
    const body = record(raw, path)
    return {
      email: str(body.email, `${path}.email`, { min: 3, max: 254 }),
      locale: oneOf(STATUS_LOCALES)(body.locale, `${path}.locale`),
      componentIds: componentIds(body.componentIds, `${path}.componentIds`),
      consentVersion: num(body.consentVersion, `${path}.consentVersion`, { min: 1, integer: true }),
    }
  }, value)
}

export function parseTokenRequest(value: unknown): ParseResult<TokenRequest> {
  return run(
    (raw, path) => ({ token: tokenReader(record(raw, path).token, `${path}.token`) }),
    value
  )
}

export function parseManageRequest(value: unknown): ParseResult<ManageRequest> {
  return run((raw, path) => {
    const body = record(raw, path)
    const token = tokenReader(body.token, `${path}.token`)
    const operation = oneOf(["read", "update"] as const)(body.operation, `${path}.operation`)
    if (operation === "read") return { token, operation }
    return {
      token,
      operation,
      expectedRevision: nonNegInt(body.expectedRevision, `${path}.expectedRevision`),
      locale: oneOf(STATUS_LOCALES)(body.locale, `${path}.locale`),
      componentIds: componentIds(body.componentIds, `${path}.componentIds`),
    }
  }, value)
}

const preferencesReader: Reader<SubscriptionPreferences> = (value, path) => {
  const raw = record(value, path)
  return {
    locale: oneOf(STATUS_LOCALES)(raw.locale, `${path}.locale`),
    componentIds: componentIds(raw.componentIds, `${path}.componentIds`),
    maskedEmail: str(raw.maskedEmail, `${path}.maskedEmail`, { min: 1, max: 254 }),
    revision: nonNegInt(raw.revision, `${path}.revision`),
  }
}

export function parseConfirmResult(value: unknown): ParseResult<ConfirmResult> {
  return run((raw, path) => {
    const body = record(raw, path)
    if (body.status !== "confirmed") fail(`${path}.status`, "expected confirmed")
    return {
      status: "confirmed" as const,
      preferences: preferencesReader(body.preferences, `${path}.preferences`),
    }
  }, value)
}

export function parseManageResult(value: unknown): ParseResult<ManageResult> {
  return run((raw, path) => {
    const body = record(raw, path)
    if (body.status !== "ok") fail(`${path}.status`, "expected ok")
    return {
      status: "ok" as const,
      preferences: preferencesReader(body.preferences, `${path}.preferences`),
    }
  }, value)
}

// --- operator writes ------------------------------------------------------------

const operationId: Reader<string> = (value, path) => {
  const text = str(value, path, { min: 8, max: 128 })
  if (!ID_PATTERN.test(text)) fail(path, "invalid operation id")
  return text
}

const reasonText = plainText(500, 1)

export function parseIncidentCreate(value: unknown): ParseResult<IncidentCreateRequest> {
  return run((raw, path) => {
    const body = record(raw, path)
    return {
      operationId: operationId(body.operationId, `${path}.operationId`),
      title: localized(MAX_TITLE_CHARS)(body.title, `${path}.title`),
      message: localized(MAX_MESSAGE_CHARS)(body.message, `${path}.message`),
      impact: oneOf(INCIDENT_IMPACTS)(body.impact, `${path}.impact`),
      componentIds: list(componentId, { min: 1, max: COMPONENT_IDS.length })(
        body.componentIds,
        `${path}.componentIds`
      ),
      state: oneOf(["investigating", "identified", "monitoring"] as const)(
        body.state,
        `${path}.state`
      ),
    }
  }, value)
}

export function parseIncidentUpdate(value: unknown): ParseResult<IncidentUpdateRequest> {
  return run((raw, path) => {
    const body = record(raw, path)
    const result: IncidentUpdateRequest = {
      operationId: operationId(body.operationId, `${path}.operationId`),
      expectedRevision: nonNegInt(body.expectedRevision, `${path}.expectedRevision`),
      message: localized(MAX_MESSAGE_CHARS)(body.message, `${path}.message`),
    }
    const state = optional(oneOf(INCIDENT_STATES))(body.state, `${path}.state`)
    const impact = optional(oneOf(INCIDENT_IMPACTS))(body.impact, `${path}.impact`)
    const ids = optional(list(componentId, { min: 1, max: COMPONENT_IDS.length }))(
      body.componentIds,
      `${path}.componentIds`
    )
    const pin = optional(bool)(body.pin, `${path}.pin`)
    const correctionOf = optional(opaqueId)(body.correctionOf, `${path}.correctionOf`)
    if (state !== undefined) result.state = state
    if (impact !== undefined) result.impact = impact
    if (ids !== undefined) result.componentIds = ids
    if (pin !== undefined) result.pin = pin
    if (correctionOf !== undefined) result.correctionOf = correctionOf
    return result
  }, value)
}

export function parseIncidentResolve(value: unknown): ParseResult<IncidentResolveRequest> {
  return run((raw, path) => {
    const body = record(raw, path)
    return {
      operationId: operationId(body.operationId, `${path}.operationId`),
      expectedRevision: nonNegInt(body.expectedRevision, `${path}.expectedRevision`),
      message: localized(MAX_MESSAGE_CHARS)(body.message, `${path}.message`),
      reason: reasonText(body.reason, `${path}.reason`),
    }
  }, value)
}

export function parseMaintenanceSchedule(value: unknown): ParseResult<MaintenanceScheduleRequest> {
  return run((raw, path) => {
    const body = record(raw, path)
    const startsAt = minuteIso(body.startsAt, `${path}.startsAt`)
    const endsAt = minuteIso(body.endsAt, `${path}.endsAt`)
    if (Date.parse(endsAt) <= Date.parse(startsAt)) fail(`${path}.endsAt`, "must be after startsAt")
    return {
      operationId: operationId(body.operationId, `${path}.operationId`),
      title: localized(MAX_TITLE_CHARS)(body.title, `${path}.title`),
      description: localized(MAX_MESSAGE_CHARS)(body.description, `${path}.description`),
      componentIds: list(componentId, { min: 1, max: COMPONENT_IDS.length })(
        body.componentIds,
        `${path}.componentIds`
      ),
      startsAt,
      endsAt,
      excludeFromAvailability: bool(
        body.excludeFromAvailability,
        `${path}.excludeFromAvailability`
      ),
    }
  }, value)
}

export function parseMaintenanceChange(value: unknown): ParseResult<MaintenanceChangeRequest> {
  return run((raw, path) => {
    const body = record(raw, path)
    const result: MaintenanceChangeRequest = {
      operationId: operationId(body.operationId, `${path}.operationId`),
      expectedRevision: nonNegInt(body.expectedRevision, `${path}.expectedRevision`),
    }
    const message = optional(localized(MAX_MESSAGE_CHARS))(body.message, `${path}.message`)
    const startsAt = optional(minuteIso)(body.startsAt, `${path}.startsAt`)
    const endsAt = optional(minuteIso)(body.endsAt, `${path}.endsAt`)
    if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
      fail(`${path}.endsAt`, "must be after startsAt")
    }
    if (message !== undefined) result.message = message
    if (startsAt !== undefined) result.startsAt = startsAt
    if (endsAt !== undefined) result.endsAt = endsAt
    return result
  }, value)
}

export function parseProbeDisable(value: unknown): ParseResult<ProbeDisableRequest> {
  return run((raw, path) => {
    const body = record(raw, path)
    return {
      operationId: operationId(body.operationId, `${path}.operationId`),
      probeId: opaqueId(body.probeId, `${path}.probeId`),
      disabled: bool(body.disabled, `${path}.disabled`),
      reason: reasonText(body.reason, `${path}.reason`),
    }
  }, value)
}

export function parseProbeSetReference(value: unknown): ParseResult<ProbeSetReferenceRequest> {
  return run((raw, path) => {
    const body = record(raw, path)
    return {
      operationId: operationId(body.operationId, `${path}.operationId`),
      probeId: opaqueId(body.probeId, `${path}.probeId`),
      effectiveAt: minuteIso(body.effectiveAt, `${path}.effectiveAt`),
      reason: reasonText(body.reason, `${path}.reason`),
    }
  }, value)
}

export function parseProbeEnroll(value: unknown): ParseResult<ProbeEnrollRequest> {
  return run((raw, path) => {
    const body = record(raw, path)
    const cadence = nullable((v: unknown, p: string) =>
      num(v, p, { min: 60, max: 3_600, integer: true })
    )
    const profiles = list(
      (item, itemPath) => {
        const profile = record(item, itemPath)
        const result = {
          id: oneOf(PROFILE_IDS)(profile.id, `${itemPath}.id`),
          httpCadenceSeconds: cadence(profile.httpCadenceSeconds, `${itemPath}.httpCadenceSeconds`),
          protocolCadenceSeconds: cadence(
            profile.protocolCadenceSeconds,
            `${itemPath}.protocolCadenceSeconds`
          ),
        }
        if (result.httpCadenceSeconds === null && result.protocolCadenceSeconds === null) {
          fail(itemPath, "profile runs no checks")
        }
        return result
      },
      { min: 1, max: PROFILE_IDS.length }
    )(body.profiles, `${path}.profiles`)
    if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) {
      fail(`${path}.profiles`, "duplicate profile")
    }
    return {
      operationId: operationId(body.operationId, `${path}.operationId`),
      probeId: opaqueId(body.probeId, `${path}.probeId`),
      source: oneOf(PROBE_SOURCES)(body.source, `${path}.source`),
      label: localized(MAX_TITLE_CHARS)(body.label, `${path}.label`),
      location: nullable(localized(MAX_TITLE_CHARS))(body.location, `${path}.location`),
      provider: nullable(plainText(80, 1))(body.provider, `${path}.provider`),
      enrolledAt: minuteIso(body.enrolledAt, `${path}.enrolledAt`),
      profiles,
      keyId: opaqueId(body.keyId, `${path}.keyId`),
    }
  }, value)
}

export function parseDeliveryRetry(value: unknown): ParseResult<DeliveryRetryRequest> {
  return run((raw, path) => {
    const body = record(raw, path)
    return {
      operationId: operationId(body.operationId, `${path}.operationId`),
      outboxId: opaqueId(body.outboxId, `${path}.outboxId`),
      acknowledgeUncertain: bool(body.acknowledgeUncertain, `${path}.acknowledgeUncertain`),
    }
  }, value)
}

/** Narrow helper for callers that only need a component-ID list check. */
export function isComponentId(value: unknown): value is ComponentId {
  return typeof value === "string" && (COMPONENT_IDS as readonly string[]).includes(value)
}
