"use client"

/**
 * Devices the owner has explicitly woken onto the WAN signaling plane.
 *
 * `lib/signaling/wan-dormancy.ts` denies an automatic connection to a device
 * that has been silent for 30 days. This module is the other half of that
 * decision: the manual override that says "I want this one reachable now".
 *
 * **Deliberately session-scoped and not persisted.** A wake is an intent about
 * right now, not a setting. Two consequences follow, and both are the point:
 *
 *  * If the device answers, the JWT verifier stamps `lastSeenAt`, the row stops
 *    being dormant on its own, and the override becomes redundant rather than
 *    load-bearing.
 *  * If it never answers, the socket goes away at the next app restart instead
 *    of quietly rejoining the permanent set and undoing the fix. Nothing
 *    accumulates.
 *
 * Written by the device console, read by `installDesktopSignalingController`,
 * which re-pushes `companion_signaling_sync_devices` on every change. That push
 * is what actually spawns the client task. `SignalingHub::reconnect_device`
 * cannot do it, because it resolves the device out of `pending_devices`, which
 * is exactly the last list the renderer pushed, so a device the renderer left
 * out is unknown to it.
 *
 * The snapshot identity is stable between changes so `useSyncExternalStore`
 * does not loop.
 */

const EMPTY: ReadonlySet<string> = new Set<string>()

let woken: ReadonlySet<string> = EMPTY
const listeners = new Set<() => void>()

function publish(next: ReadonlySet<string>): void {
  woken = next
  for (const listener of [...listeners]) listener()
}

/** The current override set. Stable by identity until it actually changes. */
export function getWanWakeOverrides(): ReadonlySet<string> {
  return woken
}

/** Whether this device is currently held open by an explicit wake. */
export function isWanWakeRequested(deviceId: string): boolean {
  return woken.has(deviceId)
}

/**
 * Ask the desktop to hold a WAN signaling connection for a dormant device.
 *
 * Idempotent: waking an already-woken device does not republish, so a
 * double-click cannot churn the hub through a teardown and respawn.
 */
export function wakeDeviceForWan(deviceId: string): void {
  if (!deviceId || woken.has(deviceId)) return
  const next = new Set(woken)
  next.add(deviceId)
  publish(next)
}

/**
 * Drop the override again, letting the dormancy rule decide.
 *
 * A device that has been seen since keeps its connection on the ordinary rule,
 * so this is not the same thing as disconnecting it.
 */
export function sleepDeviceForWan(deviceId: string): void {
  if (!woken.has(deviceId)) return
  const next = new Set(woken)
  next.delete(deviceId)
  publish(next)
}

/** Subscribe to override changes. Returns the unsubscribe function. */
export function subscribeWanWakeOverrides(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Server snapshot for `useSyncExternalStore`.
 *
 * A separate frozen empty set rather than {@link getWanWakeOverrides} so a
 * static export's prerender can never observe a client-side wake and hydrate
 * into a mismatch.
 */
export function getWanWakeOverridesServerSnapshot(): ReadonlySet<string> {
  return EMPTY
}

export function resetWanWakeOverridesForTests(): void {
  woken = EMPTY
  listeners.clear()
}
