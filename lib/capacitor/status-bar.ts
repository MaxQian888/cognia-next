"use client"

import { makeDefaultLoader, withPlugin, type SimpleOutcome } from "./_shared"

/**
 * `@capacitor/status-bar` wrapper. Mounted at app boot from
 * `companion-boot-provider` so the status bar tracks the current theme
 * (light/dark) and the active screen's chrome (transparent in chat detail,
 * opaque elsewhere).
 */

export type StatusBarStyle = "light" | "dark" | "default"

interface StatusBarShape {
  setStyle(opts: { style: "LIGHT" | "DARK" | "DEFAULT" }): Promise<void>
  setBackgroundColor(opts: { color: string }): Promise<void>
  show(): Promise<void>
  hide(): Promise<void>
  setOverlaysWebView(opts: { overlay: boolean }): Promise<void>
}

export type StatusBarLoader = () => Promise<StatusBarShape>

const defaultLoader: StatusBarLoader = makeDefaultLoader<StatusBarShape>(
  "@capacitor/status-bar",
  "StatusBar"
)

const STYLE_MAP: Record<StatusBarStyle, "LIGHT" | "DARK" | "DEFAULT"> = {
  light: "LIGHT",
  dark: "DARK",
  default: "DEFAULT",
}

export async function setStyle(
  style: StatusBarStyle,
  loader: StatusBarLoader = defaultLoader
): Promise<SimpleOutcome> {
  return withPlugin(loader, async (sb) => {
    await sb.setStyle({ style: STYLE_MAP[style] })
    return { kind: "ok" as const }
  })
}

export async function setBackgroundColor(
  color: string,
  loader: StatusBarLoader = defaultLoader
): Promise<SimpleOutcome> {
  return withPlugin(loader, async (sb) => {
    await sb.setBackgroundColor({ color })
    return { kind: "ok" as const }
  })
}

export async function show(loader: StatusBarLoader = defaultLoader): Promise<SimpleOutcome> {
  return withPlugin(loader, async (sb) => {
    await sb.show()
    return { kind: "ok" as const }
  })
}

export async function hide(loader: StatusBarLoader = defaultLoader): Promise<SimpleOutcome> {
  return withPlugin(loader, async (sb) => {
    await sb.hide()
    return { kind: "ok" as const }
  })
}

export async function setOverlay(
  overlay: boolean,
  loader: StatusBarLoader = defaultLoader
): Promise<SimpleOutcome> {
  return withPlugin(loader, async (sb) => {
    await sb.setOverlaysWebView({ overlay })
    return { kind: "ok" as const }
  })
}

/**
 * Convenience: drive the iOS status bar from a `next-themes` resolved
 * theme name plus an optional `backgroundHex` from the appearance shell-
 * sync helper. Both the icon style (light / dark) and the background
 * colour are pushed so a custom appearance palette repaints the bar in
 * lockstep with the in-app theme.
 *
 * Backwards-compatible — the old call site (`syncWithTheme(resolvedTheme)`)
 * still works; without `backgroundHex` the bar style flips but the
 * background colour is left to the OS default.
 */
export async function syncWithTheme(
  resolvedTheme: "light" | "dark" | string | undefined,
  backgroundHex?: string,
  loader: StatusBarLoader = defaultLoader
): Promise<SimpleOutcome> {
  const style: StatusBarStyle = resolvedTheme === "dark" ? "light" : "dark"
  const styleOutcome = await setStyle(style, loader)
  // `setBackgroundColor` is Android-only: on iOS the plugin rejects (the
  // proxy fabricates the method and fails at call time), the rejection is
  // swallowed inside `withPlugin`, and the caller would believe the colour
  // applied. Gate on the reported platform (same pattern as
  // local-notifications.ensureChannel).
  const platform = (
    globalThis as { Capacitor?: { getPlatform?: () => string } }
  ).Capacitor?.getPlatform?.()
  if (backgroundHex && platform !== "ios") {
    // Fire-and-await so a colour failure surfaces in the caller's logs;
    // the style outcome is what we return because it's the primary signal.
    await setBackgroundColor(backgroundHex, loader)
  }
  return styleOutcome
}
