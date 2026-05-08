"use client"

import { useSyncExternalStore } from "react"

/**
 * Runtime platform of the active webview.
 *
 * - `tauri`  — Tauri desktop shell. `__TAURI_INTERNALS__` is on `window`.
 * - `mobile` — Capacitor mobile shell. `window.Capacitor.isNativePlatform()` returns true.
 * - `web`    — vanilla browser, dev mode, or a server-rendered initial paint.
 *
 * The hook resolves through {@link useSyncExternalStore}: the SSR / static-
 * export path returns `"web"` (no `window`), the client path detects the
 * real platform on first paint. The platform doesn't change at runtime, so
 * the subscribe handler is a no-op.
 *
 * Use this in place of inline `isTauri()` / `isCapacitor()` calls so a
 * single source of truth handles SSR safety + memoization.
 */
export type Platform = "tauri" | "mobile" | "web"

/** Convenience aliases — `usePlatform() === 'mobile'` is the normal form. */
export type MobilePlatform = Extract<Platform, "mobile">
export type DesktopPlatform = Extract<Platform, "tauri">
export type WebPlatform = Extract<Platform, "web">

export function detectPlatform(): Platform {
  if (typeof window === "undefined") return "web"
  if ("__TAURI_INTERNALS__" in window) return "tauri"
  const cap = (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  if (typeof cap?.isNativePlatform === "function" && cap.isNativePlatform() === true) {
    return "mobile"
  }
  return "web"
}

const subscribe = () => () => {}

const getServerSnapshot = (): Platform => "web"

export function usePlatform(): Platform {
  return useSyncExternalStore(subscribe, detectPlatform, getServerSnapshot)
}
