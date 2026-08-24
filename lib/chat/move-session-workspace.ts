/**
 * Move a conversation to a different Workspace.
 *
 * Attribution alone is not enough: a session also carries a durable
 * `executionContext` naming a workspace binding, root leases and a managed
 * worktree. Changing only `projectId` would produce a conversation that BELONGS
 * to one project while still running in another's directory — the precise
 * mis-attribution the send path was just fixed to stop producing, made
 * permanent and persisted.
 *
 * So the execution context is rebuilt against the destination. The old managed
 * worktree is deliberately left on disk and unreferenced rather than removed:
 * it holds work the user may not have applied, and ADR-0111 requires an
 * unowned directory never be reclaimed automatically. Patch sets and snapshots
 * recorded against the old paths stay readable and are NOT rewritten — history
 * describes what happened, not where the conversation lives now.
 *
 * Refused while the conversation is running: the turn in flight holds a bundle
 * turn lease against the old workspace, and re-pointing underneath it would
 * settle its patches into a directory nobody is watching.
 */

import type { ChatSession, Project } from "@cognia/agent-config-types"
import type { SessionExecutionContext } from "@/types/execution-context"
import { createSessionExecutionContext } from "@/lib/task-workspace/session-execution-context"
import { primaryRootOf } from "@/lib/workspace/roots"

export type MoveSessionRefusal =
  "same-workspace" | "unknown-workspace" | "session-running" | "session-locked"

export interface MoveSessionInput {
  session: Pick<ChatSession, "id" | "projectId" | "executionContext" | "handoffLock">
  target: Pick<Project, "id" | "roots" | "defaultEnvironmentId" | "defaultExecutionLocation"> | null
  /** True while a turn is in flight for this session. */
  running: boolean
  now: number
}

export type MoveSessionPlan =
  | { ok: false; reason: MoveSessionRefusal }
  | {
      ok: true
      projectId: string
      previousProjectId?: string
      executionContext: SessionExecutionContext
    }

/**
 * Decide the move. Pure: the caller performs the Dexie write and the store
 * link/unlink, so the refusal reasons are testable without a database.
 */
export function planSessionMove(input: MoveSessionInput): MoveSessionPlan {
  const { session, target, running, now } = input
  if (!target) return { ok: false, reason: "unknown-workspace" }
  if (session.projectId === target.id) return { ok: false, reason: "same-workspace" }
  // A handed-off session is read-only by contract (ADR-0103); moving it would
  // write to a row the owning host believes it controls.
  if (session.handoffLock) return { ok: false, reason: "session-locked" }
  if (running) return { ok: false, reason: "session-running" }

  const root = primaryRootOf(target)
  const executionContext = createSessionExecutionContext({
    sessionId: session.id,
    projectId: target.id,
    projectRoot: root?.path ?? "",
    ...(root?.id ? { rootId: root.id } : {}),
    ...(target.defaultEnvironmentId ? { environmentId: target.defaultEnvironmentId } : {}),
    // A rootless destination has no directory for "local" to mean, so it takes
    // the managed contract regardless of the project's stated default.
    requestedLocation: root
      ? (target.defaultExecutionLocation ?? "managedWorktree")
      : "managedWorktree",
    isGitRepository: false,
    now,
  })

  return {
    ok: true,
    projectId: target.id,
    ...(session.projectId ? { previousProjectId: session.projectId } : {}),
    executionContext,
  }
}
