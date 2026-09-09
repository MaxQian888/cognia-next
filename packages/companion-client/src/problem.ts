/**
 * The one failure document a Cognia Host answers with (ADR-0175).
 *
 * Every non-2xx from `/api/*` and `/internal/*` is an RFC 9457 problem
 * document with five companion extensions, declared as
 * `application/problem+json`. Frames on the socket planes carry the same
 * document as their `error` member.
 *
 * Hosts older than ADR-0175 answered with one of three other shapes: the
 * nested `{ error: { code, message, … } }` of the device plane, the flat
 * `{ code, message, … }` of the internal plane, and `{ error: "code" }` on a
 * few listeners. `parseProblem` reads all of them, so a client compiled
 * against this contract still classifies a refusal from an older Host
 * instead of falling back to the HTTP status.
 */

export const PROBLEM_CONTENT_TYPE = "application/problem+json"

/** The namespace every `type` URI lives under: `TYPE_BASE + code`. */
export const PROBLEM_TYPE_BASE = "https://cognia.dev/problems/"

export interface Problem {
  /** `https://cognia.dev/problems/<code>`. An identifier, not a page. */
  type: string
  /** The HTTP reason phrase. Human-facing, never branched on. */
  title: string
  /** The HTTP status this document was answered with. */
  status: number
  /** Human-readable explanation of this occurrence. */
  detail: string
  /** The request path this occurrence belongs to, when the Host knew it. */
  instance?: string
  /** Stable snake_case code a client branches on. */
  code: string
  /** Equals the `x-request-id` response header. */
  requestId: string
  /** Whether repeating the identical request can succeed. */
  retryable: boolean
  /** Machine-readable extras (`replacement`, `retryAfterSeconds`, `violations`). */
  details: Record<string, unknown>
  /** Present when the failure belongs to a long-running operation. */
  operationId?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** True for a document the Host wrote under this contract. */
export function isProblem(value: unknown): value is Problem {
  if (!isRecord(value)) return false
  return (
    typeof value.type === "string" &&
    typeof value.status === "number" &&
    typeof value.detail === "string" &&
    typeof value.code === "string" &&
    typeof value.requestId === "string" &&
    typeof value.retryable === "boolean"
  )
}

/**
 * Read a problem out of a response body. Accepts the RFC document, then the
 * legacy nested and flat envelopes, then `{ error: "code" }`. Returns `null`
 * when the body carries no code at all, which is the caller's cue to fall
 * back to the HTTP status.
 *
 * `fallbackStatus` fills `status` for the legacy shapes, which never carried
 * one, and `retryable` for those that did not say.
 */
export function parseProblem(body: unknown, fallbackStatus = 0): Problem | null {
  if (!isRecord(body)) return null
  if (isProblem(body)) {
    return {
      ...body,
      details: isRecord(body.details) ? body.details : {},
    }
  }
  const nested = isRecord(body.error) ? body.error : null
  const candidate = nested ?? body
  const code =
    typeof candidate.code === "string"
      ? candidate.code
      : typeof body.error === "string"
        ? body.error
        : null
  if (code === null || code.length === 0) return null
  const status =
    typeof candidate.status === "number" && Number.isFinite(candidate.status)
      ? candidate.status
      : fallbackStatus
  const detail =
    typeof candidate.detail === "string"
      ? candidate.detail
      : typeof candidate.message === "string"
        ? candidate.message
        : typeof body.message === "string"
          ? body.message
          : ""
  return {
    type: typeof candidate.type === "string" ? candidate.type : `${PROBLEM_TYPE_BASE}${code}`,
    title: typeof candidate.title === "string" ? candidate.title : "",
    status,
    detail,
    ...(typeof candidate.instance === "string" ? { instance: candidate.instance } : {}),
    code,
    requestId: typeof candidate.requestId === "string" ? candidate.requestId : "",
    retryable: typeof candidate.retryable === "boolean" ? candidate.retryable : status >= 500,
    details: isRecord(candidate.details) ? candidate.details : {},
    ...(typeof candidate.operationId === "string" ? { operationId: candidate.operationId } : {}),
  }
}

/** The wait the Host quantified, in milliseconds, when it did. */
export function problemRetryAfterMs(problem: Pick<Problem, "details">): number | null {
  const seconds = problem.details.retryAfterSeconds
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1000
    : null
}
