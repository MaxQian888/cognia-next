"use client"

import { useSyncExternalStore } from "react"

import { detectPlatform, type Platform } from "@/lib/platform/detect"

/**
 * Runtime platform of the active webview, as a React hook.
 *
 * The detection itself lives in {@link detectPlatform} (`lib/platform/detect`),
 * the single framework-free source of truth. This module only adds the
 * `useSyncExternalStore` glue: the SSR / static-export path returns `"web"`
 * (no `window`), the client path detects the real platform on first paint. The
 * platform doesn't change at runtime, so `subscribe` is a no-op.
 *
 * Use this in place of inline `isTauri()` / `isCapacitor()` calls so a single
 * source of truth handles SSR safety + memoization.
 */

export type { Platform }
export { detectPlatform }

/** Convenience aliases — `usePlatform() === 'mobile'` is the normal form. */
export type MobilePlatform = Extract<Platform, "mobile">
export type DesktopPlatform = Extract<Platform, "tauri">
export type WebPlatform = Extract<Platform, "web">

const subscribe = () => () => {}

const getServerSnapshot = (): Platform => "web"

export function usePlatform(): Platform {
  return useSyncExternalStore(subscribe, detectPlatform, getServerSnapshot)
}
