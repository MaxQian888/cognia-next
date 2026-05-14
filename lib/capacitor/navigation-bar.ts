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
  setNavigationBarColor(opts: { color: string }): Promise<void>
  setNavigationBarLight?(opts: { light: boolean }): Promise<void>
}

export type NavigationBarLoader = () => Promise<NavigationBarShape>

const defaultLoader: NavigationBarLoader = makeDefaultLoader<NavigationBarShape>(
  "@capgo/capacitor-navigation-bar",
  "NavigationBar"
)

/**
 * Set the navigation bar background color. Hex (`#RRGGBB`) recommended;
 * the underlying plugin accepts CSS colors but resolves them on the
 * native side, so stick to explicit hex for portability.
 */
export async function setNavigationBarColor(
  color: string,
  loader: NavigationBarLoader = defaultLoader
): Promise<SimpleOutcome> {
  return withPlugin(loader, async (nb) => {
    await nb.setNavigationBarColor({ color })
    return { kind: "ok" as const }
  })
}

/**
 * Toggle whether the navigation bar icons render in light variant
 * (white-on-dark) or dark variant (black-on-light).
 *
 * Plugins disagree on the parameter name historically. We feature-check
 * `setNavigationBarLight` at runtime; if the plugin doesn't expose it,
 * fall back gracefully (the OS will infer contrast from the bar color
 * itself on most devices).
 */
export async function setLightContent(
  light: boolean,
  loader: NavigationBarLoader = defaultLoader
): Promise<SimpleOutcome> {
  return withPlugin(loader, async (nb) => {
    if (typeof nb.setNavigationBarLight === "function") {
      await nb.setNavigationBarLight({ light })
    }
    return { kind: "ok" as const }
  })
}

/**
 * Derive a navigation bar appearance from the current `next-themes`
 * resolved theme name. Light theme → near-white bar with dark icons;
 * dark theme → near-black bar with light icons. The hex values track the
 * cognia design tokens documented in `globals.css`.
 *
 * Returns the outcome of the color call; `setLightContent` is best-effort
 * and its failure does not flip this result.
 */
export async function syncWithTheme(
  resolvedTheme: "light" | "dark" | string | undefined,
  loader: NavigationBarLoader = defaultLoader
): Promise<SimpleOutcome> {
  const isDark = resolvedTheme === "dark"
  const color = isDark ? "#0a0a0a" : "#ffffff"
  // Icons should contrast the bar — light icons on dark bar.
  const lightIcons = isDark
  // Fire the icon-contrast hint but don't gate on it.
  void setLightContent(lightIcons, loader)
  return setNavigationBarColor(color, loader)
}
