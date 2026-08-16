"use client"

/**
 * `useBootProgress` — the boot screen's view of the shared boot timeline.
 *
 * Every mount of the boot screen declares which milestone it stands for. This
 * hook registers that ownership with `lib/boot/boot-progress` for the life of
 * the mount and returns a *normalised* view of the timeline: the milestones the
 * screen should list, each with a status and (when measured) a duration, plus
 * the sequence start time the elapsed counter should be anchored to.
 *
 * Normalisation matters because of effect timing. When owner B mounts as owner
 * A unmounts, B's first render happens before either effect runs — the store
 * still says A is active. Deriving each row's status from the *caller's*
 * milestone (everything before it done, it active, everything after pending)
 * makes that first render already correct; the store then confirms it.
 *
 * Registration uses a layout effect on purpose. A route transition starts a
 * new sequence, and the store only learns that when `beginBootMilestone` runs;
 * doing it before paint means the row list the user sees first is the right
 * one rather than the previous sequence's, and the sync re-render that follows
 * a layout-effect update lands in the same frame.
 */

import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react"

import {
  beginBootMilestone,
  bootMilestoneIndex,
  BOOT_MILESTONES,
  endBootMilestone,
  getBootProgressSnapshot,
  getServerBootProgressSnapshot,
  markBootIntroPlayed,
  subscribeBootProgress,
  type BootMilestone,
  type BootMilestoneStatus,
  type BootProgressSnapshot,
} from "@/lib/boot/boot-progress"

/** Share of its slot the active milestone contributes to the bar. */
export const BOOT_ACTIVE_SHARE = 0.85

export interface BootMilestoneView {
  id: BootMilestone
  status: BootMilestoneStatus
  /** Measured on-screen time for a done milestone; `null` while running or when skipped. */
  durationMs: number | null
}

export interface BootProgressView {
  /** The milestone this mount owns. */
  milestone: BootMilestone
  /** Rows to list, first visible milestone first. */
  milestones: readonly BootMilestoneView[]
  /** 0-based position of the active row within `milestones`. */
  index: number
  total: number
  /** Overall progress in [0, 1]. */
  fraction: number
  /** Anchor for the elapsed counter; `null` on the very first render of a page load. */
  sequenceStartedAt: number | null
  /** Whether this mount should play the entrance animation. */
  playIntro: boolean
}

/**
 * Pure derivation shared with tests: given a store snapshot and the caller's
 * milestone, produce the row list the screen should show.
 */
export function deriveBootProgressView(
  snapshot: BootProgressSnapshot,
  milestone: BootMilestone,
  playIntro: boolean
): BootProgressView {
  const ownIndex = bootMilestoneIndex(milestone)
  const firstIndex = Math.min(bootMilestoneIndex(snapshot.first ?? milestone), ownIndex)
  const visible = BOOT_MILESTONES.slice(firstIndex)

  const milestones: BootMilestoneView[] = visible.map((id) => {
    const record = snapshot.milestones[id]
    const position = bootMilestoneIndex(id)
    if (position < ownIndex) {
      return {
        id,
        status: "done",
        durationMs: record.status === "done" ? record.durationMs : null,
      }
    }
    if (position === ownIndex) return { id, status: "active", durationMs: null }
    return { id, status: "pending", durationMs: null }
  })

  const index = ownIndex - firstIndex
  const total = visible.length
  const fraction = Math.min(1, (index + BOOT_ACTIVE_SHARE) / total)

  return {
    milestone,
    milestones,
    index,
    total,
    fraction,
    sequenceStartedAt: snapshot.sequenceStartedAt,
    playIntro,
  }
}

export function useBootProgress(milestone: BootMilestone): BootProgressView {
  const snapshot = useSyncExternalStore(
    subscribeBootProgress,
    getBootProgressSnapshot,
    getServerBootProgressSnapshot
  )

  // Decided once per mount, before registration, so a hand-over inside the
  // same page load never replays the entrance. Server and hydration both see
  // the pristine snapshot, so the static HTML and the first client render
  // agree on playing it.
  const [playIntro] = useState(() => !getBootProgressSnapshot().introPlayed)

  useLayoutEffect(() => {
    beginBootMilestone(milestone)
    return () => endBootMilestone(milestone)
  }, [milestone])

  useEffect(() => {
    if (playIntro) markBootIntroPlayed()
  }, [playIntro])

  return deriveBootProgressView(snapshot, milestone, playIntro)
}
