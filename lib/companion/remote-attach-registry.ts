"use client"

/**
 * Remote Session Control — host-side attach registry + approval backstop.
 *
 * When a remote device opens a session viewer it calls the `session_attach`
 * RPC; on close / navigate-away it calls `session_detach`. Both land in
 * `lib/companion/desktop-write-source.ts` which updates this process-global
 * (renderer) registry. `hooks/chat/use-claude-chat.ts` consults
 * `isSessionAttached` so a `permission_request` for a session that is NOT the
 * desktop's foreground session is **routed to the attached remote device**
 * (which already received the frame over `/ws/v1/events` and will call
 * `claude_approve`) instead of being auto-denied with "session not active".
 *
 * Because the sidecar's `canUseTool` has no timeout of its own (see
 * `sidecar/dispatch/anthropic.mjs`), an un-answered approval would hang the
 * turn forever. `armApprovalBackstop` schedules a renderer-side deny that
 * fires only if the remote never responds; `clearApprovalBackstops` cancels it
 * the moment the turn proceeds (next SDK event) or ends.
 *
 * Refcounted by deviceId so two devices watching the same session don't
 * detach each other — a session stays "attached" until the last watcher
 * leaves.
 */

/** sessionId → set of deviceIds currently watching it. */
const attached = new Map<string, Set<string>>()

/** sessionId → (requestId → backstop timer handle). */
const backstops = new Map<string, Map<string, ReturnType<typeof setTimeout>>>()

/** Default backstop window. Generous so a human has time to act on the phone;
 *  it only fires when the remote never answers (e.g. the device dropped). */
export const DEFAULT_APPROVAL_BACKSTOP_MS = 120_000

/** Record that `deviceId` is now watching `sessionId`. Idempotent. */
export function attachSession(sessionId: string, deviceId: string): void {
  if (!sessionId || !deviceId) return
  let set = attached.get(sessionId)
  if (!set) {
    set = new Set()
    attached.set(sessionId, set)
  }
  set.add(deviceId)
}

/** Record that `deviceId` stopped watching `sessionId`. Drops the session
 *  entry once the last watcher leaves. Idempotent. */
export function detachSession(sessionId: string, deviceId: string): void {
  const set = attached.get(sessionId)
  if (!set) return
  set.delete(deviceId)
  if (set.size === 0) attached.delete(sessionId)
}

/** Drop `deviceId` from every session it was watching. Use on a device-level
 *  disconnect so stale attachments don't keep approvals pending. */
export function detachDevice(deviceId: string): void {
  for (const [sessionId, set] of attached) {
    if (set.delete(deviceId) && set.size === 0) {
      attached.delete(sessionId)
    }
  }
}

/** True when at least one remote device is watching `sessionId`. */
export function isSessionAttached(sessionId: string): boolean {
  const set = attached.get(sessionId)
  return set !== undefined && set.size > 0
}

/** The deviceIds currently watching `sessionId` (empty when none). */
export function attachedDeviceIds(sessionId: string): string[] {
  return Array.from(attached.get(sessionId) ?? [])
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
  attached.clear()
  backstops.clear()
}
