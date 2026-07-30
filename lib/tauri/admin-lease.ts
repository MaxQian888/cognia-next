import { transport } from "@/lib/tauri"

export interface HostAdminLease {
  token: string
  operations: string[]
  expiresAt: number
}

/**
 * Request a short-lived lease from an explicit user action. Callers must not
 * invoke this during background refresh, reconnect, or optimistic probing.
 */
export function issueHostAdminLease(
  operations: string[],
  ttlSeconds = 10 * 60
): Promise<HostAdminLease> {
  return transport.call<HostAdminLease>("host_admin_lease_issue", {
    operations,
    ttlSeconds,
    confirmed: true,
  })
}

export async function revokeHostAdminLeases(): Promise<void> {
  await transport.call<void>("host_admin_lease_revoke")
}
