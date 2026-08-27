import { transport } from "@/lib/tauri"

export interface HostAdminLease {
  token: string
  operations: string[]
  expiresAt: number
}

/**
 * The host is waiting for a human before it will mint a lease.
 *
 * Not a failure the caller can retry its way out of, and not a permission
 * error either — the answer is "ask someone", and `consentCode` is what they
 * need in order to answer from a console. It is `null` only when the host is
 * older than ADR-0153 and phrased the refusal without one.
 */
export class HostConsentRequiredError extends Error {
  readonly consentCode: string | null

  constructor(message: string, consentCode: string | null) {
    super(message)
    this.name = "HostConsentRequiredError"
    this.consentCode = consentCode
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "")
}

/** True when the host answered `REMOTE_CONSENT_REQUIRED`. */
export function isHostConsentRequired(error: unknown): boolean {
  return messageOf(error).includes("REMOTE_CONSENT_REQUIRED")
}

/**
 * Pull the short code out of the host's refusal.
 *
 * Parsed from the message rather than carried in a field because the refusal
 * travels as an `RpcError` whose shape is fixed by the protocol; adding a
 * field would be a wire change for something only a human reads.
 */
export function hostConsentCodeFrom(error: unknown): string | null {
  return /\(code\s+([A-Za-z0-9]+)\)/.exec(messageOf(error))?.[1] ?? null
}

/**
 * Request a short-lived lease from an explicit user action. Callers must not
 * invoke this during background refresh, reconnect, or optimistic probing.
 *
 * There is deliberately no `confirmed` argument. It used to send `true`
 * unconditionally, which is what made the manifest's `approval: interactive`
 * a fiction: the caller asserted its own confirmation and the host believed
 * it. The host now obtains the confirmation itself and refuses until it has
 * one — see ADR-0153 and `companion_api::host_consent`.
 */
export async function issueHostAdminLease(
  operations: string[],
  ttlSeconds = 10 * 60
): Promise<HostAdminLease> {
  try {
    return await transport.call<HostAdminLease>("host_admin_lease_issue", {
      operations,
      ttlSeconds,
    })
  } catch (error) {
    if (isHostConsentRequired(error)) {
      throw new HostConsentRequiredError(messageOf(error), hostConsentCodeFrom(error))
    }
    throw error
  }
}

export async function revokeHostAdminLeases(): Promise<void> {
  await transport.call<void>("host_admin_lease_revoke")
}
