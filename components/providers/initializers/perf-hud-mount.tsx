"use client"

import type { ReactNode } from "react"

import { useCoarsePointer, useHasHover } from "@/hooks/ui/use-pointer"
import { PerfHud } from "@/lib/perf"

/**
 * Mount gate for the frontend `<PerfHud>`.
 *
 * The HUD is a developer panel pinned `fixed bottom-2 right-2` above every
 * layer of the app. On a touch-only device that corner is the mobile tab bar's
 * Discover / Me targets (and the right-hand buttons of any bottom sheet), so a
 * visible HUD there does not just clutter the screen, it swallows taps.
 *
 * `<PerfHud>` already excludes the Capacitor shell, but through the runtime
 * sniff alone (`detectPlatform() === "mobile"`). On an Android device where
 * that sniff did not resolve to `mobile`, the panel auto-mounted anyway and came
 * back after every cold start. This gate asks the input hardware instead, which
 * needs no runtime marker: a primary pointer that can hover and is not coarse is
 * a desktop or laptop, where the HUD belongs; anything else is a phone or a
 * touch-only tablet, where it never mounts — the dev auto-mount and the
 * `localStorage.cogniaPerfHud` opt-in both included.
 *
 * SSR and the first client render use the desktop defaults of the pointer
 * hooks, and `<PerfHud>` renders nothing on the server either, so hydration
 * agrees; the touch answer lands right after.
 */
export function PerfHudMount(): ReactNode {
  const hasHover = useHasHover()
  const coarsePointer = useCoarsePointer()
  if (!hasHover || coarsePointer) return null
  return <PerfHud />
}
