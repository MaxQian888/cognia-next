"use client"

import { useCallback, useSyncExternalStore } from "react"

import { isNativeMobile } from "@/lib/platform/detect"
import { getQuerySnapshot, subscribeToQuery } from "@/lib/platform/viewport-store"

/**
 * Three-tier viewport breakpoint for mobile-aware components.
 *
 * - `"mobile"`  < 768px (Tailwind `md`)
 * - `"tablet"`  768–1023px (`md` – `lg`)
 * - `"desktop"` ≥ 1024px (`lg+`)
 *
 * Like {@link useIsMobile}, a native Capacitor shell is **pinned to `"mobile"`**
 * regardless of viewport width so inner layout matches the mobile shell. The
 * pin and both media queries are merged inside one snapshot so
 * `useSyncExternalStore` reconciles SSR (`"desktop"`) → client without a
 * hydration mismatch. Tablet branches are progressive enhancements.
 *
 * Compose, don't replace: `useIsMobile()` is still the right hook when
 * mobile-vs-not is the only distinction. Use this only when tablet needs a
 * dedicated branch (e.g. a 2-col grid).
 */
export type Breakpoint = "mobile" | "tablet" | "desktop"

const MOBILE_QUERY = "(max-width: 767.98px)"
const TABLET_QUERY = "(min-width: 768px) and (max-width: 1023.98px)"

function getBreakpoint(): Breakpoint {
  if (isNativeMobile()) return "mobile"
  if (getQuerySnapshot(MOBILE_QUERY)) return "mobile"
  if (getQuerySnapshot(TABLET_QUERY)) return "tablet"
  return "desktop"
}

const getServerBreakpoint = (): Breakpoint => "desktop"

export function useBreakpoint(): Breakpoint {
  const subscribe = useCallback((onChange: () => void) => {
    const unsubMobile = subscribeToQuery(MOBILE_QUERY, onChange)
    const unsubTablet = subscribeToQuery(TABLET_QUERY, onChange)
    return () => {
      unsubMobile()
      unsubTablet()
    }
  }, [])
  return useSyncExternalStore(subscribe, getBreakpoint, getServerBreakpoint)
}
