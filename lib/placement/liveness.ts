/**
 * One answer to "is this candidate actually reachable right now?".
 *
 * The codebase grew four independent notions of online, and two of them were
 * simply wrong:
 *
 *   * a live socket (`ws_worker.rs`) — the only one with a timeout;
 *   * the timestamp of the last authenticated request (`pairedDevices.lastSeenAt`);
 *   * a version-matched feature manifest (`remote-host-store.ts`);
 *   * unconditionally true — which is what `action.mobile.*` and the workflow
 *     capability preflight used, so a phone last seen three days ago was
 *     selected, dispatched to, and blocked for two minutes before failing.
 *
 * The distinction that matters is not *where* the signal came from but whether
 * it proves presence now. A socket does. A timestamp only does inside a window,
 * and that window has to be the same one the host uses to decide a worker went
 * idle, or the two sides disagree about who is online.
 */

/** Must match `IDLE_TIMEOUT_SECS` in `src-tauri/src/companion_api/ws_worker.rs`. */
export const DEFAULT_LIVENESS_TTL_MS = 90_000

export type LivenessSource =
  /** A connection is open right now. Presence is proven, not inferred. */
  | "socket"
  /** Last authenticated request from this peer. Trusted for a TTL. */
  | "request"
  /** Last capability/feature manifest exchange. Trusted for a TTL. */
  | "manifest"
  /** This process. Always live. */
  | "local"

export interface PlacementLiveness {
  /** What the source itself claims. Authoritative only for `socket`. */
  online: boolean
  /** Epoch ms of the most recent evidence. */
  lastSeenAt: number
  source: LivenessSource
}

export interface LivenessPolicy {
  /** How long a timestamp-based signal stays trustworthy. */
  ttlMs?: number
  /**
   * Treat a `request`/`manifest` peer with no timestamp at all as live.
   *
   * Off by default: "we have never seen this peer" must not read as "this peer
   * is here". A caller migrating legacy rows that predate `lastSeenAt` can opt
   * in explicitly rather than having the default lie for it.
   */
  trustUnknownTimestamps?: boolean
}

export function isPlaceable(
  liveness: PlacementLiveness,
  now: number,
  policy: LivenessPolicy = {}
): boolean {
  if (liveness.source === "local") return true
  if (!liveness.online) return false
  if (liveness.source === "socket") return true
  const ttlMs = policy.ttlMs ?? DEFAULT_LIVENESS_TTL_MS
  if (!Number.isFinite(liveness.lastSeenAt) || liveness.lastSeenAt <= 0) {
    return policy.trustUnknownTimestamps === true
  }
  // A clock-skewed peer reporting the future is still evidence of presence;
  // refusing it would strand a whole machine over a few seconds of NTP drift.
  const age = now - liveness.lastSeenAt
  return age <= ttlMs
}

/** How stale the evidence is, for diagnostics. Negative means clock skew. */
export function livenessAgeMs(liveness: PlacementLiveness, now: number): number {
  return now - liveness.lastSeenAt
}
