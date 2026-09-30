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

/**
 * How long repeats of an opaque "Script error." are folded into one counted
 * entry. See {@link isOpaqueScriptError}.
 */
export const OPAQUE_SCRIPT_ERROR_WINDOW_MS = 5 * 60_000

const OPAQUE_SCRIPT_ERROR_MESSAGE = /^Script error\.?$/i

/**
 * A "muted" error: the engine withheld everything but the literal text
 * "Script error." — no `error` object, no file, no line, no stack.
 *
 * Browsers do this for an exception thrown by a script whose origin the page
 * may not read (a cross-origin `<script>` without `crossorigin`). The app's own
 * bundles are same-origin in every shell (`https://localhost` under Capacitor,
 * `tauri://` / the dev server elsewhere), so on the phone the usual source is
 * code the NATIVE side evaluates into the page — Capacitor's bridge delivers
 * plugin results by `evaluateJavascript`, which has no script origin, so an
 * exception escaping a plugin callback surfaces here muted.
 *
 * Nothing in such an event can be diagnosed, and it repeats with every plugin
 * round trip: under the ordinary 5 s dedupe it filled the whole recent-log
 * buffer (1000 of 1000 entries on a 40-minute device session), evicting every
 * entry that could have explained anything. So repeats are counted, not
 * dropped — one entry per {@link OPAQUE_SCRIPT_ERROR_WINDOW_MS}, carrying how
 * many occurrences it stands for.
 */
function isOpaqueScriptError(event: ErrorEvent): boolean {
  return (
    event.error == null &&
    typeof event.message === "string" &&
    OPAQUE_SCRIPT_ERROR_MESSAGE.test(event.message.trim()) &&
    !event.filename &&
    !event.lineno
  )
}

const PLATFORM_DENIAL_PATTERN =
  /request is not allowed by the user agent or the platform|user denied permission/i
const CANCELLATION_PATTERN = /^cancel(?:ed|led)$/i

function isBenignBrowserError(message: string): boolean {
  return BENIGN_ERROR_PATTERNS.some((pattern) => pattern.test(message))
}

function errorLikeFields(reason: unknown): { name: string; message: string } {
  if (!reason || typeof reason !== "object") {
    return { name: "", message: typeof reason === "string" ? reason : "" }
  }
  const candidate = reason as { name?: unknown; message?: unknown }
  return {
    name: typeof candidate.name === "string" ? candidate.name : "",
    message: typeof candidate.message === "string" ? candidate.message : "",
  }
}

/**
 * User-dismissed platform prompts reject with browser/native error shapes even
 * though cancellation is an expected control-flow outcome. Keep unrelated
 * NotAllowedErrors visible: only the standard user-agent/platform denial text
 * is suppressed.
 */
function isBenignPlatformRejection(reason: unknown): boolean {
  const { name, message } = errorLikeFields(reason)
  return (
    name === "AbortError" ||
    CANCELLATION_PATTERN.test(message) ||
    (name === "NotAllowedError" && PLATFORM_DENIAL_PATTERN.test(message))
  )
}

/** Normalise an arbitrary rejection reason / thrown value into a message + Error. */
function describeReason(reason: unknown): DescribedReason {
  if (reason instanceof Error) {
    return { message: reason.message || reason.name || "Unknown error", error: reason }
  }
  const errorLike = errorLikeFields(reason)
  if (errorLike.message || errorLike.name) {
    return { message: errorLike.message || errorLike.name }
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

  // Opaque "Script error." folding (see `isOpaqueScriptError`). The first
  // occurrence is logged at once and opens a window; occurrences inside it are
  // only counted, and when it closes a single entry reports the count and
  // re-opens the window. A window that closes with nothing counted ends the
  // cycle, so the next occurrence is logged immediately again.
  let opaqueSuppressed = 0
  let opaqueWindowStartedAt = 0
  let opaqueTimer: ReturnType<typeof setTimeout> | null = null
  const reportOpaque = (occurrences: number, windowMs: number): void => {
    const data: Record<string, unknown> = {
      source: "window.onerror",
      opaque: true,
    }
    if (occurrences > 1) {
      data.duplicateCount = occurrences
      data.windowMs = windowMs
    }
    const summary =
      occurrences > 1
        ? `Uncaught error: Script error. (opaque — no message, file or stack; ${occurrences}× in ${Math.round(windowMs / 1000)}s)`
        : "Uncaught error: Script error. (opaque — no message, file or stack)"
    loggers.app.error(summary, undefined, data)
  }
  const openOpaqueWindow = (): void => {
    opaqueWindowStartedAt = Date.now()
    opaqueTimer = setTimeout(closeOpaqueWindow, OPAQUE_SCRIPT_ERROR_WINDOW_MS)
  }
  const closeOpaqueWindow = (): void => {
    opaqueTimer = null
    if (opaqueSuppressed === 0) return
    const count = opaqueSuppressed
    opaqueSuppressed = 0
    reportOpaque(count, Date.now() - opaqueWindowStartedAt)
    openOpaqueWindow()
  }
  const onOpaqueScriptError = (): void => {
    if (opaqueTimer) {
      opaqueSuppressed++
      return
    }
    reportOpaque(1, 0)
    openOpaqueWindow()
  }

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

    if (isOpaqueScriptError(errorEvent)) {
      onOpaqueScriptError()
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
    if (isBenignPlatformRejection(rejectionEvent.reason)) {
      rejectionEvent.preventDefault()
      rejectionEvent.stopImmediatePropagation()
      emit(
        "warn",
        `Benign platform rejection: ${described.message}`,
        undefined,
        "unhandledrejection"
      )
      return
    }
    emit(
      "error",
      `Unhandled promise rejection: ${described.message}`,
      described.error,
      "unhandledrejection"
    )
  }

  // Capture phase so resource-load errors (which don't bubble) are seen too.
  target.addEventListener("error", onError, true)
  // Rejections also use capture phase so expected platform cancellations can
  // be stopped before framework dev-overlay listeners classify them as crashes.
  target.addEventListener("unhandledrejection", onRejection, true)

  return () => {
    target.removeEventListener("error", onError, true)
    target.removeEventListener("unhandledrejection", onRejection, true)
    if (opaqueTimer) {
      clearTimeout(opaqueTimer)
      opaqueTimer = null
    }
    // Report what the open window counted rather than lose it on teardown.
    if (opaqueSuppressed > 0) {
      reportOpaque(opaqueSuppressed, Date.now() - opaqueWindowStartedAt)
      opaqueSuppressed = 0
    }
    installed = false
  }
}

/** Test-only: force the next install to re-arm. */
export function resetGlobalErrorHandlersForTest(): void {
  installed = false
}
