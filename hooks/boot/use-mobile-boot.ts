"use client"

/**
 * `useMobileBoot` — the mobile boot screen's view of the whole phone boot.
 *
 * Two stores feed it. `lib/boot/boot-progress` holds the milestones every
 * shell shares (on the phone only `accounts` and `preferences` ever mount a
 * loader — `interface` belongs to the desktop shell, and `workspace` is the
 * routed page's own fallback). `lib/boot/mobile-boot-stages` holds the
 * Capacitor stages that follow: native bridge, pairing, host link, first sync.
 * This hook merges them into one ordered row list so the screen can show the
 * complete wait — from "unlocking your account" to "syncing conversations" —
 * no matter which owner is currently painting it.
 *
 * Owners. A gate that holds the app back passes the `milestone` it stands for
 * and this hook registers that ownership with the shared timeline, exactly as
 * `useBootProgress` does for the desktop screen. The splash overlay passes
 * `null`: it owns no milestone (it mounts *after* the gates resolve, so every
 * milestone is behind it by construction) and only reads.
 *
 * Layouts. A route transition inside the running app is a different wait from
 * a cold boot: it begins at `workspace` with no earlier step to list, and it
 * lives inside the themed shell rather than on the splash backdrop. The hook
 * reports `layout: "route"` for that case and `"boot"` for everything else;
 * the screen picks its chrome from that.
 *
 * Entrance. The desktop screen latches "intro played" the moment it mounts.
 * On the phone the first gate usually mounts *under the native splash*, where
 * nobody sees it, and latching there would rob the overlay — the first thing
 * the user actually sees — of its reveal. So a gate counts as seen only after
 * `GATE_SEEN_AFTER_MS` on screen (the native splash's floor); the overlay
 * latches immediately. The latch is the mobile store's own `introPlayed`, not
 * the shared one, because the desktop screen also mounts for one hydration
 * commit on the phone and would otherwise latch it from under the splash.
 */

import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react"

import {
  beginBootMilestone,
  bootMilestoneIndex,
  endBootMilestone,
  getBootProgressSnapshot,
  getServerBootProgressSnapshot,
  subscribeBootProgress,
  type BootMilestone,
  type BootProgressSnapshot,
} from "@/lib/boot/boot-progress"
import {
  getMobileBootSnapshot,
  getServerMobileBootSnapshot,
  markMobileBootIntroPlayed,
  MOBILE_BOOT_STAGES,
  subscribeMobileBoot,
  type MobileBootSnapshot,
  type MobileBootStage,
  type MobileBootStageDetail,
  type MobileBootStageStatus,
} from "@/lib/boot/mobile-boot-stages"

/** Shared milestones that mount a loader on the Capacitor shell. */
export const MOBILE_BOOT_MILESTONES = [
  "accounts",
  "preferences",
] as const satisfies readonly BootMilestone[]

/** A gate screen counts as "seen" once it has outlived the native splash floor. */
export const GATE_SEEN_AFTER_MS = 2500

/** Share of its slot the active row contributes to the bar. */
export const MOBILE_BOOT_ACTIVE_SHARE = 0.6

export type MobileBootRowId =
  (typeof MOBILE_BOOT_MILESTONES)[number] | "workspace" | MobileBootStage

export type MobileBootRowStatus = MobileBootStageStatus

export interface MobileBootRow {
  id: MobileBootRowId
  kind: "milestone" | "stage"
  status: MobileBootRowStatus
  /** Outcome qualifier for stage rows (an i18n key suffix); `null` otherwise. */
  detail: MobileBootStageDetail | null
  /** Measured on-screen time once ended; `null` while running or never run. */
  durationMs: number | null
}

export type MobileBootLayout = "boot" | "route"

export interface MobileBootView {
  layout: MobileBootLayout
  rows: readonly MobileBootRow[]
  /** The row that is running right now; `null` between rows. */
  activeId: MobileBootRowId | null
  /** Rows that have ended (done, failed or skipped). */
  completed: number
  total: number
  /** Overall progress in [0, 1]. */
  fraction: number
  /** The Capacitor boot outcome is known. */
  settled: boolean
  /** Anchor for the elapsed counter; `null` on the very first render of a page load. */
  sequenceStartedAt: number | null
  /** Whether this mount should play the entrance. */
  playIntro: boolean
}

function isEnded(status: MobileBootRowStatus): boolean {
  return status === "done" || status === "failed" || status === "skipped"
}

/**
 * Pure derivation shared with tests: given both snapshots and the caller's
 * milestone (`null` for the overlay), produce the row list the screen shows.
 */
export function deriveMobileBootView(
  boot: BootProgressSnapshot,
  mobile: MobileBootSnapshot,
  milestone: BootMilestone | null,
  playIntro: boolean
): MobileBootView {
  const route = milestone === "workspace" && (boot.first === "workspace" || boot.first === null)

  if (route) {
    const rows: MobileBootRow[] = [
      { id: "workspace", kind: "milestone", status: "active", detail: null, durationMs: null },
    ]
    return {
      layout: "route",
      rows,
      activeId: "workspace",
      completed: 0,
      total: 1,
      fraction: MOBILE_BOOT_ACTIVE_SHARE,
      settled: false,
      sequenceStartedAt: boot.sequenceStartedAt,
      playIntro,
    }
  }

  const ownIndex = milestone === null ? Number.POSITIVE_INFINITY : bootMilestoneIndex(milestone)
  const rows: MobileBootRow[] = []

  for (const id of MOBILE_BOOT_MILESTONES) {
    const record = boot.milestones[id]
    const position = bootMilestoneIndex(id)
    const status: MobileBootRowStatus =
      position < ownIndex ? "done" : position === ownIndex ? "active" : "pending"
    rows.push({
      id,
      kind: "milestone",
      status,
      detail: null,
      durationMs: status === "done" && record.status === "done" ? record.durationMs : null,
    })
  }

  for (const id of MOBILE_BOOT_STAGES) {
    const record = mobile.stages[id]
    rows.push({
      id,
      kind: "stage",
      status: record.status,
      detail: record.detail,
      durationMs:
        record.status === "pending" || record.status === "active" ? null : record.durationMs,
    })
  }

  const active = rows.find((row) => row.status === "active") ?? null
  const completed = rows.filter((row) => isEnded(row.status)).length
  const total = rows.length
  const fraction = Math.min(1, (completed + (active ? MOBILE_BOOT_ACTIVE_SHARE : 0)) / total)

  return {
    layout: "boot",
    rows,
    activeId: active?.id ?? null,
    completed,
    total,
    fraction,
    settled: mobile.settled,
    sequenceStartedAt: boot.sequenceStartedAt,
    playIntro,
  }
}

export function useMobileBoot(milestone: BootMilestone | null): MobileBootView {
  const boot = useSyncExternalStore(
    subscribeBootProgress,
    getBootProgressSnapshot,
    getServerBootProgressSnapshot
  )
  const mobile = useSyncExternalStore(
    subscribeMobileBoot,
    getMobileBootSnapshot,
    getServerMobileBootSnapshot
  )

  // Decided once per mount, before registration, so a hand-over inside the
  // same page load never replays the entrance once it has been seen.
  const [playIntro] = useState(() => !getMobileBootSnapshot().introPlayed)

  useLayoutEffect(() => {
    if (milestone === null) return
    beginBootMilestone(milestone)
    return () => endBootMilestone(milestone)
  }, [milestone])

  useEffect(() => {
    if (!playIntro) return
    if (milestone === null) {
      markMobileBootIntroPlayed()
      return
    }
    const timer = setTimeout(markMobileBootIntroPlayed, GATE_SEEN_AFTER_MS)
    return () => clearTimeout(timer)
  }, [playIntro, milestone])

  return deriveMobileBootView(boot, mobile, milestone, playIntro)
}
