/**
 * Attach an admin lease to one user-initiated call the host gates behind
 * `approval: "interactive"`.
 *
 * `authorize_approval` refuses such a command from a paired device unless the
 * call carries a valid `adminLease`. This mints one for exactly the command
 * being sent, from the gesture that sends it (`issueHostAdminLease` must never
 * run in the background). A shell with local authority (no companion target)
 * is the host itself, dispatches in-process, and needs none, so its args go
 * out unchanged, the same gate `lib/queue/outbound-approval.ts` uses.
 *
 * A host waiting on a person throws `HostConsentRequiredError`, whose
 * `consentCode` the caller shows so an approver can answer.
 */

import { getRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"

import { issueHostAdminLease } from "./admin-lease"

export interface InteractiveApprovalDeps {
  /** Whether the call goes to a paired host rather than this process. */
  isRemote?: () => boolean
  issue?: (operations: string[]) => Promise<{ token: string }>
}

export async function withInteractiveApproval<T extends Record<string, unknown>>(
  command: string,
  args: T,
  deps: InteractiveApprovalDeps = {}
): Promise<T & { adminLease?: string }> {
  const remote = deps.isRemote?.() ?? getRuntimeSnapshot().target?.kind === "companion"
  if (!remote) return args
  const lease = await (deps.issue ?? ((operations) => issueHostAdminLease(operations)))([command])
  return { ...args, adminLease: lease.token }
}
