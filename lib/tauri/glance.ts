"use client"

/**
 * The glance channel between the main window (publisher) and the windows that
 * render a `GlanceSnapshotV1` (ADR-0225 §7).
 *
 * Four events, all addressed with `emitTo` rather than broadcast: the pet
 * overlay, the island and the dock load the same root layout, and a broadcast
 * would land a request in every one of them.
 *
 * - `glance://subscribe`: consumer → main. "I am visible (or not)." A
 *   subscription is a lease the consumer renews while visible, so a consumer
 *   that crashes or reloads without unsubscribing stops costing the publisher
 *   anything once its lease lapses.
 * - `glance://snapshot`: main → one consumer window.
 * - `glance://request`: consumer → main. Validated there (`parseGlanceRequest`).
 * - `glance://result`: main → the consumer that asked.
 *
 * Same house style as `lib/tauri/tray-panel.ts`: benign values off Tauri, and
 * a failed emit is logged, never thrown.
 */

import { emitTo, listen } from "@tauri-apps/api/event"
import { loggers } from "@cognia/logging"

import type { GlanceRequest, GlanceRequestResult } from "@/lib/glance/requests"
import type { GlanceSnapshotV1 } from "@/lib/glance/snapshot"
import { isTauri } from "@/lib/tauri"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"

export const GLANCE_MAIN_WINDOW_LABEL = "main"

export const GLANCE_SUBSCRIBE_EVENT = "glance://subscribe"
export const GLANCE_SNAPSHOT_EVENT = "glance://snapshot"
export const GLANCE_REQUEST_EVENT = "glance://request"
export const GLANCE_RESULT_EVENT = "glance://result"

/** A consumer renews its lease at this interval while visible. */
export const GLANCE_LEASE_RENEW_MS = 20_000
/** The publisher drops a subscription not renewed within this window. */
export const GLANCE_LEASE_TTL_MS = 60_000

export interface GlanceSubscription {
  /** Stable consumer id, e.g. `tray-panel`. */
  consumer: string
  /** The Tauri window label snapshots are emitted to. */
  windowLabel: string
  visible: boolean
}

export function isGlanceSubscription(value: unknown): value is GlanceSubscription {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.consumer === "string" &&
    v.consumer.length > 0 &&
    v.consumer.length <= 64 &&
    typeof v.windowLabel === "string" &&
    v.windowLabel.length > 0 &&
    v.windowLabel.length <= 64 &&
    typeof v.visible === "boolean"
  )
}

/** Consumer → main: announce (or renew, or end) a subscription. */
export async function sendGlanceSubscription(subscription: GlanceSubscription): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await emitTo(GLANCE_MAIN_WINDOW_LABEL, GLANCE_SUBSCRIBE_EVENT, subscription)
    return true
  } catch (err) {
    loggers.tray?.warn?.("sendGlanceSubscription failed", { error: String(err) })
    return false
  }
}

/** Main side: subscription announcements. */
export async function onGlanceSubscription(
  handler: (subscription: GlanceSubscription) => void
): Promise<() => void> {
  if (!isTauri()) return () => {}
  const unlisten = await listen<unknown>(GLANCE_SUBSCRIBE_EVENT, (event) => {
    if (isGlanceSubscription(event.payload)) handler(event.payload)
  })
  return () => safeUnlisten(unlisten)
}

/** Main → one consumer window. A closed window is the normal case, not an error. */
export async function sendGlanceSnapshot(
  windowLabel: string,
  snapshot: GlanceSnapshotV1
): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await emitTo(windowLabel, GLANCE_SNAPSHOT_EVENT, snapshot)
    return true
  } catch {
    return false
  }
}

/** Consumer side: snapshots. The payload is validated by the caller. */
export async function onGlanceSnapshot(handler: (payload: unknown) => void): Promise<() => void> {
  if (!isTauri()) return () => {}
  const unlisten = await listen<unknown>(GLANCE_SNAPSHOT_EVENT, (event) => handler(event.payload))
  return () => safeUnlisten(unlisten)
}

/** Consumer → main: ask for something. */
export async function sendGlanceRequest(request: GlanceRequest): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await emitTo(GLANCE_MAIN_WINDOW_LABEL, GLANCE_REQUEST_EVENT, request)
    return true
  } catch (err) {
    loggers.tray?.warn?.("sendGlanceRequest failed", { kind: request.kind, error: String(err) })
    return false
  }
}

/** Main side: requests, unvalidated. */
export async function onGlanceRequest(handler: (payload: unknown) => void): Promise<() => void> {
  if (!isTauri()) return () => {}
  const unlisten = await listen<unknown>(GLANCE_REQUEST_EVENT, (event) => handler(event.payload))
  return () => safeUnlisten(unlisten)
}

/** Main → the consumer window that asked. */
export async function sendGlanceResult(
  windowLabel: string,
  result: GlanceRequestResult
): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await emitTo(windowLabel, GLANCE_RESULT_EVENT, result)
    return true
  } catch {
    return false
  }
}

/** Consumer side: request results. */
export async function onGlanceResult(
  handler: (result: GlanceRequestResult) => void
): Promise<() => void> {
  if (!isTauri()) return () => {}
  const unlisten = await listen<GlanceRequestResult>(GLANCE_RESULT_EVENT, (event) =>
    handler(event.payload)
  )
  return () => safeUnlisten(unlisten)
}
