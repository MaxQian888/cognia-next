/**
 * Emit point for diagnostics raised outside React.
 *
 * `lib/` must stay locale-free — it has no translator, and the existing
 * lib-side `notify()` callers show what happens otherwise: `lib/scheduler/
 * notification-integration.ts` builds English titles like `Task Failed: ${name}`
 * inline, which can never be shown in Chinese. Diagnostics avoid that by
 * emitting a code and letting a React subscriber resolve the text.
 *
 * A DOM CustomEvent rather than a store, for the same reasons
 * `lib/plugin/error-bus.ts` uses one: any context can dispatch without pulling
 * React in, and the subscriber side is a one-line `useEffect`. Logging is
 * unconditional so a failure is recorded even when no UI is listening.
 */

import { loggers } from "@cognia/logging"
import type { CogniaDiagnostic } from "@cognia/diagnostics"

import type { DiagnosticOrigin } from "./surface-router"

export const DIAGNOSTIC_EVENT = "cognia:diagnostic" as const

export interface DiagnosticEventDetail {
  diagnostic: CogniaDiagnostic
  origin?: DiagnosticOrigin
}

export type DiagnosticHandler = (detail: DiagnosticEventDetail) => void

/**
 * Raise a diagnostic. Safe from any context — outside a browser the dispatch
 * is skipped but the structured log line is still written, so headless runs and
 * node tests keep the trace.
 */
export function dispatchDiagnostic(diagnostic: CogniaDiagnostic, origin?: DiagnosticOrigin): void {
  const summary = `[${diagnostic.source}] ${diagnostic.code}${diagnostic.message ? `: ${diagnostic.message}` : ""}`
  const context = {
    code: diagnostic.code,
    source: diagnostic.source,
    retryable: diagnostic.retryable,
    persistent: diagnostic.persistent,
    ...(diagnostic.meta ?? {}),
  }
  if (diagnostic.severity === "warning" || diagnostic.severity === "info") {
    loggers.app.warn(summary, context)
  } else {
    loggers.app.error(summary, undefined, context)
  }

  if (typeof window === "undefined") return
  window.dispatchEvent(
    new CustomEvent<DiagnosticEventDetail>(DIAGNOSTIC_EVENT, {
      detail: { diagnostic, ...(origin ? { origin } : {}) },
    })
  )
}

/** Subscribe to raised diagnostics. Returns an unsubscribe function. */
export function subscribeDiagnostic(handler: DiagnosticHandler): () => void {
  if (typeof window === "undefined") return () => {}
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<DiagnosticEventDetail>).detail
    if (!detail?.diagnostic) return
    handler(detail)
  }
  window.addEventListener(DIAGNOSTIC_EVENT, listener)
  return () => window.removeEventListener(DIAGNOSTIC_EVENT, listener)
}
