/**
 * Mobile boot stages — the Capacitor half of the boot timeline.
 *
 * `boot-progress.ts` records the milestones every shell shares (account
 * registry, preferences, interface, workspace). On the phone the wait does not
 * end there: once the gates let the shell mount, `CompanionBootProvider` still
 * has to wire the native bridge, read the pairing, reach the desktop host and
 * pull the first sync before the app is genuinely usable. Today that work is
 * invisible — the splash holds for a fixed 1.5 s and fades no matter what.
 *
 * This module gives those steps a name and a status so the mobile boot screen
 * (`components/mobile/splash/mobile-boot-screen.tsx`) can list them next to
 * the shared milestones, and so the splash overlay can dismiss the moment the
 * boot has actually *settled* rather than on a stopwatch. It is deliberately
 * shaped like its siblings: framework-free, `useSyncExternalStore`-friendly,
 * immutable snapshots replaced only on change.
 *
 *   bridge     `registerNativePlugins()` — the window.Capacitor proxies exist
 *   companion  pairing read from secure storage → paired / standalone / unpaired
 *   host       runtime target registered + host manifest negotiated
 *   sync       the initial `runSyncDown()`
 *
 * `settled` is the splash's dismiss signal. The provider raises it as soon as
 * the outcome the user cares about is known — the host is linked (or is not
 * going to be), or there is no host to link — *before* the first sync, which
 * can be long and is shown live but never gates the overlay. The overlay also
 * has a hard ceiling of its own, so a stage that never reports back can't
 * strand anyone on a splash; see `AppSplash`.
 *
 * `overlayVisible` is written by the splash overlay itself. While it is up the
 * status / navigation bars should match its backdrop, not the app theme —
 * `CompanionBootProvider`'s theme sync reads this flag and stands aside.
 *
 * `introPlayed` is the phone's own entrance latch. It is separate from the
 * shared one in `boot-progress.ts` on purpose: the desktop boot screen mounts
 * for one hydration commit on the phone too (the platform hook's server
 * snapshot is `"web"`) and latches the shared flag from under the native
 * splash, which would rob the first screen the user actually sees of its
 * reveal. See `useMobileBoot` for who latches this one, and when.
 */

export const MOBILE_BOOT_STAGES = ["bridge", "companion", "host", "sync"] as const

export type MobileBootStage = (typeof MOBILE_BOOT_STAGES)[number]

export type MobileBootStageStatus = "pending" | "active" | "done" | "failed" | "skipped"

/**
 * Outcome qualifiers, one vocabulary per stage. They are i18n key suffixes
 * (`mobile.splash.outcomes.<detail>`), never display strings.
 */
export type MobileBootStageDetail =
  // bridge
  | "registered"
  | "unavailable"
  // companion
  | "paired"
  | "standalone"
  | "unpaired"
  // host
  | "linked"
  | "offline"
  | "incompatible"
  // sync
  | "synced"
  | "syncFailed"
  // any stage that was not needed on this boot
  | "notNeeded"

export interface MobileBootStageRecord {
  status: MobileBootStageStatus
  detail: MobileBootStageDetail | null
  /** When the stage began; `null` while pending or when skipped without running. */
  startedAt: number | null
  /** When the stage ended (done / failed / skipped); `null` until then. */
  completedAt: number | null
  /** Measured wall-clock time; `null` while running or when never run. */
  durationMs: number | null
}

export interface MobileBootSnapshot {
  stages: Readonly<Record<MobileBootStage, MobileBootStageRecord>>
  /** Stage currently running; `null` between stages. */
  active: MobileBootStage | null
  /** The boot outcome is known — the splash overlay may leave. */
  settled: boolean
  /** The splash overlay is currently painting over the app. */
  overlayVisible: boolean
  /** A mobile boot screen has played its entrance in this page load. */
  introPlayed: boolean
  /** Monotonic change counter. */
  version: number
}

export interface EndMobileBootStageOptions {
  status?: Extract<MobileBootStageStatus, "done" | "failed" | "skipped">
  detail?: MobileBootStageDetail | null
}

const PENDING: MobileBootStageRecord = Object.freeze({
  status: "pending",
  detail: null,
  startedAt: null,
  completedAt: null,
  durationMs: null,
})

function pendingStages(): Record<MobileBootStage, MobileBootStageRecord> {
  return { bridge: PENDING, companion: PENDING, host: PENDING, sync: PENDING }
}

const INITIAL_SNAPSHOT: MobileBootSnapshot = Object.freeze({
  stages: Object.freeze(pendingStages()),
  active: null,
  settled: false,
  overlayVisible: false,
  introPlayed: false,
  version: 0,
})

let snapshot: MobileBootSnapshot = INITIAL_SNAPSHOT
const listeners = new Set<() => void>()

export function mobileBootStageIndex(stage: MobileBootStage): number {
  return MOBILE_BOOT_STAGES.indexOf(stage)
}

function publish(next: Omit<MobileBootSnapshot, "version">): void {
  snapshot = { ...next, version: snapshot.version + 1 }
  for (const listener of listeners) listener()
}

/**
 * A stage starts. Idempotent for the stage already active. Beginning a stage
 * that has already ended (the provider's host bindings restarting after a
 * pairing change) reopens it and returns every later stage to pending, so the
 * timeline never shows a "done" that belongs to a previous run.
 */
export function beginMobileBootStage(stage: MobileBootStage, now: number = Date.now()): void {
  if (snapshot.active === stage) return
  const index = mobileBootStageIndex(stage)
  const stages = { ...snapshot.stages }
  for (const other of MOBILE_BOOT_STAGES) {
    if (mobileBootStageIndex(other) > index) stages[other] = PENDING
  }
  stages[stage] = {
    status: "active",
    detail: null,
    startedAt: now,
    completedAt: null,
    durationMs: null,
  }
  // Re-running a stage means the outcome is open again.
  const reopened = snapshot.stages[stage].status !== "pending"
  publish({
    ...snapshot,
    stages,
    active: stage,
    settled: reopened ? false : snapshot.settled,
  })
}

/**
 * A stage ends — `done` unless told otherwise. Ending a stage that never began
 * (a `skipped` host on a standalone phone) records the outcome without a
 * duration. Ending a stage that is not the active one leaves `active` alone,
 * so a late completion can't clobber a newer stage.
 */
export function endMobileBootStage(
  stage: MobileBootStage,
  options: EndMobileBootStageOptions = {},
  now: number = Date.now()
): void {
  const { status = "done", detail = null } = options
  const record = snapshot.stages[stage]
  const startedAt = record.startedAt
  publish({
    ...snapshot,
    active: snapshot.active === stage ? null : snapshot.active,
    stages: {
      ...snapshot.stages,
      [stage]: {
        status,
        detail: detail ?? (status === "skipped" ? "notNeeded" : null),
        startedAt,
        completedAt: now,
        durationMs: startedAt === null ? null : Math.max(0, now - startedAt),
      },
    },
  })
}

/** Convenience: mark every stage after `stage` as not needed on this boot. */
export function skipMobileBootStagesAfter(stage: MobileBootStage, now: number = Date.now()): void {
  const index = mobileBootStageIndex(stage)
  for (const other of MOBILE_BOOT_STAGES) {
    if (mobileBootStageIndex(other) > index && snapshot.stages[other].status === "pending") {
      endMobileBootStage(other, { status: "skipped" }, now)
    }
  }
}

/** The boot outcome is known; the splash overlay may leave. */
export function markMobileBootSettled(): void {
  if (snapshot.settled) return
  publish({ ...snapshot, settled: true })
}

/** Written by the splash overlay while it covers the app. */
export function setMobileBootOverlayVisible(visible: boolean): void {
  if (snapshot.overlayVisible === visible) return
  publish({ ...snapshot, overlayVisible: visible })
}

/** Called once a mobile boot screen has started the entrance for this page load. */
export function markMobileBootIntroPlayed(): void {
  if (snapshot.introPlayed) return
  publish({ ...snapshot, introPlayed: true })
}

export function subscribeMobileBoot(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Stable-identity snapshot for `useSyncExternalStore`. */
export function getMobileBootSnapshot(): MobileBootSnapshot {
  return snapshot
}

/** Server / hydration snapshot: nothing has begun. */
export function getServerMobileBootSnapshot(): MobileBootSnapshot {
  return INITIAL_SNAPSHOT
}

export function __resetMobileBootForTesting(): void {
  snapshot = INITIAL_SNAPSHOT
  for (const listener of listeners) listener()
}
