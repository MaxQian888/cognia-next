/**
 * Resume-reconnect watcher (G3).
 *
 * Long-lived connector transports (Discord / QQ / Slack / DingTalk gateways,
 * Lark long-conn) keep a WebSocket open for their entire life. When the OS
 * sleeps or the network drops, that socket goes *half-open*: the local end
 * still looks connected, but no frames flow and — because the gateway clients
 * do not track heartbeat ACKs — nothing self-detects the death. The only
 * recovery path was the underlying Rust WS layer eventually emitting `/close`,
 * which can lag far past wake, silently dropping inbound messages while the
 * Health view still shows green.
 *
 * This watcher closes that gap the same way every other reconnect entry point
 * does: it re-queues the running adapters through `requeueAdapter` (identical
 * to "Reconnect now" and the credentials-rotated auto-requeue), but triggered
 * by the OS/browser resume signals — `online` and `visibilitychange → visible`
 * — that nothing else listened to. Two guards keep it from churning healthy
 * sockets on an ordinary desktop focus change: a minimum-away threshold sized
 * for a real suspend (not a brief switch), and a per-adapter health check that
 * skips any transport still delivering traffic (only a maybe-half-open one is
 * requeued). A short cooldown de-dupes the near-simultaneous `online` +
 * `visible` pair a real wake produces.
 */

import { listRunningAdapters, requeueAdapter } from "@/lib/connectors/lifecycle"
import { appendAudit } from "@/lib/connectors/audit"
import type { AdapterHealth } from "@/types/connectors/adapter"

/** Only a wake after this much *continuous* time away heals sockets. Sized for a
 * real OS suspend / long outage — NOT an ordinary desktop focus change. A
 * shorter network drop tears the TCP connection and is already healed by the
 * transport's own backoff (Rust `lark_ws` logs `connection ended` and re-dials);
 * resume-reconnect exists only for the HALF-OPEN case a suspend produces (socket
 * looks alive, no frames flow), which in practice follows a multi-minute away.
 * Was 30 s, which churned healthy connections on every brief window switch. */
export const DEFAULT_MIN_AWAY_MS = 300_000
/** A wake only requeues an adapter that might have gone half-open. One that is
 * `running` and delivered traffic within this window is provably alive (a hidden
 * window still receives inbound), so it is skipped instead of torn down —
 * avoiding a message-loss reconnect window on a self-healing transport like the
 * Lark long-conn. */
export const DEFAULT_ACTIVITY_FRESH_MS = 60_000
/** A real resume fires `online` and `visibilitychange` almost together; this
 * window collapses that pair into a single reconnect burst. */
export const DEFAULT_RECONNECT_COOLDOWN_MS = 5_000

interface ListenerTarget {
  addEventListener: (type: string, cb: () => void) => void
  removeEventListener: (type: string, cb: () => void) => void
}

export interface ResumeReconnectOptions {
  /** Minimum away time before a wake triggers a requeue. Default 5 min. */
  minAwayMs?: number
  /** Cooldown between reconnect bursts (dedupes online+visible). Default 5 s. */
  cooldownMs?: number
  /**
   * Skip requeue for a `running` adapter whose last activity is within this
   * window (provably alive). Default 60 s.
   */
  activityFreshMs?: number
  /** Running-adapter source (default: lifecycle registry). Test seam. */
  listAdapters?: () => { adapter: { id: string; health?: () => AdapterHealth } }[]
  /** Requeue one adapter (default: lifecycle `requeueAdapter`). Test seam. */
  requeue?: (adapterId: string) => Promise<boolean>
  /** Audit sink (default: `appendAudit`). Test seam. */
  audit?: (adapterId: string, reason: "online" | "visible", awayMs: number) => void
  /** Clock (default: `Date.now`). Test seam. */
  now?: () => number
  /** `online`/`offline` source (default: `window`). Test seam. */
  windowTarget?: ListenerTarget
  /** `visibilitychange` source (default: `document`). Test seam. */
  documentTarget?: ListenerTarget
  /** Is the page currently hidden? (default: `document.hidden`). Test seam. */
  isHidden?: () => boolean
  /** Is the network currently offline? (default: `!navigator.onLine`). Test seam. */
  isOffline?: () => boolean
}

export interface ResumeReconnectHandle {
  /** Stop watching. Idempotent. */
  dispose(): void
}

/**
 * Start the resume-reconnect watcher. Returns a disposer the caller must invoke
 * on teardown. No-op (returns an inert handle) when there is no DOM to listen
 * on (SSR / node tests without seams).
 */
export function startResumeReconnect(options: ResumeReconnectOptions = {}): ResumeReconnectHandle {
  const {
    minAwayMs = DEFAULT_MIN_AWAY_MS,
    cooldownMs = DEFAULT_RECONNECT_COOLDOWN_MS,
    activityFreshMs = DEFAULT_ACTIVITY_FRESH_MS,
    listAdapters = listRunningAdapters,
    requeue = requeueAdapter,
    now = Date.now,
    windowTarget = typeof window !== "undefined" ? window : undefined,
    documentTarget = typeof document !== "undefined" ? document : undefined,
    isHidden = () => (typeof document !== "undefined" ? document.hidden : false),
    isOffline = () => (typeof navigator !== "undefined" ? !navigator.onLine : false),
    audit = (adapterId, reason, awayMs) => {
      void appendAudit({
        adapterId,
        kind: "adapter.resumed",
        at: now(),
        fields: { reason, awayMs },
      }).catch(() => undefined)
    },
  } = options

  if (
    (!windowTarget && !documentTarget) ||
    (windowTarget && typeof windowTarget.addEventListener !== "function") ||
    (documentTarget && typeof documentTarget.addEventListener !== "function")
  ) {
    return { dispose() {} }
  }

  let disposed = false
  // When the app first went away (hidden or offline). null = currently present.
  let awaySince: number | null = isHidden() || isOffline() ? now() : null
  let lastReconnectAt = 0

  const markAway = () => {
    if (awaySince === null) awaySince = now()
  }

  const maybeReconnect = (reason: "online" | "visible") => {
    if (disposed) return
    // Still not actually back (e.g. `online` fired while the tab is hidden, or
    // `visible` fired while still offline) — wait for the real all-clear.
    if (isHidden() || isOffline()) return
    const at = now()
    const awayMs = awaySince === null ? 0 : at - awaySince
    awaySince = null
    if (awayMs < minAwayMs) return
    if (at - lastReconnectAt < cooldownMs) return
    lastReconnectAt = at

    for (const entry of listAdapters()) {
      const adapterId = entry.adapter.id
      // Only requeue a transport that might have gone half-open. One that is
      // still `running` and delivered traffic within `activityFreshMs` is
      // provably alive (a hidden window still receives inbound), so tearing it
      // down would only open a message-loss window on a self-healing socket.
      const health = entry.adapter.health?.()
      if (
        health?.state === "running" &&
        health.lastActivityAt != null &&
        at - health.lastActivityAt < activityFreshMs
      ) {
        continue
      }
      void Promise.resolve(requeue(adapterId))
        .then((ok) => {
          if (ok) audit(adapterId, reason, awayMs)
        })
        .catch(() => undefined)
    }
  }

  const onOnline = () => maybeReconnect("online")
  const onOffline = () => markAway()
  const onVisibility = () => {
    if (isHidden()) markAway()
    else maybeReconnect("visible")
  }

  windowTarget?.addEventListener("online", onOnline)
  windowTarget?.addEventListener("offline", onOffline)
  documentTarget?.addEventListener("visibilitychange", onVisibility)

  return {
    dispose() {
      if (disposed) return
      disposed = true
      windowTarget?.removeEventListener("online", onOnline)
      windowTarget?.removeEventListener("offline", onOffline)
      documentTarget?.removeEventListener("visibilitychange", onVisibility)
    },
  }
}
