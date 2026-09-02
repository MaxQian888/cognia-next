/**
 * Turn whatever a handler threw into the shared `ProviderDiagnosticFailure`
 * (14 codes, `@cognia/provider-types`). No third status table: HTTP statuses
 * go through the diagnostics probe's `failureForStatus`, and message-only
 * errors go through `@cognia/error-parsers`' API status parser, whose
 * categories map onto the same codes here.
 */

import { apiStatusErrorParser } from "@cognia/error-parsers"
import type {
  ProviderDiagnosticFailure,
  ProviderOperationAvailability,
} from "@cognia/provider-types"

import { failureForStatus, transportFailure } from "@/lib/provider-diagnostics/probe"

/** Thrown by a handler or the executor when outbound text fails the PII gate. */
export class ProviderOperationPiiGateError extends Error {
  readonly code = "pii-gate" as const
  constructor(message = "outbound text did not pass the PII gate") {
    super(message)
    this.name = "ProviderOperationPiiGateError"
  }
}

/** Thrown by a handler to surface a typed failure without an HTTP status. */
export class ProviderOperationFailureError extends Error {
  constructor(readonly failure: ProviderDiagnosticFailure) {
    super(failure.message)
    this.name = "ProviderOperationFailureError"
  }
}

const CATEGORY_TO_CODE: Record<string, ProviderDiagnosticFailure["code"]> = {
  invalidRequest: "schema",
  unauthorized: "authentication",
  forbidden: "permission",
  notFound: "capability-unsupported",
  payloadTooLarge: "schema",
  rateLimited: "rate-limited",
  quotaExceeded: "quota",
  serverError: "transport",
  serviceUnavailable: "transport",
  modelOverloaded: "transport",
}

const RETRYABLE: ReadonlySet<ProviderDiagnosticFailure["code"]> = new Set([
  "rate-limited",
  "transport",
  "network",
  "timeout",
])

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined
  const record = error as Record<string, unknown>
  for (const key of ["statusCode", "status", "httpStatus"]) {
    const value = record[key]
    if (typeof value === "number" && value >= 100 && value <= 599) return value
  }
  const response = record.response
  if (response && typeof response === "object") {
    const status = (response as Record<string, unknown>).status
    if (typeof status === "number") return status
  }
  return undefined
}

function retryAfterMsOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined
  const headers = (error as { responseHeaders?: Record<string, string> }).responseHeaders
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"]
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000)
  const date = Date.parse(raw)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}

/** Redact anything that looks like a bearer or key before it reaches a log. */
function redactMessage(message: string): string {
  return message
    .replace(/(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, "$1…")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1…")
    .slice(0, 500)
}

export function toProviderDiagnosticFailure(error: unknown): ProviderDiagnosticFailure {
  if (error instanceof ProviderOperationFailureError) return error.failure
  if (error instanceof ProviderOperationPiiGateError) {
    return { code: "permission", retryable: false, message: error.message }
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return { code: "aborted", retryable: false, message: "operation aborted" }
  }
  const message = redactMessage(error instanceof Error ? error.message : String(error))

  const status = statusOf(error)
  if (status !== undefined) {
    const base =
      status === 402
        ? { ...failureForStatus(status), code: "quota" as const }
        : failureForStatus(status)
    const retryAfterMs = retryAfterMsOf(error)
    return {
      ...base,
      message: message || base.message,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    }
  }

  const parsed = apiStatusErrorParser.parse(message)
  const categoryNode = parsed?.nodes.find(
    (node): node is typeof node & { category: string } =>
      typeof (node as { category?: unknown }).category === "string"
  )
  if (categoryNode) {
    const code = CATEGORY_TO_CODE[categoryNode.category] ?? "unknown"
    return { code, retryable: RETRYABLE.has(code), message }
  }

  if (error instanceof Error && /abort|timeout|ECONN|ENOTFOUND|fetch failed/i.test(message)) {
    return { ...transportFailure(error), message }
  }
  return { code: "unknown", retryable: false, message: message || "unknown provider failure" }
}

/** What a caller can do about a failure, in the operation contract's words. */
export function availabilityForFailure(
  failure: ProviderDiagnosticFailure
): ProviderOperationAvailability {
  switch (failure.code) {
    case "authentication":
      return "needs-auth"
    case "capability-unsupported":
    case "schema":
      return "unavailable"
    default:
      return failure.retryable ? "ready" : "unavailable"
  }
}
