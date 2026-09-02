"use client"

/**
 * Main-window half of the Capacity Dock (ADR-0165 Phase 2).
 *
 * The dock window owns no Dexie and no app stores, so this initializer is what
 * gives it something to paint: it runs the same `useUsageGlance` feed the tray
 * uses and pushes the projection over `usage-dock://state`. It also opens and
 * closes the window to follow the `enabled` preference, seeds a dock that just
 * mounted and asked, and routes the dock's "open full usage" click into the
 * router (the dock cannot navigate the main window itself).
 *
 * Fully inert when the dock is disabled: no glance subscription, no window, no
 * listeners beyond the two cheap ones that let a dock ask to be seeded.
 */

import { useEffect, useRef } from "react"
import { useRouter } from "next/navigation"

import { useUsageGlance } from "@/hooks/usage/use-usage-glance"
import { isTauri } from "@/lib/tauri"
import {
  closeUsageDock,
  onUsageDockOpenFull,
  onUsageDockStateRequest,
  openUsageDock,
  sendUsageDockState,
} from "@/lib/usage-dock/client"
import { useUsageDockStore } from "@/lib/usage-dock/store"
import type { UsageGlanceQuery } from "@/lib/usage/usage-glance"

/** Where the dock's headline click lands in the main window. */
export const USAGE_DOCK_FULL_PATH = "/settings?section=subscription"

export function UsageDockInitializer() {
  const router = useRouter()
  const preferences = useUsageDockStore((s) => s.preferences)
  const hydrated = useUsageDockStore((s) => s.hydrated)
  const hydrate = useUsageDockStore((s) => s.hydrate)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  // The dock always reads spend over the day, in the Cognia scope. Its own
  // scope control would be a fourth place to configure the same axis, and a
  // rail of provider gauges is a spend surface by construction.
  const query: UsageGlanceQuery = { period: "today", scope: "cognia", metric: "spend" }
  const { snapshot } = useUsageGlance({
    query,
    enabled: hydrated && preferences.enabled && isTauri(),
  })

  // Follow the enabled flag. This is the ONLY thing that decides whether the
  // window exists, including at boot: Rust persists the dock's geometry but
  // deliberately not its visibility, so the question has exactly one answer
  // and a failed write on either side cannot make them disagree. Opening is
  // idempotent natively, so a re-render costs one no-op invoke at most.
  useEffect(() => {
    if (!hydrated || !isTauri()) return
    if (preferences.enabled) void openUsageDock()
    else void closeUsageDock()
  }, [hydrated, preferences.enabled])

  // Push on every change. `sendUsageDockState` resolves false when the window
  // is closed, which is the normal case rather than an error.
  useEffect(() => {
    if (!preferences.enabled) return
    void sendUsageDockState({ glance: snapshot, preferences })
  }, [snapshot, preferences])

  // Seed a dock that just mounted, and answer its navigation request. Both
  // listeners are cheap enough to keep mounted whenever the dock is enabled.
  // The seed listener must send the CURRENT projection, not the one captured
  // when it was installed, so it reads through a ref that a commit-time effect
  // keeps fresh. Writing the ref during render is what React forbids.
  const latest = useRef({ snapshot, preferences })
  useEffect(() => {
    latest.current = { snapshot, preferences }
  }, [snapshot, preferences])

  useEffect(() => {
    if (!preferences.enabled || !isTauri()) return
    let alive = true
    const offs: Array<() => void> = []
    void onUsageDockStateRequest(() => {
      if (!alive) return
      void sendUsageDockState({
        glance: latest.current.snapshot,
        preferences: latest.current.preferences,
      })
    }).then((off) => (alive ? offs.push(off) : off()))
    void onUsageDockOpenFull(() => {
      if (alive) router.push(USAGE_DOCK_FULL_PATH)
    }).then((off) => (alive ? offs.push(off) : off()))
    return () => {
      alive = false
      offs.forEach((off) => off())
    }
  }, [preferences.enabled, router])

  return null
}

export default UsageDockInitializer
