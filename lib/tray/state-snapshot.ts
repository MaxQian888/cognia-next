// Reactive `TrayStateSnapshot` for the sync hook. Combines:
//
//   - `useChatStore`        → chat.streaming, chat.hasActiveSession
//   - Dexie `goals` table   → goal.active, goal.paused (via `useLiveQuery`;
//                              transitions fired by the goal runtime's
//                              pause/resume/stop paths in
//                              `lib/goal/runtime.ts` write to IndexedDB and
//                              automatically wake us up)
//   - `automation:event` /  → automation.running (true while events arrive
//     `automation:kill-switch`  within ACTIVITY_WINDOW_MS), automation.armed
//                              (flips false once the kill switch fires)
//   - navigator             → platform.os
//
// Anything that observably changes drives the sync hook to push a fresh DTO
// to Rust. The fallback `defaultSnapshot()` lives in `sync.ts` for tests
// that don't mount a provider tree.

"use client"

import { useEffect, useMemo, useState } from "react"
import { listen } from "@tauri-apps/api/event"
import { useLiveQuery } from "dexie-react-hooks"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { getOpenGoalForSession } from "@/lib/db/goals"
import { getDb } from "@/lib/db/schema"
import { computePetView } from "@/lib/pet/runtime/pet-view"
import { APP_VERSION } from "@/lib/app-version"
import { isAutostartEnabled } from "@/lib/tauri/autostart"
import { isTauri } from "@/lib/tauri"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"
import { isMainAppWindow } from "@/lib/pet/window-role"
import type { PetProfile } from "@/types/pet"

import { onAutostartChanged } from "./autostart-control"
import { useTrayStore } from "./store"
import { useTrayUsage } from "./usage"
import type { TrayStateSnapshot } from "./types"

const ACTIVITY_WINDOW_MS = 8_000

function detectOs(): TrayStateSnapshot["platform"]["os"] {
  if (typeof navigator === "undefined" || !navigator.platform) return "unknown"
  const p = navigator.platform.toLowerCase()
  if (p.includes("win")) return "windows"
  if (p.includes("mac")) return "macos"
  if (p.includes("linux")) return "linux"
  return "unknown"
}

/** Lazily decay the profile's needs against the current wall clock. */
function snapshotPetStats(profile: PetProfile): NonNullable<TrayStateSnapshot["pet"]> {
  const view = computePetView(profile, null, Date.now())
  return {
    enabled: true,
    energy: view.needs.energy,
    mood: view.needs.mood,
    bond: view.needs.bond,
  }
}

interface AutomationState {
  running: boolean
  armed: boolean
}

export function useTrayStateSnapshot(): TrayStateSnapshot {
  const status = useChatStore((s) => s.status)
  const activeSessionId = useChatStore((s) => s.activeSessionId)

  // Live goal subscription via Dexie's `useLiveQuery` — fires on every
  // pause / resume / stop / preempt the goal runtime writes to IndexedDB.
  // Returns the most recent open (non-terminal) goal for the session, or
  // `null` when there's no active session yet.
  const openGoal = useLiveQuery(
    async () => (activeSessionId ? ((await getOpenGoalForSession(activeSessionId)) ?? null) : null),
    [activeSessionId],
    null
  )
  const goal = useMemo(
    () => ({
      active: openGoal?.status === "active",
      paused: openGoal?.status === "paused",
      // Redacted objective only — the tray is an OS surface (screenshot-able),
      // so the raw objective never leaks here.
      title: openGoal?.safeObjective,
    }),
    [openGoal?.status, openGoal?.safeObjective]
  )

  // Desktop-pet quick-glance stats, gated on `PetSettings.enabled` the same
  // way the widget itself is. `computePetView` lazily decays needs — same
  // values `hooks/pet/use-pet.ts` shows — so the tray never disagrees.
  const petEnabled = useSettingsStore((s) => s.settings?.petSettings?.enabled ?? false)
  const petProfile = useLiveQuery(() => getDb().petProfile.get("global"), [])
  const pet = useMemo(
    () => (petEnabled && petProfile ? snapshotPetStats(petProfile) : null),
    [petEnabled, petProfile]
  )

  // OS launch-at-login state. Read once on mount, then kept fresh by the
  // `toggle-autostart` tray action's broadcast (`lib/tray/autostart-control`).
  const [autostart, setAutostart] = useState(false)
  useEffect(() => {
    // Least-privilege pet windows are not granted `autostart:allow-is-enabled`
    // (see `src-tauri/capabilities/pet.json`); reading it there only warns.
    if (!isTauri() || !isMainAppWindow()) return
    let cancelled = false
    void isAutostartEnabled().then((on) => {
      if (!cancelled) setAutostart(on)
    })
    const off = onAutostartChanged((on) => {
      if (!cancelled) setAutostart(on)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [])

  const [automation, setAutomation] = useState<AutomationState>({
    running: false,
    armed: true,
  })
  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    let activityTimer: ReturnType<typeof setTimeout> | null = null
    const offHandles: Array<() => void> = []

    function markRunning() {
      if (cancelled) return
      setAutomation((prev) => (prev.running ? prev : { ...prev, running: true }))
      if (activityTimer) clearTimeout(activityTimer)
      activityTimer = setTimeout(() => {
        if (cancelled) return
        setAutomation((prev) => ({ ...prev, running: false }))
      }, ACTIVITY_WINDOW_MS)
    }

    void listen("automation:event", markRunning).then((off) => {
      if (cancelled) safeUnlisten(off)
      else offHandles.push(off)
    })
    void listen("automation:consent-request", markRunning).then((off) => {
      if (cancelled) safeUnlisten(off)
      else offHandles.push(off)
    })
    void listen("automation:kill-switch", () => {
      if (cancelled) return
      setAutomation({ running: false, armed: false })
    }).then((off) => {
      if (cancelled) safeUnlisten(off)
      else offHandles.push(off)
    })

    return () => {
      cancelled = true
      if (activityTimer) clearTimeout(activityTimer)
      for (const off of offHandles) safeUnlisten(off)
    }
  }, [])

  // Subscription-quota glance. Fetching is gated on some usage surface being
  // enabled (menu section / tooltip suffix / taskbar mode) so idle installs
  // never poll provider usage endpoints; the hook itself no-ops outside Tauri.
  const display = useTrayStore((s) => s.display)
  const usageEnabled =
    isTauri() &&
    isMainAppWindow() &&
    (display.showUsageInMenu || display.showUsageInTooltip || display.taskbarUsageMode !== "off")
  const usageData = useTrayUsage(usageEnabled, display.usageRefreshMinutes)
  const usage = useMemo(
    () => (usageData ? { ...usageData, selectedKey: display.usageAccountKey } : null),
    [usageData, display.usageAccountKey]
  )

  // Memoised, because the snapshot's IDENTITY is load-bearing downstream.
  //
  // `usePluginQuickActions` memoises on it, `useGlobalSearchContext` memoises
  // on that, and `useGlobalSearch` keys its query effect on the resulting
  // context. Returning a fresh literal every render therefore invalidated that
  // whole chain on every render, and since the effect sets state, each run
  // scheduled the next one: ⌘K search died with "Maximum update depth
  // exceeded" as soon as a query was typed. The tray's own sync hook was
  // pushing a redundant DTO to Rust on every render for the same reason.
  return useMemo(
    () => ({
      goal,
      automation,
      chat: {
        streaming: status === "streaming",
        hasActiveSession: !!activeSessionId,
      },
      platform: { os: detectOs() },
      app: { autostart, version: APP_VERSION },
      pet,
      usage,
    }),
    [goal, automation, status, activeSessionId, autostart, pet, usage]
  )
}
