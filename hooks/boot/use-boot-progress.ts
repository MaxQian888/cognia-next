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
 * Registration uses a layout effect on purpose, and the first render does not
 * wait for it. A route transition starts a new sequence, but the store only
 * learns that when `beginBootMilestone` runs; until then it still describes the
 * previous wait — the cold boot's full step list, its anchor minutes ago, its
 * sequence id. `useBootTimeline` decides once, at mount, whether this mount
 * continues the current sequence (`continuesBootSequence`) and, if not,
 * renders from `projectNewBootSequence` until the registration lands. The
 * first frame is therefore already the new wait's: one row, an empty bar, a
 * zero elapsed count — instead of a frame of the old one followed by a snap.
 */

import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react"

import {
  beginBootMilestone,
  bootMilestoneIndex,
  BOOT_MILESTONES,
  continuesBootSequence,
  endBootMilestone,
  getBootProgressSnapshot,
  getServerBootProgressSnapshot,
  markBootIntroPlayed,
  projectNewBootSequence,
  subscribeBootProgress,
  type BootMilestone,
  type BootMilestoneStatus,
  type BootProgressSnapshot,
} from "@/lib/boot/boot-progress"

/** Share of its slot the active milestone contributes to the bar. */
export const BOOT_ACTIVE_SHARE = 0.85

/** Part of the lean-in a step with measured progress gets before anything reports. */
export const BOOT_ACTIVE_FLOOR = 0.3

export interface BootMilestoneView {
  id: BootMilestone
  status: BootMilestoneStatus
  /** Measured on-screen time for a done milestone; `null` while running or when skipped. */
  durationMs: number | null
  /** When the active milestone's owner mounted; `null` for other rows and before registration. */
  startedAt: number | null
}

export interface BootProgressView {
  /** The milestone this mount owns. */
  milestone: BootMilestone
  /** Rows to list, first visible milestone first. */
  milestones: readonly BootMilestoneView[]
  /** 0-based position of the active row within `milestones`. */
  index: number
  total: number
  /** Where the active step starts on the bar, in [0, 1]. */
  boundary: number
  /** Lean-in target for the active step, in [0, 1]; never past its end. */
  fraction: number
  /** Identity of the sequence this mount belongs to (`BootProgressSnapshot.sequence`). */
  sequence: number
  /** Anchor for the elapsed counter; `null` until this mount's sequence has begun. */
  sequenceStartedAt: number | null
  /** Whether this mount should play the entrance animation. */
  playIntro: boolean
}

/**
 * Pure derivation shared with tests: given a store snapshot and the caller's
 * milestone, produce the row list the screen should show.
 *
 * `activeProgress` is the measured share of the active step that is already
 * done, in [0, 1], when the screen knows one (the workspace step counts its
 * runtimes); `null` leans into the full `BOOT_ACTIVE_SHARE`. A known share
 * keeps a floor so the bar still moves while nothing has reported yet.
 */
export function deriveBootProgressView(
  snapshot: BootProgressSnapshot,
  milestone: BootMilestone,
  playIntro: boolean,
  activeProgress: number | null = null
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
        startedAt: null,
      }
    }
    if (position === ownIndex) {
      return {
        id,
        status: "active",
        durationMs: null,
        startedAt: record.status === "active" ? record.startedAt : null,
      }
    }
    return { id, status: "pending", durationMs: null, startedAt: null }
  })

  const index = ownIndex - firstIndex
  const total = visible.length
  const share =
    activeProgress === null
      ? BOOT_ACTIVE_SHARE
      : BOOT_ACTIVE_SHARE *
        (BOOT_ACTIVE_FLOOR + (1 - BOOT_ACTIVE_FLOOR) * Math.min(1, Math.max(0, activeProgress)))
  const fraction = Math.min(1, (index + share) / total)

  return {
    milestone,
    milestones,
    index,
    total,
    boundary: index / total,
    fraction,
    sequence: snapshot.sequence,
    sequenceStartedAt: snapshot.sequenceStartedAt,
    playIntro,
  }
}

/**
 * The shared timeline as one mount should render it, with the mount's
 * ownership registered for its lifetime. `milestone: null` reads without
 * owning anything (the phone's splash overlay). Shared by the desktop and
 * mobile boot hooks so both open a new wait on the right frame.
 */
export function useBootTimeline(milestone: BootMilestone | null): BootProgressSnapshot {
  const snapshot = useSyncExternalStore(
    subscribeBootProgress,
    getBootProgressSnapshot,
    getServerBootProgressSnapshot
  )

  // Decided once per mount, before registration: the sequence id this mount
  // is about to open, or `null` when it continues the current one. Server and
  // hydration both see the pristine snapshot, where a projection equals the
  // store's own first state, so the static HTML and the first client render
  // agree.
  const [openingSequence] = useState(() => {
    if (milestone === null) return null
    const current = getBootProgressSnapshot()
    return continuesBootSequence(current, Date.now()) ? null : current.sequence + 1
  })

  useLayoutEffect(() => {
    if (milestone === null) return
    beginBootMilestone(milestone)
    return () => endBootMilestone(milestone)
  }, [milestone])

  // Until this mount's registration is in the store, render the sequence it is
  // about to start rather than the one that already ended. Keyed on the
  // sequence id, not on `active`, so a later owner taking over mid-mount is
  // followed rather than masked.
  if (milestone !== null && openingSequence !== null && snapshot.sequence < openingSequence) {
    return projectNewBootSequence(snapshot, milestone)
  }
  return snapshot
}

export function useBootProgress(
  milestone: BootMilestone,
  activeProgress: number | null = null
): BootProgressView {
  // Decided once per mount, before registration, so a hand-over inside the
  // same page load never replays the entrance. Server and hydration both see
  // the pristine snapshot, so the static HTML and the first client render
  // agree on playing it.
  const [playIntro] = useState(() => !getBootProgressSnapshot().introPlayed)
  const snapshot = useBootTimeline(milestone)

  useEffect(() => {
    if (playIntro) markBootIntroPlayed()
  }, [playIntro])

  return deriveBootProgressView(snapshot, milestone, playIntro, activeProgress)
}
