/**
 * External Bridge — the model-facing result vocabulary (roadmap 2026-09-29,
 * Phase 1).
 *
 * Every MCP tool answers in the `{ content, structuredContent, isError }`
 * envelope `runWithGate` builds. This module fixes what `structuredContent`
 * may say beyond a tool's own payload, so an external agent can act on a
 * result without parsing prose:
 *
 *  - **Pending / continuation.** A tool that started work it could not finish
 *    inside its wait budget answers `executionState: "pending"` plus the exact
 *    call that picks the work up again. The model follows the continuation;
 *    it never guesses a polling tool or its arguments.
 *  - **Decision-complete failure.** A failure carries the existing `code`
 *    (a stable reason code), the stage that refused it, whether anything
 *    changed, and at most one follow-up whose `mechanicallyFollowable` flag
 *    says whether the model may issue it verbatim or must decide first.
 *  - **Turn economy.** An out-of-range ergonomic input (a byte budget, a wait,
 *    a page size) is clamped instead of refused, and the value actually used
 *    is reported under `adjusted`. Identity and authority inputs (a root id, a
 *    job id, a path) are never clamped: they fail closed.
 *
 * Success stays sparse: nothing here echoes the arguments back.
 */

/** Where a call was refused or broke. */
export type FailureStage =
  /** Arguments were malformed or named something that does not exist. */
  | "validation"
  /** A scope, grant, or path policy refused the call before any work. */
  | "authorization"
  /** The user declined (or did not answer) an in-app approval. */
  | "consent"
  /** The host ran the call and it failed. */
  | "execution"

/** The one next step a failure recommends. */
export interface FollowUp {
  tool: string
  arguments: Record<string, unknown>
  /**
   * `true` when the model may issue this call verbatim; `false` when it names
   * the right tool but the model (or the user) has to decide something first.
   */
  mechanicallyFollowable: boolean
  why: string
}

export type ToolFailure = {
  ok: false
  /** Stable reason code — the existing `code` convention of every handler. */
  code: string
  error: string
  failureStage: FailureStage
  /**
   * Whether the call changed state before failing. `false` for every refusal
   * that happens before work starts.
   */
  stateChanged: boolean
  /**
   * Present (and `true`) only when the host cannot tell whether the call took
   * effect — a handler that threw mid-flight. The model must re-read state
   * before retrying anything that is not idempotent.
   */
  outcomeUnknown?: true
  followUp?: FollowUp
}

/** The call that resumes pending work. */
export interface Continuation {
  tool: string
  arguments: Record<string, unknown>
}

export interface PendingMarker {
  executionState: "pending"
  continuation: Continuation
}

/** A clamped input: what was asked for and what was used. */
export interface Adjustment {
  requested: number
  effective: number
}

export type Adjustments = Record<string, Adjustment>

export interface FailureOptions {
  stateChanged?: boolean
  outcomeUnknown?: boolean
  followUp?: FollowUp
}

export function toolFailure(
  code: string,
  failureStage: FailureStage,
  error: string,
  options: FailureOptions = {}
): ToolFailure {
  return {
    ok: false,
    code,
    error,
    failureStage,
    stateChanged: options.stateChanged === true,
    ...(options.outcomeUnknown ? { outcomeUnknown: true as const } : {}),
    ...(options.followUp ? { followUp: options.followUp } : {}),
  }
}

export function pendingMarker(tool: string, args: Record<string, unknown>): PendingMarker {
  return { executionState: "pending", continuation: { tool, arguments: args } }
}

export function isToolFailure(value: unknown): value is ToolFailure {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return (
    record.ok === false &&
    typeof record.code === "string" &&
    typeof record.failureStage === "string"
  )
}

export interface ClampSpec {
  min: number
  max: number
  fallback: number
}

/**
 * Clamp one ergonomic numeric input. A missing or non-finite value takes the
 * fallback silently (the caller asked for nothing in particular); a value
 * outside `[min, max]` is pulled in and recorded in `adjusted`.
 */
export function clampInput(
  name: string,
  raw: unknown,
  spec: ClampSpec,
  adjusted: Adjustments
): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return spec.fallback
  const whole = Math.trunc(raw)
  const effective = Math.min(spec.max, Math.max(spec.min, whole))
  if (effective !== raw) adjusted[name] = { requested: raw, effective }
  return effective
}

/** `{ adjusted }` when anything was clamped, otherwise nothing (sparse). */
export function adjustedField(adjusted: Adjustments): { adjusted?: Adjustments } {
  return Object.keys(adjusted).length > 0 ? { adjusted } : {}
}

/**
 * The failure `runWithGate` reports for a scope denial. Decision-complete: it
 * names the setting that would allow the call, and marks the follow-up as not
 * mechanically followable, because only the user can grant a scope.
 */
export function scopeDenied(reason: string): ToolFailure {
  return toolFailure("scope_denied", "authorization", reason)
}

/**
 * The failure `runWithGate` reports when an allowed handler threw. The host
 * cannot know how far the handler got, so the outcome is unknown.
 */
export function handlerFailed(message: string): ToolFailure {
  return toolFailure("handler_error", "execution", message, { outcomeUnknown: true })
}
