import { getSession, updateSession } from "@/lib/db/sessions"
import {
  applyTaskWorkspace,
  pinTaskWorkspace,
  pruneTaskWorkspaces,
  resolveTaskWorkspaceConflict,
  restoreTaskWorkspaceSnapshot,
  undoTaskWorkspace,
} from "./client"
import {
  createSessionExecutionContext,
  transitionManagedWorktree,
} from "./session-execution-context"
import type { PatchSelection } from "./types"
import type { SessionExecutionContext } from "@/types/execution-context"

async function requireManagedSession(sessionId: string) {
  const session = await getSession(sessionId)
  if (!session?.executionContext || session.executionContext.location !== "managedWorktree") {
    throw new Error("Session is not bound to a managed worktree")
  }
  return session
}

export async function handoffSessionToManaged(input: {
  sessionId: string
  projectId: string
  projectRoot: string
  rootId?: string
  environmentId?: string
  isGitRepository: boolean
  baseRef?: string
  now?: number
}): Promise<SessionExecutionContext> {
  const context = createSessionExecutionContext({
    ...input,
    requestedLocation: "managedWorktree",
    now: input.now ?? Date.now(),
  })
  await updateSession(input.sessionId, { executionContext: context })
  return context
}

export async function handoffSessionToLocal(
  sessionId: string,
  selection: PatchSelection[] = [],
  allowIrreversible = false,
  now = Date.now()
) {
  const session = await requireManagedSession(sessionId)
  const context = session.executionContext!
  const runId = context.taskWorkspace.runId
  if (!runId) throw new Error("Managed worktree has no restorable run")
  await updateSession(sessionId, {
    executionContext: transitionManagedWorktree(context, "handingOff", now),
  })
  const outcome = await applyTaskWorkspace(runId, selection, allowIrreversible)
  if (outcome.state === "conflict") {
    await updateSession(sessionId, {
      executionContext: transitionManagedWorktree(context, "conflict", Date.now()),
    })
    return outcome
  }
  const snapshotted = transitionManagedWorktree(context, "snapshotted", Date.now())
  await updateSession(sessionId, {
    executionContext: { ...snapshotted, location: "local" },
  })
  return outcome
}

export async function undoSessionHandoff(sessionId: string, now = Date.now()) {
  const session = await getSession(sessionId)
  const context = session?.executionContext
  const runId = context?.taskWorkspace.runId
  if (!context || !runId) throw new Error("Session has no handoff to undo")
  const outcome = await undoTaskWorkspace(runId)
  if (outcome.state === "reverted") {
    const managed = { ...context, location: "managedWorktree" as const }
    await updateSession(sessionId, {
      executionContext: transitionManagedWorktree(managed, "ready", now),
    })
  }
  return outcome
}

export async function restoreSessionSnapshot(sessionId: string, runId: string, now = Date.now()) {
  const session = await getSession(sessionId)
  const context = session?.executionContext
  if (!context) throw new Error("Session has no Task Workspace snapshot to restore")
  const restoring = transitionManagedWorktree(
    { ...context, location: "managedWorktree" },
    "restoring",
    now
  )
  await updateSession(sessionId, { executionContext: restoring })
  try {
    const run = await restoreTaskWorkspaceSnapshot(runId)
    const ready = transitionManagedWorktree(restoring, "ready", Date.now(), {
      worktreePath: run.executionRoot,
      ...(run.isolationRef ? { branch: run.isolationRef } : {}),
    })
    await updateSession(sessionId, {
      executionContext: {
        ...ready,
        taskWorkspace: { ...ready.taskWorkspace, runId },
      },
    })
    return run
  } catch (error) {
    await updateSession(sessionId, {
      executionContext: transitionManagedWorktree(restoring, "failed", Date.now()),
    })
    throw error
  }
}

export async function resolveSessionHandoffConflict(
  sessionId: string,
  resolution: "retryMerge" | "applyTask" | "keepCurrent",
  selection: PatchSelection[] = [],
  allowIrreversible = false,
  now = Date.now()
) {
  const session = await requireManagedSession(sessionId)
  const context = session.executionContext!
  const runId = context.taskWorkspace.runId
  if (!runId) throw new Error("Managed worktree has no conflicted run")
  const outcome = await resolveTaskWorkspaceConflict(
    runId,
    resolution,
    selection,
    allowIrreversible
  )
  await updateSession(sessionId, {
    executionContext: transitionManagedWorktree(
      context,
      outcome.state === "conflict" ? "conflict" : "ready",
      now
    ),
  })
  return outcome
}

export async function pinSessionWorktree(sessionId: string, pinned: boolean, now = Date.now()) {
  const session = await requireManagedSession(sessionId)
  const task = await pinTaskWorkspace(session.executionContext!.taskWorkspace.taskId, pinned)
  await updateSession(sessionId, {
    executionContext: {
      ...session.executionContext!,
      lifecycle: { ...session.executionContext!.lifecycle!, pinned, updatedAt: now },
    },
  })
  return task
}

export async function pruneSessionWorktree(sessionId: string, now = Date.now()) {
  const session = await requireManagedSession(sessionId)
  const outcome = await pruneTaskWorkspaces()
  if (outcome.removedTaskIds.includes(session.executionContext!.taskWorkspace.taskId)) {
    await updateSession(sessionId, {
      executionContext: transitionManagedWorktree(session.executionContext!, "pruned", now),
    })
  }
  return outcome
}
