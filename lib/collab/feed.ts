"use client"

/**
 * The client half of the workspace change feed (ADR-0206).
 *
 * The server pushes invalidations (`{entity, id, workspaceId, revision}`), never
 * rows. Each one names a refresh leg; frames are coalesced for
 * {@link FEED_COALESCE_MS} and then drive `refreshCollabPlane` for just those
 * legs, through `requestCollabRefresh` so the stale badge and failure backoff
 * see it like any other refresh. The mirrors keep their single write path.
 *
 * While the socket is open the timed poll stands down (`setCollabFeedLive`).
 * When it closes the poll resumes, one full refresh catches up whatever was
 * missed, and the socket reconnects with capped backoff. A server without the
 * feed answers 404 on the ticket mint; the client then keeps polling and does
 * not ask again until the next install.
 *
 * `notification` frames (ADR-0207) name no leg. They carry no content either,
 * only "this person has something new or newly read", so the feed hands them
 * to the notification sync (`lib/collab/notifications-sync.ts`) through
 * {@link subscribeCollabNotificationSignals}, which pulls. Every successful
 * (re)connect is a signal too: frames sent while the socket was down reached
 * nobody.
 */

import { loggers } from "@cognia/logging"

import type { PlatformWebSocket } from "@/lib/network/platform-websocket"

import { CollabError, type CollabClient } from "./client"
import {
  ALL_COLLAB_REFRESH_LEGS,
  refreshCollabPlaneQuietly,
  resolveCollabClient,
  type CollabRefreshLeg,
  type RefreshCollabPlaneDeps,
  type RefreshCollabPlaneResult,
} from "./refresh"
import { collabRefreshInFlight, requestCollabRefresh, setCollabFeedLive } from "./refresh-scheduler"

const log = loggers.shell

export const FEED_COALESCE_MS = 250
export const FEED_RECONNECT_BASE_MS = 1_000
export const FEED_RECONNECT_MAX_MS = 60_000

export type FeedEntity = "issue" | "issue_event" | "plan" | "run" | "workspace" | "membership"

export type FeedFrame =
  | {
      kind: "invalidate"
      entity: FeedEntity
      id: string
      workspaceId?: string
      revision?: number
      userId?: string
    }
  | { kind: "notification"; recipientUserId: string; seq: number }
  | { kind: "resync" }

/**
 * Which legs a frame invalidates. A membership change can reveal or hide rows
 * in every leg, so it refreshes all of them; `null` means the frame refreshes
 * no mirror leg (a `notification` frame goes to the notification sync instead,
 * and an unknown kind goes nowhere).
 */
export function legsForFrame(frame: FeedFrame): readonly CollabRefreshLeg[] | null {
  if (frame.kind === "resync") return ALL_COLLAB_REFRESH_LEGS
  if (frame.kind !== "invalidate") return null
  switch (frame.entity) {
    case "issue":
    case "issue_event":
      return ["issues"]
    case "plan":
    case "run":
      return ["activity"]
    case "workspace":
      return ["workspaces"]
    case "membership":
      return ALL_COLLAB_REFRESH_LEGS
    default:
      return null
  }
}

/** Parse one text frame; anything malformed or unknown is `null`. */
export function parseFeedFrame(data: string): FeedFrame | null {
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    return null
  }
  if (!value || typeof value !== "object") return null
  const frame = value as Record<string, unknown>
  switch (frame.kind) {
    case "resync":
      return { kind: "resync" }
    case "notification":
      return typeof frame.recipientUserId === "string" && typeof frame.seq === "number"
        ? { kind: "notification", recipientUserId: frame.recipientUserId, seq: frame.seq }
        : null
    case "invalidate":
      return typeof frame.entity === "string" && typeof frame.id === "string"
        ? (frame as unknown as FeedFrame)
        : null
    default:
      return null
  }
}

export function feedReconnectDelay(attempt: number): number {
  return Math.min(FEED_RECONNECT_MAX_MS, FEED_RECONNECT_BASE_MS * 2 ** Math.max(0, attempt))
}

/**
 * What the feed tells the notification sync (ADR-0207): a `notification` frame
 * arrived, or the socket (re)connected and anything sent while it was down has
 * to be pulled.
 */
export type CollabNotificationSignal =
  { reason: "frame"; recipientUserId: string; seq: number } | { reason: "connected" }

type CollabNotificationListener = (signal: CollabNotificationSignal) => void

const notificationListeners = new Map<string, Set<CollabNotificationListener>>()

/**
 * Hear this profile's notification signals. The feed and the notification sync
 * are installed independently (each rebinds on its own), so they meet here
 * rather than through a reference one holds to the other.
 */
export function subscribeCollabNotificationSignals(
  localAccountId: string,
  listener: CollabNotificationListener
): () => void {
  let listeners = notificationListeners.get(localAccountId)
  if (!listeners) {
    listeners = new Set()
    notificationListeners.set(localAccountId, listeners)
  }
  listeners.add(listener)
  return () => {
    const current = notificationListeners.get(localAccountId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) notificationListeners.delete(localAccountId)
  }
}

/** Deliver one signal to this profile's subscribers. A throwing one never stops the rest. */
export function publishCollabNotificationSignal(
  localAccountId: string,
  signal: CollabNotificationSignal
): void {
  for (const listener of [...(notificationListeners.get(localAccountId) ?? [])]) {
    try {
      listener(signal)
    } catch (error) {
      log.warn("collab feed: a notification subscriber threw", { error: String(error) })
    }
  }
}

export interface CollabFeedDeps {
  /** Resolve the client and org; defaults to the refresh's own resolution. */
  resolve?: () => Promise<{ client: CollabClient; orgId: string } | null>
  /** Refresh the given legs; defaults to `refreshCollabPlaneQuietly`. */
  refreshLegs?: (
    localAccountId: string,
    legs: readonly CollabRefreshLeg[]
  ) => Promise<RefreshCollabPlaneResult | null>
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
  refreshDeps?: Omit<RefreshCollabPlaneDeps, "legs" | "localAccountId">
  /**
   * Where notification signals go (ADR-0207); defaults to
   * {@link publishCollabNotificationSignal} for this profile.
   */
  onNotification?: (signal: CollabNotificationSignal) => void
}

/**
 * Keep this profile's change feed connected until the returned function is
 * called. Safe to call when collaboration is not configured: it resolves to
 * nothing and the poll carries on alone.
 */
export function installCollabFeed(localAccountId: string, deps: CollabFeedDeps = {}): () => void {
  const setTimer = deps.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms))
  const clearTimer =
    deps.clearTimeout ??
    ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>))
  const resolve =
    deps.resolve ??
    (async () => {
      const resolved = await resolveCollabClient({ ...deps.refreshDeps, localAccountId })
      return resolved.status === "ready"
        ? { client: resolved.client, orgId: resolved.binding.orgId }
        : null
    })
  const onNotification =
    deps.onNotification ??
    ((signal: CollabNotificationSignal) => publishCollabNotificationSignal(localAccountId, signal))
  const refreshLegs =
    deps.refreshLegs ??
    ((id, legs) =>
      refreshCollabPlaneQuietly({ ...deps.refreshDeps, localAccountId: id, legs: [...legs] }))

  let stopped = false
  let socket: PlatformWebSocket | null = null
  let reconnectTimer: unknown = null
  let coalesceTimer: unknown = null
  let attempt = 0
  const pending = new Set<CollabRefreshLeg>()
  let draining: Promise<void> | null = null

  const drain = async () => {
    while (pending.size > 0 && !stopped) {
      // A refresh that started before these frames may predate the changes
      // they announce, so wait it out and then run one of our own.
      const running = collabRefreshInFlight(localAccountId)
      if (running) await running.catch(() => null)
      const legs = [...pending]
      pending.clear()
      await requestCollabRefresh(localAccountId, (id) => refreshLegs(id, legs))
    }
  }

  const invalidate = (legs: readonly CollabRefreshLeg[]) => {
    for (const leg of legs) pending.add(leg)
    if (coalesceTimer !== null) return
    coalesceTimer = setTimer(() => {
      coalesceTimer = null
      if (draining) return
      draining = drain().finally(() => {
        draining = null
        // Frames that arrived during the last pass started no timer of their
        // own while `draining` was set; pick them up now.
        if (pending.size > 0 && !stopped) invalidate([])
      })
    }, FEED_COALESCE_MS)
  }

  const scheduleReconnect = () => {
    if (stopped) return
    const delay = feedReconnectDelay(attempt)
    attempt += 1
    reconnectTimer = setTimer(() => {
      reconnectTimer = null
      void connect()
    }, delay)
  }

  const onClosed = () => {
    socket = null
    setCollabFeedLive(localAccountId, false)
    if (stopped) return
    // Whatever changed while the socket was down reached nobody.
    invalidate(ALL_COLLAB_REFRESH_LEGS)
    scheduleReconnect()
  }

  const connect = async () => {
    if (stopped) return
    let target: { client: CollabClient; orgId: string } | null
    try {
      target = await resolve()
    } catch (error) {
      log.warn("collab feed: could not resolve the plane", { error: String(error) })
      scheduleReconnect()
      return
    }
    if (!target || stopped) return
    try {
      const opened = await target.client.openWorkspaceFeed(target.orgId, {
        onMessage: (data) => {
          const frame = parseFeedFrame(data)
          if (!frame) return
          if (frame.kind === "notification") {
            onNotification({
              reason: "frame",
              recipientUserId: frame.recipientUserId,
              seq: frame.seq,
            })
            return
          }
          const legs = legsForFrame(frame)
          if (legs) invalidate(legs)
        },
        onClose: onClosed,
      })
      if (stopped) {
        void opened.close()
        return
      }
      socket = opened
      attempt = 0
      setCollabFeedLive(localAccountId, true)
      onNotification({ reason: "connected" })
    } catch (error) {
      if (error instanceof CollabError && error.status === 404) {
        // No feed on this server: poll, and do not ask again this session.
        log.info("collab feed: server has no change feed; polling only")
        return
      }
      log.warn("collab feed: connect failed", { error: String(error) })
      scheduleReconnect()
    }
  }

  void connect()

  return () => {
    stopped = true
    setCollabFeedLive(localAccountId, false)
    if (reconnectTimer !== null) clearTimer(reconnectTimer)
    if (coalesceTimer !== null) clearTimer(coalesceTimer)
    pending.clear()
    const open = socket
    socket = null
    if (open) void open.close()
  }
}
