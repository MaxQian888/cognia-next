/**
 * Boot progress — the shared timeline behind the workspace boot screen.
 *
 * The boot screen is not one component instance. It is mounted, in turn, by
 * four owners at four different tree depths, and each hands over to the next
 * within the same commit:
 *
 *   1. `AccountGate`        while the local account registry is read
 *   2. `RecoveryBootGate`   while the safe-mode controller is consulted (desktop)
 *      `OnboardingGate`     while settings hydrate and the first-run verdict lands
 *   3. `DesktopAppShell`    for the SSR → client hydration gap
 *   4. `app/loading.tsx`    while the routed page's chunk streams in
 *
 * A per-mount loader forgets everything at every hand-over: its stage list
 * restarts, its elapsed counter restarts, and its entrance animation replays.
 * This module is the memory those mounts share. Each owner declares which
 * milestone it stands for (`beginBootMilestone` on mount, `endBootMilestone`
 * on unmount) and the screen renders the whole timeline — earlier milestones
 * ticked with their measured duration, the current one live, later ones
 * pending — regardless of which owner is currently painting it.
 *
 * Framework-free and `useSyncExternalStore`-shaped, like its sibling
 * `capabilities.ts`: `subscribeBootProgress` + `getBootProgressSnapshot`.
 * Snapshots are immutable and only replaced on change, so identity comparison
 * is enough for React.
 *
 * Sequences. A "sequence" is one contiguous wait from the user's point of
 * view. A hand-over that happens within `BOOT_SEQUENCE_GAP_MS` of the previous
 * milestone ending continues the sequence; a loader that mounts after the app
 * has been interactive for longer than that starts a new one. That is what
 * separates a cold boot (which begins at `accounts`) from a later client-side
 * navigation (which begins at `workspace` and must not show the account step
 * as if it were being redone). `first` records where the sequence began, so
 * the screen can hide the milestones that came before it.
 */

export const BOOT_MILESTONES = ["accounts", "preferences", "interface", "workspace"] as const

export type BootMilestone = (typeof BOOT_MILESTONES)[number]

export type BootMilestoneStatus = "pending" | "active" | "done"

export interface BootMilestoneRecord {
  status: BootMilestoneStatus
  /** When the owning loader mounted; `null` while pending or when skipped. */
  startedAt: number | null
  /** When the owning loader unmounted; `null` until done. */
  completedAt: number | null
  /**
   * Measured wall-clock time the milestone was on screen. `null` while it is
   * still running and for milestones that were passed over without ever
   * mounting a loader (an earlier step whose owner resolved synchronously).
   */
  durationMs: number | null
}

export interface BootProgressSnapshot {
  /** Milestone owned by the loader currently on screen; `null` between loaders. */
  active: BootMilestone | null
  /** First milestone begun in the current sequence; `null` before any loader mounts. */
  first: BootMilestone | null
  /** When the current sequence began; `null` before any loader mounts. */
  sequenceStartedAt: number | null
  /**
   * Whether a loader has already played the entrance animation in this page
   * load. Latched for the lifetime of the document, not the sequence: the
   * cold-boot screen earns an entrance, and every later mount — the hand-over
   * to the next owner, or a route transition's fallback — renders settled so
   * nothing re-animates in front of the user.
   */
  introPlayed: boolean
  milestones: Readonly<Record<BootMilestone, BootMilestoneRecord>>
  /** Monotonic change counter. */
  version: number
}

/**
 * Longest silence between one loader unmounting and the next mounting that
 * still counts as the same wait. Boot hand-overs happen inside a single React
 * commit; anything this long apart is a new wait.
 */
export const BOOT_SEQUENCE_GAP_MS = 1500

const PENDING: BootMilestoneRecord = Object.freeze({
  status: "pending",
  startedAt: null,
  completedAt: null,
  durationMs: null,
})

function pendingMilestones(): Record<BootMilestone, BootMilestoneRecord> {
  return {
    accounts: PENDING,
    preferences: PENDING,
    interface: PENDING,
    workspace: PENDING,
  }
}

const INITIAL_SNAPSHOT: BootProgressSnapshot = Object.freeze({
  active: null,
  first: null,
  sequenceStartedAt: null,
  introPlayed: false,
  milestones: Object.freeze(pendingMilestones()),
  version: 0,
})

let snapshot: BootProgressSnapshot = INITIAL_SNAPSHOT
let lastEndedAt: number | null = null
const listeners = new Set<() => void>()

export function bootMilestoneIndex(milestone: BootMilestone): number {
  return BOOT_MILESTONES.indexOf(milestone)
}

/**
 * The milestones the screen should list for the current sequence: everything
 * from `first` (or, before the store has been told anything, from `fallback`)
 * to the end. Earlier milestones belong to a wait the user has already sat
 * through — or, on a route transition, never happened at all.
 */
export function visibleBootMilestones(
  current: Pick<BootProgressSnapshot, "first">,
  fallback: BootMilestone
): readonly BootMilestone[] {
  const start = bootMilestoneIndex(current.first ?? fallback)
  return BOOT_MILESTONES.slice(start)
}

function publish(next: Omit<BootProgressSnapshot, "version">): void {
  snapshot = { ...next, version: snapshot.version + 1 }
  for (const listener of listeners) listener()
}

/**
 * Called by a loader when it mounts. Idempotent for the milestone already
 * active (StrictMode's mount → unmount → mount is harmless), monotonic
 * otherwise: every earlier milestone becomes done, every later one pending.
 */
export function beginBootMilestone(milestone: BootMilestone, now: number = Date.now()): void {
  if (snapshot.active === milestone) return

  const gapExceeded = lastEndedAt === null || now - lastEndedAt > BOOT_SEQUENCE_GAP_MS
  const startsSequence = snapshot.active === null && (snapshot.first === null || gapExceeded)

  const base = startsSequence ? pendingMilestones() : { ...snapshot.milestones }
  const index = bootMilestoneIndex(milestone)

  for (const other of BOOT_MILESTONES) {
    const otherIndex = bootMilestoneIndex(other)
    const record = base[other]
    if (otherIndex < index) {
      // A step we are past. Keep a measured record; anything still pending or
      // still active (an owner that never unmounted cleanly) is closed now.
      if (record.status === "done") continue
      base[other] =
        record.status === "active"
          ? {
              status: "done",
              startedAt: record.startedAt,
              completedAt: now,
              durationMs: record.startedAt === null ? null : Math.max(0, now - record.startedAt),
            }
          : { status: "done", startedAt: null, completedAt: null, durationMs: null }
    } else if (otherIndex > index && record.status !== "pending") {
      base[other] = PENDING
    }
  }

  base[milestone] = { status: "active", startedAt: now, completedAt: null, durationMs: null }

  // An owner earlier than the sequence's recorded start (the account gate
  // re-locking mid-wait) widens the visible list back to itself.
  const previousFirst = snapshot.first ?? milestone
  const continuedFirst =
    bootMilestoneIndex(milestone) < bootMilestoneIndex(previousFirst) ? milestone : previousFirst

  publish({
    active: milestone,
    first: startsSequence ? milestone : continuedFirst,
    sequenceStartedAt: startsSequence ? now : (snapshot.sequenceStartedAt ?? now),
    introPlayed: snapshot.introPlayed,
    milestones: base,
  })
}

/**
 * Called by a loader when it unmounts. A no-op unless that milestone is the
 * one currently active, so a stale unmount can never clobber a newer owner.
 */
export function endBootMilestone(milestone: BootMilestone, now: number = Date.now()): void {
  if (snapshot.active !== milestone) return
  const record = snapshot.milestones[milestone]
  lastEndedAt = now
  publish({
    ...snapshot,
    active: null,
    milestones: {
      ...snapshot.milestones,
      [milestone]: {
        status: "done",
        startedAt: record.startedAt,
        completedAt: now,
        durationMs: record.startedAt === null ? null : Math.max(0, now - record.startedAt),
      },
    },
  })
}

/** Called once a loader has started the entrance animation for this page load. */
export function markBootIntroPlayed(): void {
  if (snapshot.introPlayed) return
  publish({ ...snapshot, introPlayed: true })
}

export function subscribeBootProgress(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Stable-identity snapshot for `useSyncExternalStore`. */
export function getBootProgressSnapshot(): BootProgressSnapshot {
  return snapshot
}

/** Server / hydration snapshot: nothing has begun. */
export function getServerBootProgressSnapshot(): BootProgressSnapshot {
  return INITIAL_SNAPSHOT
}

export function __resetBootProgressForTesting(): void {
  snapshot = INITIAL_SNAPSHOT
  lastEndedAt = null
  for (const listener of listeners) listener()
}
