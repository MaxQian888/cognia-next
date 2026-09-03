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
 * The task-workspace commands ONE chat turn issues while it holds a managed
 * working copy.
 *
 * Every one of them is `approval: "interactive"`, so on a companion each was
 * refused with `a current device-bound approval lease is required` and the
 * turn died before the model was ever called. Wrapping them individually in
 * {@link runWorkspaceUserAction} would mint a lease per tool event, and the
 * settle happens long after the send call returns, so a one-shot lease is the
 * wrong shape here. The gesture being approved is pressing Send once.
 */
export const WORKSPACE_TURN_COMMANDS = Object.freeze([
  "task_workspace_bundle_acquire",
  "task_workspace_bundle_turn_begin",
  "task_workspace_bundle_turn_settle",
  "task_workspace_bundle_turn_abort",
  "task_workspace_record_tool_event",
  "task_workspace_begin",
  "task_workspace_settle",
])

/** How long a scope's lease runs before it is re-minted on the next call. */
const SCOPE_LEASE_TTL_SECONDS = 15 * 60
/** Re-mint this far ahead of expiry so a call in flight cannot outlive it. */
const SCOPE_RENEW_MARGIN_MS = 30_000

interface ApprovalScope {
  commands: readonly string[]
  token: string
  expiresAt: number
  closed: boolean
}

/**
 * Standing approvals, newest last. Unlike {@link pendingApprovals} these are
 * NOT consumed by a call: one scope covers every command it names for as long
 * as the work it was opened for is running.
 */
const approvalScopes: ApprovalScope[] = []

/** A standing approval held open by {@link openWorkspaceApprovalScope}. */
export interface WorkspaceApprovalScope {
  close(): void
}

/**
 * Hold one approval open across a piece of multi-call work.
 *
 * Returns `null` when nothing needs approving: this shell IS the execution
 * host, or its host does not gate these commands. Throws
 * {@link WorkspaceOperationUnavailableError} when the device cannot mint a
 * lease at all, so a surface can say which grant is missing instead of showing
 * the host's wire refusal.
 *
 * The caller MUST `close()` it. A scope left open keeps a step-up token usable
 * by later work the user never asked for, which is the whole thing the lease
 * exists to prevent.
 */
export async function openWorkspaceApprovalScope(
  commands: readonly string[] = WORKSPACE_TURN_COMMANDS
): Promise<WorkspaceApprovalScope | null> {
  const snapshot = getRuntimeSnapshot()
  if (!snapshot.target || snapshot.target.kind !== "companion") return null
  const gated = commands.filter(
    (command) => getCommandDescriptor(command)?.approval === "interactive"
  )
  if (gated.length === 0) return null
  for (const command of gated) {
    const availability = resolveUserActionAvailability(snapshot, command)
    if (availability.state !== "available") {
      throw new WorkspaceOperationUnavailableError(command, availability)
    }
  }

  const lease = await issueHostAdminLease([...gated], SCOPE_LEASE_TTL_SECONDS)
  const scope: ApprovalScope = {
    commands: gated,
    token: lease.token,
    expiresAt: lease.expiresAt,
    closed: false,
  }
  approvalScopes.push(scope)
  return {
    close() {
      scope.closed = true
      const index = approvalScopes.indexOf(scope)
      if (index >= 0) approvalScopes.splice(index, 1)
    },
  }
}

/**
 * The live scope covering `command`, re-minting it when it is about to expire.
 *
 * A managed turn can outrun any single lease, and losing one mid-turn means the
 * settle that releases the working copy is refused. Renewal keeps the same
 * scope alive rather than widening its TTL, so an abandoned scope still stops
 * being usable.
 */
async function scopeLeaseFor(command: string): Promise<string | undefined> {
  const scope = [...approvalScopes]
    .reverse()
    .find((candidate) => !candidate.closed && candidate.commands.includes(command))
  if (!scope) return undefined
  if (scope.expiresAt - Date.now() > SCOPE_RENEW_MARGIN_MS) return scope.token
  const renewed = await issueHostAdminLease([...scope.commands], SCOPE_LEASE_TTL_SECONDS)
  if (scope.closed) return undefined
  scope.token = renewed.token
  scope.expiresAt = renewed.expiresAt
  return scope.token
}

/**
 * The transport `client.ts` writes through. Reads may use the base transport
 * directly, writes must come through here or they lose the lease.
 */
export const approvalAwareTransport = {
  async call<T>(command: string, args?: unknown): Promise<T> {
    let next = applyWorkspaceApproval(command, args)
    if (next?.adminLease === undefined) {
      // A one-shot lease wins: it was minted for this exact call. Only when
      // there is none does the standing scope answer.
      const scoped = await scopeLeaseFor(command)
      if (scoped)
        next = { ...((next ?? args ?? {}) as Record<string, unknown>), adminLease: scoped }
    }
    // Preserve the caller's arity. A few commands take no arguments at all,
    // and forwarding an explicit `undefined` changes the call the transport
    // sees for no benefit.
    return next === undefined
      ? baseTransport.call<T>(command)
      : baseTransport.call<T>(command, next)
  },
}
