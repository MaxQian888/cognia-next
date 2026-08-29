/**
 * Tolerant readers for Cloudflare's observability responses.
 *
 * `logs()` and `analytics()` returned `unknown` and the console rendered them
 * with `<JsonTree>` — honest, and unusable. These turn the two payloads into
 * shapes a table and a chart can read.
 *
 * **Shape drift must never crash the console.** Every access goes through the
 * local `asRecord` / `asArray` / `asNumber` / `asString` helpers, which return
 * `undefined` on a mismatch; there is no cast, and nothing destructures an
 * `unknown`. When a payload is unrecognizable the views say so and the caller
 * falls back to the JSON tree, which is why that escape hatch stays reachable.
 *
 * The single most likely drift is structural rather than cosmetic:
 * `queryWorkerAnalytics` returns *either* the bare worker payload *or*
 * `{ worker, web }`, depending on whether both a zone id and a hostname were
 * available. Both are accepted.
 */

export type SiteLogLevel = "error" | "warn" | "info" | "debug" | "unknown"

export interface SiteLogEntry {
  id: string
  timestamp: number
  level: SiteLogLevel
  message: string
  outcome?: string
  requestMethod?: string
  requestUrl?: string
  statusCode?: number
  durationMs?: number
  /** The original event, for the row's expandable detail. */
  raw: unknown
}

export interface SiteLogsView {
  entries: SiteLogEntry[]
  /** Events present in the payload that could not be read as a log line. */
  unparsed: number
  /** True when the payload's shape was not recognized at all. */
  unrecognized: boolean
}

export interface SiteAnalyticsPoint {
  date: string
  requests: number
  errors: number
  subrequests: number
}

export interface SiteWebPoint {
  date: string
  requests: number
  pageViews: number
  bytes: number
  uniques: number
}

export interface SiteAnalyticsView {
  worker: { points: SiteAnalyticsPoint[]; totals: SiteAnalyticsPoint }
  web?: { points: SiteWebPoint[]; totals: SiteWebPoint }
  /** GraphQL `errors[]` messages, which can arrive alongside partial data. */
  providerErrors: string[]
  unrecognized: boolean
}

/* ------------------------------------------------------------- primitives */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** Epoch millis from a number (ms or seconds) or an ISO string. */
function asTimestamp(value: unknown): number | undefined {
  const numeric = asNumber(value)
  // Cloudflare mixes seconds and milliseconds across products; anything below
  // this threshold is far too old to be a log line and is therefore seconds.
  if (numeric !== undefined) return numeric < 1e12 ? numeric * 1000 : numeric
  const text = asString(value)
  if (!text) return undefined
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? undefined : parsed
}

function asLevel(value: unknown): SiteLogLevel | undefined {
  const text = asString(value)?.toLowerCase()
  if (!text) return undefined
  if (text === "error" || text === "fatal") return "error"
  if (text === "warn" || text === "warning") return "warn"
  if (text === "info" || text === "log") return "info"
  if (text === "debug" || text === "trace") return "debug"
  return undefined
}

/* -------------------------------------------------------------------- logs */

/** The event list, wherever this account's response happens to carry it. */
function logEvents(value: unknown): unknown[] | undefined {
  const direct = asArray(value)
  if (direct) return direct
  const root = asRecord(value)
  if (!root) return undefined
  for (const container of [root, asRecord(root.result)]) {
    if (!container) continue
    for (const key of ["events", "records", "rows", "result"]) {
      const list = asArray(container[key])
      if (list) return list
    }
  }
  return undefined
}

function parseLogEntry(raw: unknown, index: number): SiteLogEntry | undefined {
  const event = asRecord(raw)
  if (!event) return undefined
  const metadata = asRecord(event.$metadata) ?? {}
  const timestamp = asTimestamp(event.timestamp ?? metadata.timestamp)
  if (timestamp === undefined) return undefined

  const source = asRecord(event.source) ?? {}
  const request = asRecord(event.request) ?? asRecord(source.request) ?? {}
  const response = asRecord(event.response) ?? asRecord(source.response) ?? {}
  const outcome = asString(event.outcome ?? source.outcome ?? metadata.outcome)
  const errorText = asString(metadata.error)

  const message =
    asString(event.message ?? metadata.message ?? source.message) ??
    errorText ??
    asString(metadata.trigger) ??
    outcome ??
    ""

  return {
    id: asString(asRecord(event.$workers)?.eventUuid) ?? asString(metadata.id) ?? `log-${index}`,
    timestamp,
    // A recorded error outranks a level field that says otherwise: the
    // `errorsOnly` filter selects on exactly this, so the row must agree.
    level: errorText ? "error" : (asLevel(metadata.level ?? event.level) ?? "unknown"),
    message,
    ...(outcome ? { outcome } : {}),
    ...(asString(request.method) ? { requestMethod: asString(request.method) } : {}),
    ...(asString(request.url) ? { requestUrl: asString(request.url) } : {}),
    ...(asNumber(response.status) !== undefined ? { statusCode: asNumber(response.status) } : {}),
    ...(asNumber(event.wallTimeMs ?? metadata.duration) !== undefined
      ? { durationMs: asNumber(event.wallTimeMs ?? metadata.duration) }
      : {}),
    raw,
  }
}

export function parseSiteWorkerLogs(value: unknown): SiteLogsView {
  const events = logEvents(value)
  if (!events) return { entries: [], unparsed: 0, unrecognized: true }

  const entries: SiteLogEntry[] = []
  let unparsed = 0
  events.forEach((event, index) => {
    const entry = parseLogEntry(event, index)
    if (entry) entries.push(entry)
    // Counted rather than dropped: silently losing rows would make a partial
    // read look like a quiet period.
    else unparsed += 1
  })
  entries.sort((left, right) => right.timestamp - left.timestamp)
  return { entries, unparsed, unrecognized: false }
}

/* --------------------------------------------------------------- analytics */

const EMPTY_WORKER_TOTALS: SiteAnalyticsPoint = {
  date: "",
  requests: 0,
  errors: 0,
  subrequests: 0,
}
const EMPTY_WEB_TOTALS: SiteWebPoint = {
  date: "",
  requests: 0,
  pageViews: 0,
  bytes: 0,
  uniques: 0,
}

/** `dimensions.date`, `dimensions.datetimeHour`, or a bare `date`. */
function pointDate(group: Record<string, unknown>): string | undefined {
  const dimensions = asRecord(group.dimensions) ?? {}
  return (
    asString(dimensions.date) ??
    asString(dimensions.datetimeHour) ??
    asString(dimensions.datetime) ??
    asString(group.date)
  )
}

/**
 * GraphQL nesting, or an already-unwrapped array.
 *
 * `undefined` means "no envelope of this shape"; `[]` means "the envelope was
 * there and the window is empty". A Site with no traffic yet has a valid empty
 * answer and must not read as an unrecognized payload.
 */
function graphqlGroups(
  value: unknown,
  scope: "accounts" | "zones",
  field: string
): unknown[] | undefined {
  const direct = asArray(value)
  if (direct) return direct
  const root = asRecord(value)
  if (!root) return undefined
  const viewer = asRecord(asRecord(root.data)?.viewer) ?? asRecord(root.viewer)
  const container = asArray(viewer?.[scope])?.[0]
  return asArray(asRecord(container)?.[field])
}

function graphqlErrors(value: unknown): string[] {
  const root = asRecord(value)
  const errors = asArray(root?.errors) ?? []
  return errors.flatMap((entry) => {
    const message = asString(asRecord(entry)?.message)
    return message ? [message] : []
  })
}

export function parseSiteWorkerAnalytics(value: unknown): SiteAnalyticsView {
  // `queryWorkerAnalytics` returns the bare worker payload when it has no zone
  // and hostname, and `[worker, zone]` when it has both.
  const pair = asArray(value)
  const workerPayload = pair ? pair[0] : value
  const webPayload = pair ? pair[1] : undefined

  const workerGroups = graphqlGroups(workerPayload, "accounts", "workersInvocationsAdaptive")
  const points: SiteAnalyticsPoint[] = []
  for (const group of workerGroups ?? []) {
    const record = asRecord(group)
    if (!record) continue
    const date = pointDate(record)
    if (!date) continue
    const sum = asRecord(record.sum) ?? {}
    points.push({
      date,
      requests: asNumber(sum.requests) ?? 0,
      errors: asNumber(sum.errors) ?? 0,
      subrequests: asNumber(sum.subrequests) ?? 0,
    })
  }
  points.sort((left, right) => left.date.localeCompare(right.date))

  const totals = points.reduce<SiteAnalyticsPoint>(
    (acc, point) => ({
      date: "",
      requests: acc.requests + point.requests,
      errors: acc.errors + point.errors,
      subrequests: acc.subrequests + point.subrequests,
    }),
    EMPTY_WORKER_TOTALS
  )

  const providerErrors = [...graphqlErrors(workerPayload), ...graphqlErrors(webPayload)]
  const view: SiteAnalyticsView = {
    worker: { points, totals },
    providerErrors,
    // Only unrecognizable when there is nothing at all to show and the provider
    // did not explain why.
    unrecognized: workerGroups === undefined && providerErrors.length === 0,
  }

  if (webPayload === undefined) return view

  const webGroups = graphqlGroups(webPayload, "zones", "httpRequestsAdaptiveGroups") ?? []
  const webPoints: SiteWebPoint[] = []
  for (const group of webGroups) {
    const record = asRecord(group)
    if (!record) continue
    const date = pointDate(record)
    if (!date) continue
    const sum = asRecord(record.sum) ?? {}
    const uniq = asRecord(record.uniq) ?? {}
    webPoints.push({
      date,
      requests: asNumber(sum.requests) ?? 0,
      pageViews: asNumber(sum.pageViews) ?? 0,
      bytes: asNumber(sum.bytes) ?? 0,
      uniques: asNumber(uniq.uniques) ?? 0,
    })
  }
  webPoints.sort((left, right) => left.date.localeCompare(right.date))
  if (webPoints.length === 0) return view

  return {
    ...view,
    web: {
      points: webPoints,
      totals: webPoints.reduce<SiteWebPoint>(
        (acc, point) => ({
          date: "",
          requests: acc.requests + point.requests,
          pageViews: acc.pageViews + point.pageViews,
          bytes: acc.bytes + point.bytes,
          uniques: acc.uniques + point.uniques,
        }),
        EMPTY_WEB_TOTALS
      ),
    },
  }
}
