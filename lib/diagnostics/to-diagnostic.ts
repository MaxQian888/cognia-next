/**
 * The one place that decides which classifier applies to an unknown throw.
 *
 * Every producer calls `toDiagnostic(err, ctx)`. Adding a new failure kind means
 * adding a branch here — not a seventh taxonomy, and not another regex at a
 * render site.
 *
 * The order is **structure first, text last**, and that ordering is the whole
 * point. Text matching is a last resort because it is locale-dependent and
 * lossy: `/api[\s_-]?key/i` on an English message is how the chat card used to
 * decide whether to offer an "Open settings" button, which meant the button
 * simply never appeared for a provider that answered in another language. Any
 * typed error, envelope or structured event that reaches this function is
 * classified without looking at prose at all.
 */

import { createDiagnostic, isDiagnosticCode } from "@cognia/diagnostics"
import type { CogniaDiagnostic, DiagnosticMeta, DiagnosticSource } from "@cognia/diagnostics"
import { diagnoseParsedError } from "@cognia/diagnostics/adapters/from-parsed-error"
import { diagnoseProviderError } from "@cognia/diagnostics/adapters/from-provider-error-class"

import { normalizeErrorText, resolvePreset } from "@cognia/error-parsers"
import { classifyProviderErrorInfo } from "@cognia/provider-routing/error-classifier"
import { CommandInvokeError, isCommandErrorEnvelope } from "@/lib/tauri/command-error"

import { diagnoseCommandError } from "./adapters/from-command-error"
import { diagnoseDispatchEnvelope } from "./adapters/from-dispatch-envelope"
import { diagnoseExecutionError } from "./adapters/from-execution-error"

export interface ToDiagnosticContext {
  source: DiagnosticSource
  /** Merged into the resulting diagnostic's `meta`. */
  meta?: DiagnosticMeta
  /** Selects a tool-specific parser preset (e.g. `tool-Bash`). */
  toolType?: string
  /** Test seams — same convention as `createDiagnostic`. */
  now?: () => number
  id?: string
}

/** Already a diagnostic? Pass it through, merging any extra context. */
function isDiagnostic(value: unknown): value is CogniaDiagnostic {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.code === "string" &&
    typeof v.severity === "string" &&
    typeof v.source === "string" &&
    Array.isArray(v.actions)
  )
}

/** Duck-type for `PluginDispatchErrorEnvelope`. */
function isDispatchEnvelope(
  value: unknown
): value is Parameters<typeof diagnoseDispatchEnvelope>[0] {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.code === "string" && typeof v.message === "string" && typeof v.retryable === "boolean"
  )
}

function stackOf(err: unknown): string | undefined {
  return err instanceof Error && err.stack ? err.stack : undefined
}

/**
 * Concise raw text for `message`.
 *
 * `normalizeErrorText` deliberately returns an Error's full *stack* so the
 * stack-trace parser can surface clickable frames — correct as classifier
 * input, wrong as the stored message: `message` is mirrored onto the store's
 * legacy `errorMessage`, which `use-session-notifications` puts in an OS
 * notification body. A stack dump does not belong there. The stack still
 * reaches the UI via `detail`.
 */
function conciseMessage(err: unknown, normalized: string): string {
  return err instanceof Error ? err.message || normalized : normalized
}

export function toDiagnostic(err: unknown, ctx: ToDiagnosticContext): CogniaDiagnostic {
  const { source, meta: ctxMeta, toolType, now, id } = ctx
  const mergeMeta = (meta?: DiagnosticMeta): DiagnosticMeta | undefined => {
    const merged = { ...(ctxMeta ?? {}), ...(meta ?? {}) }
    return Object.keys(merged).length > 0 ? merged : undefined
  }

  // 1 — already classified upstream.
  if (isDiagnostic(err)) {
    const merged = mergeMeta(err.meta)
    return merged ? { ...err, meta: merged } : err
  }

  // 2 — typed errors from the execution layer.
  const execution = diagnoseExecutionError(err)
  if (execution) {
    return createDiagnostic(execution.code, {
      source,
      message: execution.message,
      meta: mergeMeta(execution.meta),
      detail: stackOf(err),
      now,
      id,
    })
  }

  // 3 — a Tauri command rejection that was already decoded and re-thrown.
  if (err instanceof CommandInvokeError) {
    const decoded = diagnoseCommandError(err)
    return createDiagnostic(decoded.code, {
      source,
      message: decoded.message,
      retryable: decoded.retryable,
      meta: mergeMeta(),
      detail: stackOf(err),
      now,
      id,
    })
  }

  // 4 — raw structured envelopes. Dispatch is checked first: its shape is a
  // superset of the command envelope's, so the looser test would swallow it.
  if (isDispatchEnvelope(err)) {
    const decoded = diagnoseDispatchEnvelope(err)
    return createDiagnostic(decoded.code, {
      source,
      message: decoded.message,
      retryable: decoded.retryable,
      meta: mergeMeta(decoded.meta),
      now,
      id,
    })
  }
  if (isCommandErrorEnvelope(err)) {
    const decoded = diagnoseCommandError({
      code: err.code,
      message: err.message,
      retryable: err.retryable === true,
      structured: true,
    })
    return createDiagnostic(decoded.code, {
      source,
      message: decoded.message,
      retryable: decoded.retryable,
      meta: mergeMeta(),
      now,
      id,
    })
  }

  // 5 — text. Only now do we look at prose.
  const text = normalizeErrorText(err, "")
  const parsed = diagnoseParsedError(resolvePreset(toolType).parse(text))
  if (parsed) {
    return createDiagnostic(parsed.code, {
      source,
      message: conciseMessage(err, text),
      meta: mergeMeta(parsed.httpStatus !== undefined ? { httpStatus: parsed.httpStatus } : {}),
      detail: stackOf(err),
      now,
      id,
    })
  }

  // 6 — the provider classifier as a second text pass. It recognises shapes the
  // parsers don't (SDK wrappers, bare "prompt is too long") and honours the real
  // httpStatus / Retry-After when the caller threaded them through `ctx.meta`.
  const info = classifyProviderErrorInfo(text, {
    httpStatus: ctxMeta?.httpStatus,
    retryAfterMs: ctxMeta?.retryAfterMs,
  })
  if (info.errorClass !== "unknown") {
    const decoded = diagnoseProviderError(info, { httpStatus: ctxMeta?.httpStatus })
    return createDiagnostic(decoded.code, {
      source,
      message: conciseMessage(err, text),
      meta: mergeMeta(decoded.meta),
      detail: stackOf(err),
      now,
      id,
    })
  }

  // 7 — unrecognised. Keep the message and stack: `unknown` still offers
  // copy-report / report-issue / view-logs, which is exactly what they feed.
  return createDiagnostic("unknown", {
    source,
    message: conciseMessage(err, text),
    meta: mergeMeta(),
    detail: stackOf(err),
    now,
    id,
  })
}

/**
 * Build a diagnostic from a code the producer already knows, without going
 * through classification. Thin wrapper over `createDiagnostic` that tolerates
 * an unrecognised code string (e.g. one from a newer agent host).
 */
export function diagnosticFromCode(
  code: string,
  ctx: ToDiagnosticContext & { message?: string }
): CogniaDiagnostic {
  return createDiagnostic(isDiagnosticCode(code) ? code : "unknown", {
    source: ctx.source,
    message: ctx.message ?? "",
    meta: ctx.meta,
    now: ctx.now,
    id: ctx.id,
  })
}
