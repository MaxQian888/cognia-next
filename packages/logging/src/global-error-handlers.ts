/**
 * Global uncaught-error capture.
 *
 * Until now nothing installed a `window.onerror` / `unhandledrejection`
 * handler, so uncaught exceptions and rejected promises vanished silently —
 * they never reached the recent-errors ring, the native log file, or the
 * crash-report breadcrumbs. This module closes that gap by routing both into
 * the existing unified-logger pipeline (`loggers.app.error/fatal`), which
 * already feeds `recordRecentErrorLog`, the native transport, and the
 * breadcrumb transport. No new pipeline is introduced.
 *
 * Storm suppression reuses `logSampler.checkDedupe` (the same dedupe util the
 * logger ships) — the core pipeline's `shouldLog` gate always passes
 * error/fatal without deduping, so an error/rejection storm would otherwise
 * flood the 100-slot ring.
 */

import { loggers } from "./index"
import { logSampler } from "./sampling"
import type { LogLevel } from "./types"

let installed = false

/** Minimal structural surface we need from `window` (also satisfied by test fakes). */
export interface GlobalErrorTarget {
  addEventListener(type: string, handler: (event: Event) => void, capture?: boolean): void
  removeEventListener(type: string, handler: (event: Event) => void, capture?: boolean): void
}

export interface InstallGlobalErrorHandlersOptions {
  /** Injected for tests. Defaults to the real `window`. */
  target?: GlobalErrorTarget
}

interface DescribedReason {
  message: string
  error?: Error
}

/**
 * Browser-generated noise that reaches `window.onerror` but signals no real
 * fault. The ResizeObserver loop messages mean the browser deferred resize
 * notifications by one frame — spec-sanctioned behavior, fired routinely by
 * layout-observing UI libraries — yet arriving here they would be logged as
 * FATAL and trip the Next.js dev overlay.
 */
const BENIGN_ERROR_PATTERNS = [
  /^ResizeObserver loop completed with undelivered notifications/,
  /^ResizeObserver loop limit exceeded/,
]

function isBenignBrowserError(message: string): boolean {
  return BENIGN_ERROR_PATTERNS.some((pattern) => pattern.test(message))
}

/** Normalise an arbitrary rejection reason / thrown value into a message + Error. */
function describeReason(reason: unknown): DescribedReason {
  if (reason instanceof Error) {
    return { message: reason.message || reason.name || "Unknown error", error: reason }
  }
  if (typeof reason === "string") {
    return { message: reason }
  }
  if (reason === null || reason === undefined) {
    return { message: String(reason) }
  }
  try {
    return { message: JSON.stringify(reason) }
  } catch {
    return { message: String(reason) }
  }
}

/** Emit through the logger after deduping. Returns false if suppressed. */
function emit(level: LogLevel, message: string, error: Error | undefined, source: string): boolean {
  const { shouldLog, count } = logSampler.checkDedupe("app", level, message)
  if (!shouldLog) {
    return false
  }
  const data: Record<string, unknown> = { source }
  if (count && count > 1) {
    data.duplicateCount = count
  }
  if (level === "fatal") {
    loggers.app.fatal(message, error, data)
  } else if (level === "error") {
    loggers.app.error(message, error, data)
  } else {
    loggers.app.warn(message, data)
  }
  return true
}

/**
 * Install global `error` + `unhandledrejection` handlers. Idempotent and a
 * no-op under SSR (no `window`). Returns a cleanup that removes the listeners
 * and re-arms installation.
 */
export function installGlobalErrorHandlers(
  options: InstallGlobalErrorHandlersOptions = {}
): () => void {
  const target =
    options.target ??
    (typeof window !== "undefined" ? (window as unknown as GlobalErrorTarget) : undefined)
  if (!target) {
    return () => {}
  }
  if (installed) {
    return () => {}
  }
  installed = true

  const onError = (event: Event): void => {
    const errorEvent = event as ErrorEvent
    // Resource-load failures (img/script/link) reach `window` only in the
    // capture phase and carry an Element target with no `.error`. They are
    // far less actionable than a thrown exception → downgrade to warn.
    const resourceTarget =
      errorEvent.target && (errorEvent.target as unknown) !== (target as unknown)
        ? errorEvent.target
        : null
    const isResourceError = !!resourceTarget && !(errorEvent.error instanceof Error)

    if (isResourceError) {
      const tag = (resourceTarget as { tagName?: string }).tagName?.toLowerCase() ?? "resource"
      const url =
        (resourceTarget as { src?: string; href?: string }).src ??
        (resourceTarget as { href?: string }).href ??
        ""
      emit("warn", `Resource failed to load: <${tag}> ${url}`.trim(), undefined, "window.onerror")
      return
    }

    const described = describeReason(errorEvent.error ?? errorEvent.message ?? "Uncaught error")
    if (isBenignBrowserError(described.message)) {
      emit("warn", `Benign browser error: ${described.message}`, undefined, "window.onerror")
      return
    }
    emit("fatal", `Uncaught error: ${described.message}`, described.error, "window.onerror")
  }

  const onRejection = (event: Event): void => {
    const rejectionEvent = event as PromiseRejectionEvent
    const described = describeReason(rejectionEvent.reason)
    emit(
      "error",
      `Unhandled promise rejection: ${described.message}`,
      described.error,
      "unhandledrejection"
    )
  }

  // Capture phase so resource-load errors (which don't bubble) are seen too.
  target.addEventListener("error", onError, true)
  target.addEventListener("unhandledrejection", onRejection)

  return () => {
    target.removeEventListener("error", onError, true)
    target.removeEventListener("unhandledrejection", onRejection)
    installed = false
  }
}

/** Test-only: force the next install to re-arm. */
export function resetGlobalErrorHandlersForTest(): void {
  installed = false
}
