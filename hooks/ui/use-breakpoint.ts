"use client"

import { useMediaQuery } from "./use-media-query"

/**
 * Three-tier viewport breakpoint for mobile-aware components.
 *
 * - `"mobile"`  < 768px (Tailwind `md`)
 * - `"tablet"`  768–1023px (`md` – `lg`)
 * - `"desktop"` ≥ 1024px (`lg+`)
 *
 * SSR-safe: returns `"desktop"` until the matchMedia listener attaches on
 * mount, matching the behaviour of `useIsMobile()` so we don't introduce a
 * different hydration flash story. Tablet branches are progressive
 * enhancements, so the initial flash only goes desktop → mobile on small
 * screens, identical to today.
 *
 * Compose, don't replace: `useIsMobile()` is still the right hook for
 * everything where mobile-vs-not is the only distinction (shell-wrapper,
 * tab-bar, sidebar drawer toggle). Use this hook only when tablet needs a
 * dedicated branch (e.g. 2-col grid).
 */
export type Breakpoint = "mobile" | "tablet" | "desktop"

const MOBILE_QUERY = "(max-width: 767.98px)"
const TABLET_QUERY = "(min-width: 768px) and (max-width: 1023.98px)"

export function useBreakpoint(): Breakpoint {
  const isMobile = useMediaQuery(MOBILE_QUERY)
  const isTablet = useMediaQuery(TABLET_QUERY)
  if (isMobile) return "mobile"
  if (isTablet) return "tablet"
  return "desktop"
}
