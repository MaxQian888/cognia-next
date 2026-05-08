"use client"

import { makeDefaultLoader, withPlugin, type SimpleOutcome } from "./_shared"

/**
 * `@capacitor/haptics` wrapper. Tab switches, swipe actions, long-press
 * confirmation, and success / error toasts all route through this so the
 * UI layer never imports the native module directly.
 *
 * On non-mobile platforms every function resolves to `{ kind: "unsupported" }`
 * — callers can treat the wrapper as a no-op without branching.
 */

export type HapticsImpactStyle = "heavy" | "medium" | "light"
export type HapticsNotificationType = "success" | "warning" | "error"

interface HapticsShape {
  impact(opts: { style: "HEAVY" | "MEDIUM" | "LIGHT" }): Promise<void>
  notification(opts: { type: "SUCCESS" | "WARNING" | "ERROR" }): Promise<void>
  vibrate(opts?: { duration?: number }): Promise<void>
  selectionStart(): Promise<void>
  selectionChanged(): Promise<void>
  selectionEnd(): Promise<void>
}

export type HapticsLoader = () => Promise<HapticsShape>

const defaultLoader: HapticsLoader = makeDefaultLoader<HapticsShape>(
  "@capacitor/haptics",
  "Haptics"
)

const STYLE_MAP: Record<HapticsImpactStyle, "HEAVY" | "MEDIUM" | "LIGHT"> = {
  heavy: "HEAVY",
  medium: "MEDIUM",
  light: "LIGHT",
}

const TYPE_MAP: Record<HapticsNotificationType, "SUCCESS" | "WARNING" | "ERROR"> = {
  success: "SUCCESS",
  warning: "WARNING",
  error: "ERROR",
}

export async function impact(
  style: HapticsImpactStyle = "light",
  loader: HapticsLoader = defaultLoader
): Promise<SimpleOutcome> {
  const result = await withPlugin(loader, async (haptics) => {
    await haptics.impact({ style: STYLE_MAP[style] })
    return { kind: "ok" as const }
  })
  return result
}

export async function notify(
  type: HapticsNotificationType,
  loader: HapticsLoader = defaultLoader
): Promise<SimpleOutcome> {
  return withPlugin(loader, async (haptics) => {
    await haptics.notification({ type: TYPE_MAP[type] })
    return { kind: "ok" as const }
  })
}

export async function vibrate(
  durationMs = 200,
  loader: HapticsLoader = defaultLoader
): Promise<SimpleOutcome> {
  return withPlugin(loader, async (haptics) => {
    await haptics.vibrate({ duration: durationMs })
    return { kind: "ok" as const }
  })
}

export async function selection(
  phase: "start" | "changed" | "end",
  loader: HapticsLoader = defaultLoader
): Promise<SimpleOutcome> {
  return withPlugin(loader, async (haptics) => {
    if (phase === "start") await haptics.selectionStart()
    else if (phase === "changed") await haptics.selectionChanged()
    else await haptics.selectionEnd()
    return { kind: "ok" as const }
  })
}

/** Convenience: light impact + selection-changed for tab/menu transitions. */
export async function selectionFeedback(
  loader: HapticsLoader = defaultLoader
): Promise<SimpleOutcome> {
  return withPlugin(loader, async (haptics) => {
    await haptics.selectionChanged()
    return { kind: "ok" as const }
  })
}
