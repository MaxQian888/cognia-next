/**
 * Approver-side client for host escalation consent (ADR-0153).
 *
 * A paired device that wants an admin lease is refused until a human says yes
 * ON the host. This is the other half: reading what is waiting, and answering
 * it. Both arms need `host.admin` and neither needs a lease — a lease is the
 * thing being granted, so requiring one to grant one has no entry point.
 *
 * Deliberately host-neutral. The desktop reaches these over Tauri IPC and a
 * paired phone or browser over the companion transport, and on a headless
 * deployment a paired device is the ONLY interactive approver there is — the
 * host has no screen. One client, because there is one answer.
 */

import { transport } from "@/lib/tauri"

/** Topic carrying an ask and, later, its answer. */
export const HOST_CONSENT_CHANNEL = "host-consent://requested"

export type HostConsentState = "pending" | "approved" | "denied"

export interface HostConsentRequest {
  id: string
  /** Short code a console approver types; identifies, does not authorize. */
  code: string
  deviceId: string
  accountId?: string
  /** The commands the lease would cover. */
  operations: string[]
  state: HostConsentState
  requestedAt: number
  expiresAt: number
}

/**
 * Everything this device may answer.
 *
 * The host filters its own asks out of the caller's list, so a requesting
 * device never sees the row it is not allowed to approve. Doubles as the
 * capability probe: a device without `host.admin` gets a refusal here, which
 * is the signal to render nothing at all.
 */
export function listPendingHostConsent(): Promise<HostConsentRequest[]> {
  return transport.call<HostConsentRequest[]>("host_consent_pending")
}

/** Answer one request, by id or by its short code. */
export function respondToHostConsent(
  requestId: string,
  approve: boolean
): Promise<HostConsentRequest> {
  return transport.call<HostConsentRequest>("host_consent_respond", { requestId, approve })
}

/**
 * Watch for asks and answers.
 *
 * The frame is a nudge, not the source of truth: it reaches every subscriber
 * including the device that asked, and only {@link listPendingHostConsent}
 * knows what THIS device may act on. Handlers should re-read rather than
 * render the payload.
 */
export function subscribeToHostConsent(handler: (request: HostConsentRequest) => void): () => void {
  return transport.subscribe<HostConsentRequest>(HOST_CONSENT_CHANNEL, handler)
}
