"use client"

/**
 * Transport-routed fleet actions — the cross-platform counterpart to the
 * Tauri-only wrappers in `lib/tauri/fleet.ts`. Every call goes through the
 * unified `transport`, so the SAME functions work on Tauri desktop
 * (invoke) and over the companion API from a phone / companion-connected
 * browser (HTTP/RTC). The Rust side exposes these as `/api/_rpc/fleet_*`
 * dispatch arms (see `companion_api/rpc.rs`).
 */

import { transport } from "@/lib/tauri"
import { EMPTY_FLEET_SNAPSHOT } from "@/lib/fleet/fleet-stream-store"
import type { FleetSnapshot, PermissionBehavior } from "@/lib/fleet/types"

/** Fetch the current fleet snapshot; degrades to empty on any failure (read). */
export async function fleetRemoteGetSnapshot(): Promise<FleetSnapshot> {
  try {
    return await transport.call<FleetSnapshot>("fleet_get_snapshot")
  } catch {
    return EMPTY_FLEET_SNAPSHOT
  }
}

/** Answer a parked permission remotely. Rejects on failure so callers can
 * classify a lost-control 403 with {@link isControlForbidden}. */
export async function fleetRemotePermissionRespond(
  requestId: string,
  behavior: PermissionBehavior
): Promise<boolean> {
  return transport.call<boolean>("fleet_permission_respond", { requestId, behavior })
}

/**
 * Answer a parked AskUserQuestion remotely.
 *
 * `selections` are per-question option INDICES in question order — indices, not
 * labels, because the snapshot truncates long option text for display and an
 * answer keyed on the truncated string would never match. Without this arm an
 * AskUserQuestion stranded anyone away from the desktop island: the phone could
 * see the question but had no way to answer, so it just timed out.
 */
export async function fleetRemoteQuestionRespond(
  requestId: string,
  selections: number[][]
): Promise<boolean> {
  return transport.call<boolean>("fleet_question_respond", { requestId, selections })
}

/** Reject a parked AskUserQuestion through the desktop's native provider gate. */
export async function fleetRemoteQuestionReject(requestId: string): Promise<boolean> {
  return transport.call<boolean>("fleet_question_reject", { requestId })
}

/**
 * Interrupt a session's current turn (one SIGINT — see `fleetInterruptSession`).
 * Rejects on refusal so callers can classify a lost-control 403 with
 * {@link isControlForbidden}, or surface the structured refusal code.
 */
export async function fleetRemoteInterrupt(agent: string, sessionId: string): Promise<void> {
  await transport.call<null>("fleet_interrupt_session", { agent, sessionId })
}

/** Inject a prompt into an OpenCode fleet session; returns the queued id. */
export async function fleetRemoteSendMessage(sessionId: string, text: string): Promise<string> {
  return transport.call<string>("fleet_opencode_send_message", { sessionId, text })
}

/** Focus the terminal behind a session (meaningful only on the same machine). */
export async function fleetRemoteFocusTerminal(agent: string, sessionId: string): Promise<void> {
  await transport.call<null>("fleet_focus_terminal", { agent, sessionId })
}

/**
 * True when a rejection is the remote-control-forbidden 403 — the device's
 * control grant was revoked. Tolerant of the exact error shape (CompanionError
 * carries a `code`; some transports surface only a message/status).
 */
export function isControlForbidden(err: unknown): boolean {
  const e = err as { code?: unknown; status?: unknown; message?: unknown } | null
  if (!e) return false
  return (
    e.code === "remote_control_forbidden" ||
    e.status === 403 ||
    (typeof e.message === "string" && e.message.includes("remote_control_forbidden"))
  )
}
