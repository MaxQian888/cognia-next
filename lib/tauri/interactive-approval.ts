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
import { getRuntimeTargetScopeKey } from "@/lib/runtime/runtime-target-context"

import { issueHostAdminLease, type HostAdminLease } from "./admin-lease"
import { getCommandDescriptor } from "./command-descriptors"
import { getCompanionConfigGeneration } from "./transport-companion"
import { transport } from "./transport-instance"
import { getActiveRemoteTransport } from "./transport-routing"
import type { Transport } from "./transport-types"

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

export class InteractiveApprovalRequiredError extends Error {
  constructor(readonly code = "interactive_approval_required") {
    super(code)
    this.name = "InteractiveApprovalRequiredError"
  }
}

interface ApprovalScopeDeps {
  scopeKey?: string
  target?: Pick<Transport, "call">
  remote?: boolean
  isCurrent?: () => boolean
  now?: () => number
  issue?: typeof issueHostAdminLease
}

/** In-memory authority for a surface. Only `authorize`, called from a gesture, mints a lease. */
export function createInteractiveApprovalScope(
  operations: readonly string[],
  deps: ApprovalScopeDeps = {}
) {
  const initialTransport = transport
  const initialRemote = getActiveRemoteTransport()
  const initialGeneration = getCompanionConfigGeneration()
  const initialScope = deps.scopeKey ?? getRuntimeTargetScopeKey()
  const target = deps.target ?? initialRemote ?? initialTransport
  const remote =
    deps.remote ?? (initialRemote !== null || getRuntimeSnapshot().target?.kind === "companion")
  const isCurrent =
    deps.isCurrent ??
    (() =>
      transport === initialTransport &&
      getActiveRemoteTransport() === initialRemote &&
      getCompanionConfigGeneration() === initialGeneration &&
      getRuntimeTargetScopeKey() === initialScope)
  const now = deps.now ?? Date.now
  const allowed = new Set(operations)
  let lease: Pick<HostAdminLease, "token" | "expiresAt"> | null = null
  let revision = 0
  const clear = () => {
    lease = null
    revision += 1
  }
  const assertCurrent = () => {
    if (!isCurrent()) {
      clear()
      throw new InteractiveApprovalRequiredError("approval_target_changed")
    }
  }

  return {
    clear,
    async authorize(): Promise<void> {
      assertCurrent()
      if (!remote) return
      clear()
      const attempt = revision
      const issued = await (deps.issue ?? issueHostAdminLease)([...operations], 600, target)
      assertCurrent()
      if (attempt !== revision) throw new InteractiveApprovalRequiredError()
      lease = issued
    },
    async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
      assertCurrent()
      const gated =
        remote && (allowed.has(name) || getCommandDescriptor(name)?.approval === "interactive")
      if (gated && (!allowed.has(name) || !lease || lease.expiresAt <= now())) {
        clear()
        throw new InteractiveApprovalRequiredError()
      }
      try {
        return await target.call<T>(name, gated ? { ...args, adminLease: lease!.token } : args)
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "interactive_approval_required"
        )
          clear()
        throw error
      }
    },
  }
}
