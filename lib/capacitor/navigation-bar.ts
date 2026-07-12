"use client"

/**
 * Android navigation-bar wrapper (Phase 3 of the mobile theme parity work).
 *
 * Mirrors the desktop's status bar so the soft-button row at the bottom of
 * Android tracks the active theme — `syncWithTheme(resolvedTheme)` sets a
 * matching background plus icon contrast. iOS has no navigation bar
 * concept; the loader resolves to `unsupported` there.
 *
 * The native side ships through a community Capacitor 7 plugin. We import
 * `@capgo/capacitor-navigation-bar` lazily via `makeDefaultLoader` so the
 * web bundle never pulls it in; if the plugin isn't installed, every call
 * collapses to `{ kind: "unsupported" }` and the rest of the app stays
 * happy.
 */

import { makeDefaultLoader, withPlugin, type SimpleOutcome } from "./_shared"

interface NavigationBarShape {
  /**
   * `@capgo/capacitor-navigation-bar` v8 surface: one call carries both the
   * background color and the icon contrast (`darkButtons: true` = dark icons
   * for a light bar). There is NO separate `setNavigationBarLight` method —
   * the old feature-check against the Capacitor proxy always "passed" and
   * then rejected natively, so icon contrast was never actually applied.
   */
  setNavigationBarColor(opts: { color: string; darkButtons?: boolean }): Promise<void>
}

export type NavigationBarLoader = () => Promise<NavigationBarShape>

const defaultLoader: NavigationBarLoader = makeDefaultLoader<NavigationBarShape>(
  "@capgo/capacitor-navigation-bar",
  "NavigationBar"
)

/**
 * Set the navigation bar background color and icon contrast. Hex
 * (`#RRGGBB`) recommended; the underlying plugin accepts CSS colors but
 * resolves them on the native side, so stick to explicit hex for
 * portability. `darkButtons` defaults to dark icons (light-bar reading);
 * pass `false` for light icons on a dark bar.
 */
export async function setNavigationBarColor(
  color: string,
  darkButtons = true,
  loader: NavigationBarLoader = defaultLoader
): Promise<SimpleOutcome> {
  return withPlugin(loader, async (nb) => {
    await nb.setNavigationBarColor({ color, darkButtons })
    return { kind: "ok" as const }
  })
}

/**
 * Derive a navigation bar appearance from the current `next-themes`
 * resolved theme name plus an optional `backgroundHex` from the appearance
 * shell-sync helper. When `backgroundHex` is supplied the bar paints with
 * the live appearance palette; otherwise we fall back to the historical
 * near-white / near-black defaults so existing call sites keep working.
 */
export async function syncWithTheme(
  resolvedTheme: "light" | "dark" | string | undefined,
  backgroundHex?: string,
  loader: NavigationBarLoader = defaultLoader
): Promise<SimpleOutcome> {
  const isDark = resolvedTheme === "dark"
  const color = backgroundHex ?? (isDark ? "#0a0a0a" : "#ffffff")
  // Icons contrast the bar: dark icons on a light bar, light icons on dark.
  return setNavigationBarColor(color, !isDark, loader)
}
