"use client"

/**
 * Remote Session Control — host-side attach façade + approval backstop.
 *
 * When a remote device opens a session viewer it calls the `session_attach`
 * RPC; on close / navigate-away it calls `session_detach`. Both land in
 * `lib/companion/desktop-write-source.ts`. `hooks/chat/claude-chat-events.ts`
 * consults `isSessionAttached` so a `permission_request` for a session that is
 * NOT the desktop's foreground session is **routed to the attached remote
 * device** (which already received the frame over its event stream and will
 * call `claude_approve`) instead of being auto-denied with "session not
 * active".
 *
 * The attachment state itself lives in `device-presence-registry.ts`. It used
 * to live here as a bare `sessionId → Set<deviceId>` map, which had two holes:
 * nothing ever expired, so a phone that lost its socket kept collecting
 * approval prompts forever; and `detachDevice` — the only way to clear a
 * device-level disconnect — was exported but never called from anywhere. Leases
 * close the first (and `sweepExpiredLeases` now runs off each renewal, so
 * lapsed entries are removed rather than merely filtered out on read);
 * `installCompanionEventBridge` closes the second by calling `detachDevice` on
 * `companion://device-lifecycle`. This module now keeps only what is genuinely
 * local to approvals: the mode decision, and the backstop timers.
 *
 * Because the sidecar's `canUseTool` has no timeout of its own (see
 * `sidecar/dispatch/anthropic.mjs`), an un-answered approval would hang the
 * turn forever. `armApprovalBackstop` schedules a renderer-side deny that
 * fires only if the remote never responds; `clearApprovalBackstops` cancels it
 * the moment the turn proceeds (next SDK event) or ends.
 */

import {
  __resetDevicePresenceForTests,
  attachSessionLease,
  attachedDeviceIds as presenceAttachedDeviceIds,
  deviceEventStreams,
  eventPlaneState,
  hasControlLease,
  notifiableControllers as presenceNotifiableControllers,
  readyEventStreamLeaseId,
  releaseDevice,
  releaseSessionLease,
  renewSessionLease,
  sessionLeaseFor,
  setDeviceAttention,
  syncEventStreams,
  type AttachMode,
  type DeviceAttention,
  type EventPlaneState,
  type EventStreamConnection,
} from "./device-presence-registry"

/**
 * The capability a device must hold to take a **control** attachment.
 *
 * `workspace.write` is what `GrantKind::Control` — the paired-devices "remote
 * control" toggle — maps onto. Deliberately NOT `agent.run`: every freshly
 * paired member device is granted `agent.run` by `insert_default_grants`, so
 * keying control off it would hand every phone the steering wheel the moment it
 * paired.
 */
export const REMOTE_CONTROL_CAPABILITY = "workspace.write"

/** sessionId → (requestId → backstop timer handle). */
const backstops = new Map<string, Map<string, ReturnType<typeof setTimeout>>>()

/** Default backstop window. Generous so a human has time to act on the phone;
 *  it only fires when the remote never answers (e.g. the device dropped). */
export const DEFAULT_APPROVAL_BACKSTOP_MS = 120_000

/** Why an attachment that asked for control did not get it. `null` when it did,
 *  or when it never asked. */
export type AttachDowngradeReason = "missing-capability" | "event-plane-not-ready"

export interface AttachSessionOptions {
  /**
   * What the client asked for. Absent means `control`: that is what every
   * client did before the mode existed, and silently demoting them to a
   * read-only view would be a worse default than refusing the ones that turn
   * out to be unauthorized.
   */
  requestedMode?: AttachMode
  /**
   * The caller's live event-plane streams, exactly as the RPC boundary
   * reported them (`callerEventStreams`, minted in
   * `src-tauri/src/companion_api/event_leases.rs`). Server-bound on purpose: a
   * self-asserted value would let a device claim it can hear a run it has no
   * stream for.
   */
  eventStreams: readonly EventStreamConnection[]
  /**
   * The caller's capability grants, as the RPC boundary read them out of the
   * SecurityStore. Also server-bound, for the same reason.
   */
  grants: readonly string[]
  /**
   * Whether the user is actually looking at the device, as the device reports
   * it. Self-asserted on purpose and deliberately NOT server-bound: it decides
   * only whether a *notification* is suppressed, never what the device may do,
   * and no other party can observe it. Lying costs the liar a duplicate alert
   * or a missing one. Absent means `unknown`, which suppresses nothing.
   */
  attention?: DeviceAttention
  now?: number
}

export interface AttachSessionResult {
  /** The mode actually granted, which may be narrower than the one asked for. */
  mode: AttachMode
  /** Set when `requestedMode` was `control` and the answer is `observe`. */
  downgradeReason: AttachDowngradeReason | null
  /** The device's derived event-plane state after this call. */
  eventPlane: EventPlaneState
}

/**
 * Record that `deviceId` is watching `sessionId`, and return the mode it
 * actually got. Idempotent — re-attaching renews the lease, which is how a
 * client keeps its attachment alive across the TTL.
 *
 * Control needs three things at once, and the caller gets `observe` if any is
 * missing: the request, the capability, and a caught-up event stream. The third
 * is the one that is easy to forget — a device that can reach the RPC endpoint
 * but whose stream is dead or still replaying can *ask* for things without
 * *hearing* what happens, which is exactly the state in which steering a run is
 * dangerous.
 */
export function attachSession(
  sessionId: string,
  deviceId: string,
  options: AttachSessionOptions
): AttachSessionResult {
  const now = options.now ?? Date.now()
  syncEventStreams({ deviceId, streams: options.eventStreams, at: now })
  setDeviceAttention(deviceId, options.attention ?? "unknown", now)

  const requested: AttachMode = options.requestedMode ?? "control"
  const readyLeaseId = readyEventStreamLeaseId(deviceId)
  const mayControl = options.grants.includes(REMOTE_CONTROL_CAPABILITY)
  const existing = sessionLeaseFor(sessionId, deviceId, now)

  // A renewal arriving mid-reconnect must not demote a controller. The lease
  // has a TTL precisely so a device survives network churn without re-earning
  // its authority; downgrading it here would hand the session to nobody and
  // make the approval router auto-deny prompts meant for a device that is
  // seconds from being back. Losing the *capability* is different — that is a
  // decision someone made, not churn, so it still demotes immediately.
  if (requested === "control" && mayControl && readyLeaseId === null) {
    if (existing?.mode === "control") {
      renewSessionLease({ sessionId, deviceId, at: now })
      return { mode: "control", downgradeReason: null, eventPlane: eventPlaneState(deviceId) }
    }
  }

  let mode: AttachMode = "observe"
  let downgradeReason: AttachDowngradeReason | null = null
  if (requested === "control") {
    if (!mayControl) downgradeReason = "missing-capability"
    else if (readyLeaseId === null) downgradeReason = "event-plane-not-ready"
    else mode = "control"
  }

  // An observer binds to whatever stream it has, so its attachment names a real
  // channel too. With no stream at all there is nothing to bind to and nothing
  // to route, so the device holds no attachment: a poll-only client reads the
  // transcript through `host_state_snapshot` and needs none. Releasing rather
  // than leaving the old one is what stops a device that dropped every stream
  // AND lost its control lease from lingering as a watcher forever.
  const bindTo = mode === "control" ? readyLeaseId : (oldestStreamLeaseId(deviceId) ?? null)
  if (bindTo !== null) {
    attachSessionLease({ sessionId, deviceId, mode, eventStreamLeaseId: bindTo, at: now })
  } else {
    releaseSessionLease(sessionId, deviceId)
  }

  return { mode, downgradeReason, eventPlane: eventPlaneState(deviceId) }
}

function oldestStreamLeaseId(deviceId: string): string | undefined {
  return deviceEventStreams(deviceId)[0]?.leaseId
}

/** Record that `deviceId` stopped watching `sessionId`. Idempotent. */
export function detachSession(sessionId: string, deviceId: string): void {
  releaseSessionLease(sessionId, deviceId)
}

/** Drop `deviceId` from every session it was watching. Use on a device-level
 *  disconnect or a revoked grant so stale attachments don't keep approvals
 *  pending. */
export function detachDevice(deviceId: string): void {
  releaseDevice(deviceId)
}

/**
 * True when some remote device holds a live **control** lease on `sessionId` —
 * i.e. when there is somebody who can actually answer a prompt.
 *
 * Observers are excluded deliberately. Counting one would hold a decision open
 * for a device that is only allowed to watch it, and the turn would sit blocked
 * until the backstop denied it.
 */
export function isSessionAttached(sessionId: string, now: number = Date.now()): boolean {
  return hasControlLease(sessionId, now)
}

/** The deviceIds currently watching `sessionId`, in either mode (empty when
 *  none). Presence, not authority. */
export function attachedDeviceIds(sessionId: string, now: number = Date.now()): string[] {
  return presenceAttachedDeviceIds(sessionId, now)
}

/**
 * The devices that should be woken by an out-of-band push for a decision on
 * `sessionId` — control attachments only, minus any device already looking at
 * a live stream. See `notifiableControllers` for why each exclusion is there.
 */
export function approvalPushTargets(sessionId: string, now: number = Date.now()): string[] {
  return presenceNotifiableControllers(sessionId, now)
}

/**
 * Schedule a backstop deny for a pending remote approval. Fires `onTimeout`
 * after `timeoutMs` unless `clearApprovalBackstops(sessionId)` cancels it
 * first. Re-arming the same `(sessionId, requestId)` replaces the prior timer.
 */
export function armApprovalBackstop(
  sessionId: string,
  requestId: string,
  onTimeout: () => void,
  timeoutMs: number = DEFAULT_APPROVAL_BACKSTOP_MS
): void {
  let perSession = backstops.get(sessionId)
  if (!perSession) {
    perSession = new Map()
    backstops.set(sessionId, perSession)
  }
  const existing = perSession.get(requestId)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    const live = backstops.get(sessionId)
    live?.delete(requestId)
    if (live && live.size === 0) backstops.delete(sessionId)
    onTimeout()
  }, timeoutMs)
  perSession.set(requestId, timer)
}

/** Cancel every pending backstop for `sessionId` — the turn proceeded
 *  (remote approved) or ended, so the deny must not fire. */
export function clearApprovalBackstops(sessionId: string): void {
  const perSession = backstops.get(sessionId)
  if (!perSession) return
  for (const timer of perSession.values()) clearTimeout(timer)
  backstops.delete(sessionId)
}

/** True when `sessionId` has at least one armed backstop. Test/diagnostic. */
export function hasArmedBackstop(sessionId: string): boolean {
  const perSession = backstops.get(sessionId)
  return perSession !== undefined && perSession.size > 0
}

/** Test-only — wipe all attach state and pending timers. */
export function __resetRemoteAttachForTests(): void {
  for (const perSession of backstops.values()) {
    for (const timer of perSession.values()) clearTimeout(timer)
  }
  backstops.clear()
  __resetDevicePresenceForTests()
}
