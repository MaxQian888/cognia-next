/**
 * Plugin Error Bus — a single, typed DOM CustomEvent channel that every
 * plugin pipeline step (install / load / enable / disable / uninstall /
 * config / activation / WASM preload / hot-reload) dispatches into when a
 * non-fatal or fatal failure happens that the user should see.
 *
 * Why a custom event vs an in-memory pub-sub library:
 *   - Mirrors the existing `PLUGIN_ENABLE_FAILED_EVENT` pattern in
 *     `lib/plugin/core/manager.ts` so subscribers stay symmetric.
 *   - SSR / sidecar callers can call `dispatchPluginError` without
 *     touching `window`; we no-op there and the diagnostic still lands
 *     in the structured logger.
 *   - The subscriber side is React-friendly: a one-line useEffect with
 *     `subscribePluginError(handler)`.
 *
 * Logging is unconditional, regardless of whether a UI subscriber is
 * attached, so headless tests and the sidecar still capture the trace.
 */

import { loggers } from "@/lib/logging"

export const PLUGIN_ERROR_EVENT = "plugin:error" as const

export type PluginErrorStage =
  | "install"
  | "install-rollback"
  | "load"
  | "enable"
  | "disable"
  | "uninstall"
  | "config"
  | "activation"
  | "permission-register"
  | "wasm-preload"
  | "hot-reload"
  | "local-install"

export type PluginErrorSeverity = "error" | "warning"

export interface PluginErrorEventDetail {
  pluginId: string
  /** Best-effort display name for the toast title (falls back to pluginId). */
  pluginName?: string
  stage: PluginErrorStage
  /** Short message — UI may wrap or truncate. */
  message: string
  severity: PluginErrorSeverity
  /**
   * `true` when the user can retry (e.g. transient network failure during
   * marketplace install). `false` when the failure is permanent until the
   * plugin itself ships a fix (e.g. invalid manifest, signature mismatch).
   * Subscribers may use this to render a Retry button or not.
   */
  recoverable: boolean
}

export type PluginErrorHandler = (detail: PluginErrorEventDetail) => void

/**
 * Fire a typed error event. Safe to call from any context — when
 * `window` is undefined (Node / sidecar / tests without jsdom) the
 * dispatch is skipped but the logger still records the failure.
 */
export function dispatchPluginError(detail: PluginErrorEventDetail): void {
  const summary = `[${detail.stage}] ${detail.pluginId}${detail.pluginName ? ` (${detail.pluginName})` : ""}: ${detail.message}`
  if (detail.severity === "warning") {
    loggers.plugin.warn(summary, { stage: detail.stage, recoverable: detail.recoverable })
  } else {
    loggers.plugin.error(summary, undefined, {
      stage: detail.stage,
      recoverable: detail.recoverable,
    })
  }
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent<PluginErrorEventDetail>(PLUGIN_ERROR_EVENT, { detail }))
}

/**
 * Subscribe to plugin errors. Returns an unsubscribe function. In a
 * non-browser context (where `window` is undefined) returns a noop so
 * test setup doesn't have to branch.
 */
export function subscribePluginError(handler: PluginErrorHandler): () => void {
  if (typeof window === "undefined") return () => {}
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<PluginErrorEventDetail>).detail
    if (!detail || !detail.pluginId) return
    handler(detail)
  }
  window.addEventListener(PLUGIN_ERROR_EVENT, listener)
  return () => window.removeEventListener(PLUGIN_ERROR_EVENT, listener)
}
