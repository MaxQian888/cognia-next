"use client"

import { useCallback, useSyncExternalStore } from "react"

import { isNativeMobile } from "@/lib/platform/detect"
import { getQuerySnapshot, subscribeToQuery } from "@/lib/platform/viewport-store"

const MOBILE_QUERY = "(max-width: 767.98px)"

/**
 * True when the UI should use its mobile layout.
 *
 * Two inputs, merged inside the snapshot so `useSyncExternalStore` reconciles
 * SSR → client cleanly (no `undefined` first frame, no double render):
 *
 *  - **Runtime pin** — on a native Capacitor shell the answer is always `true`,
 *    regardless of viewport width. This fixes the iPad/large-tablet case where
 *    the app already renders the mobile shell but inner components used to read
 *    `false` from the 1024px+ viewport and mismatch the shell.
 *  - **Viewport** — otherwise (web / Tauri desktop) it tracks `< 768px`.
 */
export function useIsMobile(): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => subscribeToQuery(MOBILE_QUERY, onChange),
    []
  )
  const getSnapshot = useCallback(() => isNativeMobile() || getQuerySnapshot(MOBILE_QUERY), [])
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
