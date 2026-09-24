/**
 * "Someone else holds what this turn needs", as a type.
 *
 * Every exclusive resource a turn can collide on reports the collision as a
 * bare host string: the task-workspace service refuses with "pipeline workspace
 * is already active", the external-agent process manager with "Agent <id> is
 * already running", the perf sampler with `device-purpose-limit`. Read as
 * prose, each was indistinguishable from a generic spawn failure — the chat
 * said "the agent could not start" when the truth was "it is already running
 * somewhere else, wait for it". Converting once, where the host string enters
 * TypeScript, lets every later layer (the diagnostic, the transcript row)
 * branch on `resource` instead of re-matching text.
 */

import { isExternalAgentAlreadyRunningError } from "@/lib/ai/agent/external/policy/spawn-reclaim"

/** The exclusive resources a turn can find already held. */
export type LeaseConflictResource =
  /** This conversation's working copy: another turn's run is still open on it. */
  | "working-copy"
  /** An external agent process id: a live process is still registered under it. */
  | "agent-process"

export class LeaseConflictError extends Error {
  readonly resource: LeaseConflictResource
  /** What holds it, when the host said (a workspace key, a process id). */
  readonly holder?: string

  constructor(
    resource: LeaseConflictResource,
    message: string,
    options: { holder?: string; cause?: unknown } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "LeaseConflictError"
    this.resource = resource
    if (options.holder) this.holder = options.holder
  }
}

export function isLeaseConflictError(error: unknown): error is LeaseConflictError {
  return error instanceof LeaseConflictError
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The working-copy refusal as a typed conflict. The caller recognises it with
 * `isWorkspaceBusyRefusal` (`lib/task-workspace/client.ts`), which owns that
 * host sentence; importing it here would drag the task-workspace client and its
 * stores into every runtime adapter that needs the class.
 */
export function workingCopyConflict(error: unknown): LeaseConflictError {
  if (error instanceof LeaseConflictError) return error
  const message = messageOf(error)
  const holder = /already active:\s*(\S+)/i.exec(message)?.[1]
  return new LeaseConflictError("working-copy", message, {
    ...(holder ? { holder } : {}),
    cause: error,
  })
}

/**
 * The external-agent process manager's id collision as a typed conflict, or
 * `null` when `error` is some other spawn failure.
 */
export function agentProcessConflictFrom(error: unknown): LeaseConflictError | null {
  if (error instanceof LeaseConflictError) return error.resource === "agent-process" ? error : null
  if (!isExternalAgentAlreadyRunningError(error)) return null
  const message = messageOf(error)
  const holder = /Agent\s+(\S+)\s+is already running/i.exec(message)?.[1]
  return new LeaseConflictError("agent-process", message, {
    ...(holder ? { holder } : {}),
    cause: error,
  })
}
