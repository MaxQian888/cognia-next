/**
 * Router + Fusion call-ledger gate for the sidecar (ADR-0188).
 *
 * Engaged ONLY when `sendOptions.ledger` is present — the renderer stamps it
 * when the user switched Router + Fusion on for the surface and the turn was
 * routed through it. Without the stamp every function here reports "inactive"
 * and the dispatchers run exactly as before.
 *
 * With the stamp, no billable model call leaves the sidecar without a
 * reservation: before each call the dispatcher asks the renderer (the ledger's
 * only writer) with `call_reserve_request` and waits for `call_reserve_decision`.
 * After the call it reports what happened with `call_attempt_result`, carrying
 * the provider's usage exactly as reported plus the semantics of that report,
 * so the renderer can price it without double counting.
 *
 * Three answers:
 *  - granted: send; the attempt is already durably DISPATCHED on the renderer.
 *  - refused: a budget / limit / deadline refusal. The turn stops and says why.
 *  - bypass:  the ledger itself is unavailable. Ordinary traffic continues on the
 *    original, unledgered path (ADR-0188 D38) and the renderer shows a notice.
 *
 * A renderer that never answers (reloaded window, stalled database) is a bypass
 * after `timeoutMs`, reported with `ledger_bypassed`, never a hang.
 */

import { randomUUID } from "node:crypto"

import { extractHttpErrorMeta } from "./http-error-meta.mjs"

export const CALL_RESERVE_TIMEOUT_MS = 30_000

/** Usage semantics of the AI SDK's normalized `LanguageModelUsage` (v6/v7): totals are inclusive. */
export const AI_SDK_USAGE_SEMANTICS = Object.freeze({
  inputIncludesCacheRead: true,
  inputIncludesCacheWrite: true,
  outputIncludesReasoning: true,
})

/**
 * @param {unknown} ledger
 * @returns {ledger is { runId: string, mode: "per_call" | "envelope", transportAttempts: number, deploymentId: string, envelopeMaxBudgetUsd?: number }}
 */
export function isLedgerStamp(ledger) {
  return (
    !!ledger &&
    typeof ledger === "object" &&
    typeof ledger.runId === "string" &&
    ledger.runId.length > 0 &&
    (ledger.mode === "per_call" || ledger.mode === "envelope")
  )
}

function firstNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value
  }
  return undefined
}

/**
 * Raw usage for the ledger from an AI SDK leg usage object. Only what the
 * provider reported; a field it did not report is omitted, never invented.
 *
 * @returns {{ inputTokens: number, outputTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number, reasoningTokens?: number } | null}
 */
export function rawUsageFromAiSdk(usage) {
  if (!usage || typeof usage !== "object") return null
  const input = firstNumber(usage.inputTokens?.total, usage.inputTokens, usage.promptTokens)
  const output = firstNumber(usage.outputTokens?.total, usage.outputTokens, usage.completionTokens)
  if (input === undefined && output === undefined) return null
  const cacheRead = firstNumber(
    usage.inputTokens?.cacheRead,
    usage.inputTokenDetails?.cacheReadTokens,
    usage.cachedInputTokens
  )
  const cacheWrite = firstNumber(
    usage.inputTokens?.cacheWrite,
    usage.inputTokenDetails?.cacheWriteTokens,
    usage.cacheCreationInputTokens
  )
  const reasoning = firstNumber(
    usage.outputTokens?.reasoning,
    usage.outputTokenDetails?.reasoningTokens,
    usage.reasoningTokens
  )
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  }
}

/**
 * Classify a failed call the way the ledger needs it. The distinction that
 * matters: did the provider explicitly refuse BEFORE producing anything
 * (retryable, nothing billable), or was the request sent with no answer
 * (UNKNOWN — never retried, never assumed free)?
 *
 * @returns {"rate_limited" | "server_error" | "not_sent" | "timeout_after_send" | "refusal" | "invalid_request" | "auth" | "cancelled"}
 */
export function classifyCallError(error, { aborted = false } = {}) {
  if (aborted) return "cancelled"
  const { httpStatus } = extractHttpErrorMeta(error)
  if (httpStatus === 429 || httpStatus === 529) return "rate_limited"
  if (httpStatus === 401 || httpStatus === 403) return "auth"
  if (typeof httpStatus === "number" && httpStatus >= 500) return "server_error"
  if (typeof httpStatus === "number" && httpStatus >= 400) return "invalid_request"
  const code =
    typeof error?.code === "string"
      ? error.code
      : typeof error?.cause?.code === "string"
        ? error.cause.code
        : ""
  if (/^(ENOTFOUND|ECONNREFUSED|EAI_AGAIN|CERT_|ERR_TLS|UND_ERR_CONNECT)/.test(code))
    return "not_sent"
  const name = typeof error?.name === "string" ? error.name : ""
  if (name === "AbortError") return "cancelled"
  // AI SDK configuration errors are raised before any request is built.
  if (CONFIGURATION_ERRORS.has(name)) return "not_sent"
  return "timeout_after_send"
}

const CONFIGURATION_ERRORS = new Set([
  "AI_LoadAPIKeyError",
  "AI_LoadSettingError",
  "AI_InvalidArgumentError",
  "AI_NoSuchModelError",
  "AI_NoSuchProviderError",
  "AI_UnsupportedFunctionalityError",
  "AI_InvalidPromptError",
])

/**
 * Errors safe to retry as a NEW attempt while the call produced no output.
 * `timeout_after_send` joined the retryable set when the stream watchdog
 * landed (it is also what a socket hangup mid-request classifies as): the
 * provider produced nothing we saw, so one more attempt is worth it. The
 * ledger still books the interrupted attempt UNKNOWN — retried, never free.
 */
export function isRetryableBeforeOutput(errorClass) {
  return (
    errorClass === "rate_limited" ||
    errorClass === "server_error" ||
    errorClass === "not_sent" ||
    errorClass === "timeout_after_send"
  )
}

/**
 * Errors that prove the provider refused BEFORE doing billable work — every
 * retryable class except `timeout_after_send` (which may have been sent and
 * charged) plus explicit rejections (`auth`, `invalid_request`). Bookkeeping
 * uses this, not the retry predicate: a retried timeout is still UNKNOWN.
 */
export function isDefinitiveRefusal(errorClass) {
  return (
    errorClass === "rate_limited" ||
    errorClass === "server_error" ||
    errorClass === "not_sent" ||
    errorClass === "auth" ||
    errorClass === "invalid_request"
  )
}

/** Conservative prompt size for the reservation: one token per three characters. */
export function estimatePromptTokens(parts) {
  let chars = 0
  for (const part of parts) {
    if (part === undefined || part === null) continue
    chars += typeof part === "string" ? part.length : JSON.stringify(part).length
  }
  return Math.ceil(chars / 3)
}

/**
 * @param {{
 *   ledger: unknown,
 *   sessionId: string,
 *   emit: (event: Record<string, unknown>) => void,
 *   log?: (level: string, message: string) => void,
 *   timeoutMs?: number,
 *   newId?: () => string,
 * }} options
 */
export function createCallLedgerGate(options) {
  const { sessionId, emit } = options
  const log = options.log ?? (() => {})
  const timeoutMs = options.timeoutMs ?? CALL_RESERVE_TIMEOUT_MS
  const newId = options.newId ?? randomUUID
  const stamp = isLedgerStamp(options.ledger) ? options.ledger : null
  /** @type {Map<string, { resolve: (decision: any) => void, timer: ReturnType<typeof setTimeout> }>} */
  const pending = new Map()
  let bypassed = false

  function bypass(reason) {
    if (bypassed) return
    bypassed = true
    emit({ type: "ledger_bypassed", sessionId, runId: stamp?.runId, reason })
    log("warn", `[router-fusion] ledger bypassed for ${stamp?.runId}: ${reason}`)
  }

  return {
    /** True while calls must be reserved: a stamp is present and no bypass happened. */
    get active() {
      return stamp !== null && !bypassed
    },
    /** The stamp, even after a bypass (the dispatcher still knows the turn was routed). */
    get stamp() {
      return stamp
    },
    get transportAttempts() {
      return Math.max(1, Math.floor(stamp?.transportAttempts ?? 1))
    },

    /**
     * Ask for a reservation. Never throws; a gate without a stamp grants
     * immediately so callers can use one code path.
     *
     * `deploymentId` names a different deployment than the turn's (a compaction
     * summary on its own model); it defaults to the stamp's.
     *
     * @param {{ kind: "call" | "envelope_check", logicalStepId: string, deploymentId?: string, estimatedInputTokens?: number, maxOutputTokens?: number | null, toolName?: string }} request
     * @returns {Promise<{ decision: "granted", attemptId?: string, attemptNo?: number } | { decision: "refused", code: string, message?: string } | { decision: "bypass", reason: string }>}
     */
    reserve(request) {
      if (!stamp || bypassed) return Promise.resolve({ decision: "bypass", reason: "inactive" })
      const requestId = newId()
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (!pending.has(requestId)) return
          pending.delete(requestId)
          bypass("renderer_unanswered")
          resolve({ decision: "bypass", reason: "renderer_unanswered" })
        }, timeoutMs)
        pending.set(requestId, { resolve, timer })
        emit({
          type: "call_reserve_request",
          sessionId,
          runId: stamp.runId,
          requestId,
          kind: request.kind,
          logicalStepId: request.logicalStepId,
          deploymentId: request.deploymentId ?? stamp.deploymentId,
          ...(request.estimatedInputTokens !== undefined
            ? { estimatedInputTokens: request.estimatedInputTokens }
            : {}),
          ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
          ...(request.toolName ? { toolName: request.toolName } : {}),
        })
      })
    },

    /** Resolve a pending reservation from the renderer's `call_reserve_decision`. */
    resolveDecision(message) {
      const entry = pending.get(message?.requestId)
      if (!entry) return false
      pending.delete(message.requestId)
      clearTimeout(entry.timer)
      if (message.decision === "granted") {
        entry.resolve({
          decision: "granted",
          ...(typeof message.attemptId === "string" ? { attemptId: message.attemptId } : {}),
          ...(typeof message.attemptNo === "number" ? { attemptNo: message.attemptNo } : {}),
        })
      } else if (message.decision === "refused") {
        entry.resolve({
          decision: "refused",
          code: typeof message.code === "string" ? message.code : "REFUSED",
          ...(typeof message.message === "string" ? { message: message.message } : {}),
        })
      } else {
        const reason = typeof message.code === "string" ? message.code : "renderer_bypass"
        bypass(reason)
        entry.resolve({ decision: "bypass", reason })
      }
      return true
    },

    /**
     * Report the outcome of a granted call. `status: "unknown"` means the call
     * was sent and no answer (and no bill) arrived.
     */
    report(result) {
      if (!stamp || !result?.attemptId) return
      emit({
        type: "call_attempt_result",
        sessionId,
        runId: stamp.runId,
        attemptId: result.attemptId,
        logicalStepId: result.logicalStepId,
        status: result.status,
        ...(result.usage
          ? { usage: result.usage, semantics: result.semantics ?? AI_SDK_USAGE_SEMANTICS }
          : {}),
        providerRequestId: result.providerRequestId ?? null,
        ...(result.finishReason ? { finishReason: result.finishReason } : {}),
        ...(result.errorClass ? { errorClass: result.errorClass } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
      })
    },

    /** Teardown: nothing may wait on a reservation that can no longer be answered. */
    drain(reason = "session_closed") {
      for (const [requestId, entry] of pending) {
        pending.delete(requestId)
        clearTimeout(entry.timer)
        entry.resolve({ decision: "refused", code: "SESSION_CLOSED", message: reason })
      }
    },
  }
}

/**
 * One model call outside the turn's leg loop (a compaction summary, an optical
 * transcription) under the same ledger. Without an active gate — or after a
 * bypass — `send` runs exactly as before. A refusal sends nothing and returns
 * `{ sent: false }`; the caller treats it like a failed side call. The call is
 * a single transport attempt: a side call is never retried.
 *
 * `send` returns `{ value, usage?, providerRequestId? }` where `usage` is the AI
 * SDK usage object of the call.
 *
 * @template T
 * @param {ReturnType<typeof createCallLedgerGate> | null | undefined} gate
 * @param {{ logicalStepId: string, deploymentId?: string, estimatedInputTokens?: number, maxOutputTokens?: number | null }} request
 * @param {() => Promise<{ value: T, usage?: unknown, providerRequestId?: string | null }>} send
 * @param {{ isCancelled?: () => boolean }} [options]
 * @returns {Promise<{ sent: true, value: T } | { sent: false, refusal: { code: string, message?: string } }>}
 */
export async function runLedgeredSideCall(gate, request, send, options = {}) {
  if (!gate?.active) return { sent: true, value: (await send()).value }
  const reservation = await gate.reserve({ kind: "call", ...request })
  if (reservation.decision === "refused") {
    return {
      sent: false,
      refusal: {
        code: reservation.code,
        ...(reservation.message ? { message: reservation.message } : {}),
      },
    }
  }
  if (reservation.decision !== "granted" || !reservation.attemptId) {
    return { sent: true, value: (await send()).value }
  }
  const attempt = {
    attemptId: reservation.attemptId,
    attemptNo: reservation.attemptNo ?? 1,
    logicalStepId: request.logicalStepId,
  }
  let outcome
  try {
    outcome = await send()
  } catch (error) {
    const errorClass = classifyCallError(error, { aborted: options.isCancelled?.() === true })
    gate.report({
      ...attempt,
      // Refused before processing: failed, nothing billed. Anything else was
      // sent and never answered: UNKNOWN, never free.
      status: isDefinitiveRefusal(errorClass) ? "failed" : "unknown",
      errorClass,
      reason: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
  const usage = rawUsageFromAiSdk(outcome.usage)
  if (outcome.error) {
    const errorClass = classifyCallError(outcome.error, {
      aborted: options.isCancelled?.() === true,
    })
    const refusedBeforeProcessing = isDefinitiveRefusal(errorClass)
    gate.report({
      ...attempt,
      status: usage || refusedBeforeProcessing ? "failed" : "unknown",
      ...(usage ? { usage } : {}),
      errorClass,
      reason: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
      providerRequestId: null,
    })
    return { sent: true, value: outcome.value }
  }
  gate.report({
    ...attempt,
    status: usage ? "succeeded" : "unknown",
    ...(usage ? { usage } : { reason: "side_call_without_usage" }),
    providerRequestId: outcome.providerRequestId ?? null,
  })
  return { sent: true, value: outcome.value }
}

/**
 * Collect a one-shot call's text. With `withBilling` it also reads the call's
 * usage, response id and streamed error for the ledger; without it the stream
 * is read exactly as the unledgered path always did (text deltas only).
 *
 * @param {{ fullStream: AsyncIterable<any>, usage?: unknown, response?: unknown }} run
 * @param {{ withBilling?: boolean }} [options]
 */
export async function drainSideCallStream(run, { withBilling = false } = {}) {
  let text = ""
  let error = null
  for await (const evt of run.fullStream) {
    if (evt?.type === "text-delta") text += evt.text ?? evt.textDelta ?? evt.delta ?? ""
    else if (evt?.type === "error") error = evt.error
  }
  if (!withBilling) return { value: text }
  // Each AI SDK result getter returns a fresh promise that rejects on a failed
  // call: read each exactly once, inside the try.
  let usage = null
  try {
    usage = await run.usage
  } catch {
    usage = null
  }
  let providerRequestId = null
  if (!error) {
    try {
      providerRequestId = (await run.response)?.id ?? null
    } catch {
      providerRequestId = null
    }
  }
  return { value: text, usage, providerRequestId, ...(error ? { error } : {}) }
}

/**
 * Envelope mode (the Claude Agent SDK loops internally, so calls cannot be
 * reserved one by one): before every tool use the renderer checks that the run
 * may still continue — not frozen, under its call limit, before its deadline,
 * with budget left. A refusal denies the tool and stops the query, so the SDK
 * makes no further model calls on this run.
 *
 * @param {{ gate: ReturnType<typeof createCallLedgerGate>, onRefused: (refusal: { code: string, message?: string }) => void }} options
 */
export function buildLedgerToolHooks({ gate, onRefused }) {
  if (!gate.active) return undefined
  let checks = 0
  return {
    PreToolUse: [
      {
        hooks: [
          async (input) => {
            if (!gate.active) return {}
            checks += 1
            const outcome = await gate.reserve({
              kind: "envelope_check",
              logicalStepId: `tool:${checks}`,
              ...(typeof input?.tool_name === "string" ? { toolName: input.tool_name } : {}),
            })
            if (outcome.decision !== "refused") return {}
            onRefused(outcome)
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: `Router + Fusion stopped this run: ${outcome.code}`,
              },
            }
          },
        ],
      },
    ],
  }
}

/** The sidecar's `session_ended` payload for a refused turn: explicit, never silent. */
export function refusalSessionEnded(sessionId, refusal) {
  return {
    type: "session_ended",
    sessionId,
    error: `Router + Fusion refused the call: ${refusal.code}${refusal.message ? ` — ${refusal.message}` : ""}`,
    routerFusionRefusal: {
      code: refusal.code,
      ...(refusal.message ? { message: refusal.message } : {}),
    },
  }
}
