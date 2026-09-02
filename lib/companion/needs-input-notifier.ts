"use client"

/**
 * Remote Session Control — decision-point notifier.
 *
 * When a host session that a remote device is watching hits a tool-use
 * approval (and the desktop routed it to that device instead of auto-denying —
 * see `hooks/chat/use-claude-chat.ts`), the remote may have backgrounded the
 * app, dropping its `/ws/events` subscription. This emits a dedicated
 * `companion://needs-input` Tauri event that the Rust `register_push_trigger`
 * (in `companion_api/commands.rs`) turns into an APNs/FCM push.
 *
 * Two things about the payload are deliberate:
 *
 * **It says where, never what.** `toolName` and the tool input used to ride
 * along, and `push_data_for_channel` passed the raw payload straight through
 * for this channel — so the name of the command a run wanted to execute
 * reached the provider and could land on a lock screen. Only ids and a deep
 * link travel now; the device fetches the actual request over its authenticated
 * stream once it opens.
 *
 * **It is addressed.** `targetDeviceIds` names the devices holding a control
 * attachment on this session (`approvalPushTargets`), minus any that is already
 * foreground on a live stream. Without it the trigger fanned out to *every*
 * registered device, which both woke phones for prompts they had no authority
 * to answer and told them a session they were not watching had gone active.
 * The field is consumed by the trigger for routing and stripped before the
 * payload transits the provider.
 *
 * **It is host-neutral.** The emit goes through `publishHostEvent`, which is
 * a Tauri `emit` on the desktop and the `companion_event_publish` bridge
 * route on the headless brain (`ws_bridge.rs` allowlists this topic). It used
 * to import `@tauri-apps/api/event` behind an `isTauri()` guard, so a phone
 * attached to a cloud Host never got the "approval needed" alert — the one
 * place a backgrounded device most needs it. Failures are swallowed by the
 * publisher (the approval is still pending and recoverable when the device
 * reopens its `/ws/events` stream).
 */

import { publishHostEvent } from "@/lib/companion/host-event-publisher"
import { approvalPushTargets } from "@/lib/companion/remote-attach-registry"

export const NEEDS_INPUT_CHANNEL = "companion://needs-input"

export interface NeedsInputPayload {
  sessionId: string
  requestId: string
}

interface NeedsInputEmit extends NeedsInputPayload {
  targetDeviceIds: string[]
  href: string
  dedupeKey: string
}

/** Deep link that opens the session and the specific pending decision. */
export function needsInputHref(sessionId: string, requestId: string): string {
  const params = new URLSearchParams({ session: sessionId, decision: requestId })
  return `/remote-sessions?${params.toString()}`
}

export function buildNeedsInputEmit(
  payload: NeedsInputPayload,
  targetDeviceIds: string[]
): NeedsInputEmit {
  return {
    sessionId: payload.sessionId,
    requestId: payload.requestId,
    targetDeviceIds,
    href: needsInputHref(payload.sessionId, payload.requestId),
    // The request id already identifies the decision uniquely, and re-emitting
    // for the same one (a retry, a second watcher attaching) must collapse into
    // the notification the device already has rather than stacking alerts.
    dedupeKey: payload.requestId,
  }
}

export async function notifyRemoteNeedsInput(payload: NeedsInputPayload): Promise<void> {
  const targetDeviceIds = approvalPushTargets(payload.sessionId)
  // Every attached controller is already foreground on a live stream, so the
  // frame is on screen and a native alert would duplicate it.
  if (targetDeviceIds.length === 0) return
  await publishHostEvent(NEEDS_INPUT_CHANNEL, buildNeedsInputEmit(payload, targetDeviceIds))
}
