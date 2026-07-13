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
 * — that nothing else listened to. A minimum-away threshold keeps a brief tab
 * switch from churning healthy sockets, and a short cooldown de-dupes the
 * near-simultaneous `online` + `visible` pair a real wake produces.
 */

import { listRunningAdapters, requeueAdapter } from "@/lib/connectors/lifecycle"
import { appendAudit } from "@/lib/connectors/audit"

/** Only a wake after this much time away heals sockets — shorter gaps (a quick
 * tab switch) don't justify tearing every transport down and back up. */
export const DEFAULT_MIN_AWAY_MS = 30_000
/** A real resume fires `online` and `visibilitychange` almost together; this
 * window collapses that pair into a single reconnect burst. */
export const DEFAULT_RECONNECT_COOLDOWN_MS = 5_000

interface ListenerTarget {
  addEventListener: (type: string, cb: () => void) => void
  removeEventListener: (type: string, cb: () => void) => void
}

export interface ResumeReconnectOptions {
  /** Minimum away time before a wake triggers a requeue. Default 30 s. */
  minAwayMs?: number
  /** Cooldown between reconnect bursts (dedupes online+visible). Default 5 s. */
  cooldownMs?: number
  /** Running-adapter source (default: lifecycle registry). Test seam. */
  listAdapters?: () => { adapter: { id: string } }[]
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

  if (!windowTarget && !documentTarget) {
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
