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
 * Convenience: derive a status-bar style from the current `next-themes`
 * resolved theme name. Background tracks app surface.
 */
export async function syncWithTheme(
  resolvedTheme: "light" | "dark" | string | undefined,
  loader: StatusBarLoader = defaultLoader
): Promise<SimpleOutcome> {
  const style: StatusBarStyle = resolvedTheme === "dark" ? "light" : "dark"
  return setStyle(style, loader)
}
