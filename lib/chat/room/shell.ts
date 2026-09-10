/**
 * Which side of a room a shell is on (ADR-0177).
 *
 * A host (the Tauri desktop, the headless brain) runs the room. A companion
 * (the Capacitor shell, a web build paired to a host) never does: it sends
 * `room_send` and `room_stop` and projects the events the host streams back.
 * `useTeamChat` and the per-member stop in the message header route on this
 * one answer, so they cannot disagree about where a turn runs.
 */

import { isTauri } from "@/lib/tauri"
import { isCapacitor } from "@/lib/platform/detect"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"

/** A paired phone or web companion has a host that orchestrates for it. */
export function isCompanionShell(): boolean {
  return !isTauri() && (isCapacitor() || hasWebCompanionTarget())
}
