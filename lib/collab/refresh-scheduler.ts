"use client"

import { refreshCollabPlaneQuietly, type RefreshCollabPlaneResult } from "./refresh"

export const COLLAB_REFRESH_INTERVAL_MS = 60_000
export const COLLAB_REFRESH_MAX_BACKOFF_MS = 15 * 60_000
export const COLLAB_REFRESH_STALE_AFTER_MS = 5 * 60_000

export interface CollabRefreshState {
  lastSuccessAt: number | null
  lastAttemptAt: number | null
  failures: number
  inFlight: boolean
}

const states = new Map<string, CollabRefreshState>()
const inFlight = new Map<string, Promise<RefreshCollabPlaneResult | null>>()
const listeners = new Set<() => void>()
const EMPTY_REFRESH_STATE: CollabRefreshState = {
  lastSuccessAt: null,
  lastAttemptAt: null,
  failures: 0,
  inFlight: false,
}

function setRefreshState(localAccountId: string, state: CollabRefreshState): void {
  states.set(localAccountId, state)
  for (const listener of listeners) listener()
}

export function subscribeCollabRefreshState(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getCollabRefreshState(localAccountId: string): CollabRefreshState {
  return states.get(localAccountId) ?? EMPTY_REFRESH_STATE
}

/**
 * Stale means "the mirror is not known to be current", so a plane that has
 * never refreshed in this session counts as stale the moment an attempt has
 * failed. `lastSuccessAt` is in-memory and resets on every reload, so treating
 * a null as fresh hid the badge exactly when the mirror was oldest. A run that
 * has not attempted anything yet is still reported fresh — there is nothing to
 * warn about before the scheduler's first tick.
 */
export function isCollabRefreshStale(localAccountId: string, now = Date.now()): boolean {
  const { lastSuccessAt, lastAttemptAt, failures, inFlight } = getCollabRefreshState(localAccountId)
  if (lastSuccessAt === null) return lastAttemptAt !== null && !inFlight && failures > 0
  return now - lastSuccessAt > COLLAB_REFRESH_STALE_AFTER_MS
}

export async function requestCollabRefresh(
  localAccountId: string,
  refresh: (localAccountId: string) => Promise<RefreshCollabPlaneResult | null> = (id) =>
    refreshCollabPlaneQuietly({ localAccountId: id }),
  now: () => number = Date.now
): Promise<RefreshCollabPlaneResult | null> {
  const active = inFlight.get(localAccountId)
  if (active) return active
  const previous = getCollabRefreshState(localAccountId)
  setRefreshState(localAccountId, { ...previous, lastAttemptAt: now(), inFlight: true })
  const promise = refresh(localAccountId)
    .then((result) => {
      const current = getCollabRefreshState(localAccountId)
      if (result?.status === "refreshed") {
        setRefreshState(localAccountId, {
          lastAttemptAt: current.lastAttemptAt,
          lastSuccessAt: now(),
          failures: 0,
          inFlight: false,
        })
      } else {
        setRefreshState(localAccountId, { ...current, inFlight: false })
      }
      return result
    })
    .catch(() => {
      const current = getCollabRefreshState(localAccountId)
      setRefreshState(localAccountId, {
        ...current,
        failures: current.failures + 1,
        inFlight: false,
      })
      return null
    })
    .finally(() => inFlight.delete(localAccountId))
  inFlight.set(localAccountId, promise)
  return promise
}

/**
 * The refresh already running for this profile, if any. The change feed waits
 * on it before starting its own: a refresh that began before a frame arrived
 * may not include the change the frame announces.
 */
export function collabRefreshInFlight(
  localAccountId: string
): Promise<RefreshCollabPlaneResult | null> | undefined {
  return inFlight.get(localAccountId)
}

/**
 * Profiles whose change feed is connected (ADR-0206). While it is, the timed
 * poll stands down; focus, online and visibility still refresh, which is what
 * catches up anything missed while the socket was down.
 */
const liveFeeds = new Set<string>()

export function setCollabFeedLive(localAccountId: string, live: boolean): void {
  if (live) liveFeeds.add(localAccountId)
  else liveFeeds.delete(localAccountId)
}

export function isCollabFeedLive(localAccountId: string): boolean {
  return liveFeeds.has(localAccountId)
}

export function collabRefreshDelay(failures: number): number {
  return Math.min(
    COLLAB_REFRESH_MAX_BACKOFF_MS,
    COLLAB_REFRESH_INTERVAL_MS * 2 ** Math.max(0, failures)
  )
}

export function installCollabRefreshScheduler(
  localAccountId: string,
  deps: {
    refresh?: (localAccountId: string) => Promise<RefreshCollabPlaneResult | null>
    window?: Pick<
      Window,
      "addEventListener" | "removeEventListener" | "setTimeout" | "clearTimeout"
    >
    document?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">
    /** Whether a live change feed makes the timed poll redundant. */
    feedLive?: () => boolean
  } = {}
): () => void {
  const windowRef = deps.window ?? (typeof window === "undefined" ? undefined : window)
  const documentRef = deps.document ?? (typeof document === "undefined" ? undefined : document)
  if (!windowRef || !documentRef) return () => {}
  const feedLive = deps.feedLive ?? (() => isCollabFeedLive(localAccountId))
  let stopped = false
  let timer: number | undefined
  const schedule = () => {
    if (stopped) return
    if (timer !== undefined) windowRef.clearTimeout(timer)
    timer = windowRef.setTimeout(
      tick,
      collabRefreshDelay(getCollabRefreshState(localAccountId).failures)
    )
  }
  // The timed poll only. A live feed already says when something changed.
  const tick = () => {
    if (feedLive()) {
      schedule()
      return
    }
    run()
  }
  const run = () => {
    if (stopped || documentRef.visibilityState !== "visible") {
      schedule()
      return
    }
    void requestCollabRefresh(localAccountId, deps.refresh).finally(schedule)
  }
  const onVisible = () => {
    if (documentRef.visibilityState === "visible") run()
  }
  windowRef.addEventListener("focus", run)
  windowRef.addEventListener("online", run)
  documentRef.addEventListener("visibilitychange", onVisible)
  schedule()
  return () => {
    stopped = true
    if (timer !== undefined) windowRef.clearTimeout(timer)
    windowRef.removeEventListener("focus", run)
    windowRef.removeEventListener("online", run)
    documentRef.removeEventListener("visibilitychange", onVisible)
  }
}
