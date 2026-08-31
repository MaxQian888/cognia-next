/**
 * The approval seam for user-triggered task-workspace mutations.
 *
 * # Why this exists
 *
 * `authorize_approval` (`src-tauri/src/companion_api/remote_execution.rs`)
 * refuses any `approval: "interactive"` command that does not carry a valid
 * `adminLease`. Every task-workspace WRITE command carries that flag:
 * `task_workspace_managed_delete`, `_archive`, `_restore`, `_pin`,
 * `_permanent`, `_adopt`, `task_workspace_environment_adopt`,
 * `_create_branch`, `task_workspace_policy_set`.
 *
 * `lib/task-workspace/client.ts` called `transport.call` bare, so every one of
 * those actions answered `interactive_approval_required` from a paired phone
 * or browser. The reads (`approval: "none"`, capability `host.observe`) always
 * worked, which is why the inventory rendered and every button on it failed.
 *
 * The git plane solved this already. `runGitUserAction`
 * (`lib/git/commands.ts`) resolves per-command availability, mints a lease,
 * and parks it for the outbound call to pick up. This module is that same
 * shape for task-workspace, sharing `resolveUserActionAvailability` so the two
 * planes cannot answer the same lease question differently.
 *
 * # Known limitation: a desktop driving a remote host
 *
 * This skips the lease whenever the runtime snapshot has no client target,
 * which covers the Tauri desktop and the headless brain. That is correct for a
 * desktop running against itself and WRONG for a desktop driving another
 * Cognia host through `RoutingTransport`, which does demand a lease.
 *
 * It is not fixable here. `host_admin_lease_issue` is `target: "host-admin"`,
 * and `RoutingTransport.call` rejects that target outright with "requires an
 * explicit host-admin execution context". A desktop therefore cannot mint a
 * lease for the host it is driving through the ordinary transport at all.
 * Minting one locally would produce a token the remote host will not accept,
 * which is worse than the current refusal because it looks like it worked.
 * Closing this needs a host-admin execution context on the routing plane,
 * which is a change to the routing layer rather than to either caller.
 */

import { transport as baseTransport } from "@/lib/tauri"
import { issueHostAdminLease } from "@/lib/tauri/admin-lease"
import { getCommandDescriptor } from "@/lib/tauri/command-descriptors"
import { getRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"
import {
  resolveUserActionAvailability,
  type OperationAvailability,
} from "@/lib/runtime/operation-availability"

interface PendingApproval {
  command: string
  token: string
}

/**
 * Leases minted but not yet consumed, keyed by command.
 *
 * A queue rather than a single slot because two inventory rows can be acted on
 * concurrently, and each lease is bound to one exact command. Entries are
 * removed in `finally`, so an operation that throws does not strand its lease
 * for a later call to pick up by mistake.
 */
const pendingApprovals: PendingApproval[] = []

/**
 * Attach a pending lease to one outbound call's arguments.
 *
 * Called by the transport shim in `client.ts` rather than by each wrapper, so
 * a new write command cannot be added without the lease riding along.
 */
export function applyWorkspaceApproval(
  command: string,
  args?: unknown
): Record<string, unknown> | undefined {
  const index = pendingApprovals.findIndex((approval) => approval.command === command)
  if (index < 0) return args as Record<string, unknown> | undefined
  const [approval] = pendingApprovals.splice(index, 1)
  return { ...((args as Record<string, unknown>) ?? {}), adminLease: approval.token }
}

/** Whether `command` can run right now, and if not, the reason to show. */
export function getWorkspaceOperationAvailability(command: string): OperationAvailability {
  return resolveUserActionAvailability(getRuntimeSnapshot(), command)
}

/**
 * Thrown instead of issuing a call the host would refuse.
 *
 * Carries the structured availability so a surface can render the reason
 * rather than a stringified state name.
 */
export class WorkspaceOperationUnavailableError extends Error {
  readonly availability: OperationAvailability

  constructor(command: string, availability: OperationAvailability) {
    super(`Workspace operation unavailable: ${command} (${availability.reason})`)
    this.name = "WorkspaceOperationUnavailableError"
    this.availability = availability
  }
}

/** Bind one exact 120-second approval lease to a user-triggered workspace mutation. */
export async function runWorkspaceUserAction<T>(
  command: string,
  operation: () => Promise<T>
): Promise<T> {
  const snapshot = getRuntimeSnapshot()

  // No client target means this shell IS the execution host: the Tauri desktop
  // or the headless brain. It approves itself and there is nobody to ask.
  //
  // Deliberately not `isTauri()`, which the git plane uses. `isTauri()` is also
  // false in the headless host, so that check would have sent a headless run
  // off to mint a lease from a host that does not exist.
  if (!snapshot.target) return operation()

  const availability = resolveUserActionAvailability(snapshot, command)
  if (availability.state !== "available") {
    // Refuse before the call. Issuing it would spend a round trip to learn
    // what the manifest already said, and return a host error that names the
    // wire failure instead of the missing grant.
    throw new WorkspaceOperationUnavailableError(command, availability)
  }

  // A standalone client runs against its own in-browser executor, and a
  // non-interactive command needs no approval. Only the interactive-over-a-
  // companion pair actually requires a lease.
  if (
    snapshot.target.kind !== "companion" ||
    getCommandDescriptor(command)?.approval !== "interactive"
  ) {
    return operation()
  }

  const lease = await issueHostAdminLease([command], 120)
  const approval: PendingApproval = { command, token: lease.token }
  pendingApprovals.push(approval)
  try {
    return await operation()
  } finally {
    const index = pendingApprovals.indexOf(approval)
    if (index >= 0) pendingApprovals.splice(index, 1)
  }
}

/**
 * The transport `client.ts` writes through. Reads may use the base transport
 * directly, writes must come through here or they lose the lease.
 */
export const approvalAwareTransport = {
  call<T>(command: string, args?: unknown): Promise<T> {
    const next = applyWorkspaceApproval(command, args)
    // Preserve the caller's arity. A few commands take no arguments at all,
    // and forwarding an explicit `undefined` changes the call the transport
    // sees for no benefit.
    return next === undefined
      ? baseTransport.call<T>(command)
      : baseTransport.call<T>(command, next)
  },
}
