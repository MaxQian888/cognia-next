import { getSession, updateSession } from "@/lib/db/sessions"
import {
  applyTaskWorkspace,
  applyWorkspaceBundle,
  getBundleHandoffOutcome,
  pinTaskWorkspace,
  pruneTaskWorkspaces,
  resolveTaskWorkspaceConflict,
  restoreTaskWorkspaceSnapshot,
  retryWorkspaceBundleHandoff,
  undoTaskWorkspace,
  undoWorkspaceBundleHandoff,
} from "./client"
import {
  createSessionExecutionContext,
  transitionManagedWorktree,
} from "./session-execution-context"
import type { BundleHandoffRootSelection, PatchSelection } from "./types"
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
  now = Date.now(),
  bundleSelections?: BundleHandoffRootSelection[]
) {
  const session = await requireManagedSession(sessionId)
  const context = session.executionContext!
  const bundleId = context.execution?.bundleId
  const bundleTurnId = context.taskWorkspace.bundleTurnId
  const runId = context.taskWorkspace.runId
  if (bundleId && !bundleTurnId) {
    throw new Error("Managed workspace Bundle has no restorable turn")
  }
  if (!bundleId && !runId) throw new Error("Managed worktree has no restorable run")

  let scopedSelections = bundleSelections
  if (bundleId && scopedSelections === undefined) {
    if (selection.length === 0) {
      scopedSelections = []
    } else {
      const primaryRoot = context.execution?.roots.find((root) => root.role === "primary")
      if (!primaryRoot) {
        throw new Error("Managed workspace Bundle has no primary root")
      }
      scopedSelections = [
        {
          workspaceId: primaryRoot.workspaceId,
          logicalRootId: primaryRoot.logicalRootId,
          selection,
        },
      ]
    }
  }

  await updateSession(sessionId, {
    executionContext: transitionManagedWorktree(context, "handingOff", now),
  })
  let outcome
  try {
    outcome = bundleId
      ? (
          await applyWorkspaceBundle(bundleId, {
            bundleTurnId: bundleTurnId!,
            selections: scopedSelections!,
            allowIrreversible,
          })
        ).outcome
      : await applyTaskWorkspace(runId!, selection, allowIrreversible)
  } catch (error) {
    await updateSession(sessionId, {
      executionContext: transitionManagedWorktree(context, "failed", Date.now()),
    })
    throw error
  }
  if (outcome.state === "conflict" || outcome.conflicts.length > 0) {
    await updateSession(sessionId, {
      executionContext: transitionManagedWorktree(
        context,
        outcome.state === "conflict" ? "conflict" : "ready",
        Date.now()
      ),
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
  const bundleId = context?.execution?.bundleId
  const bundleTurnId = context?.taskWorkspace.bundleTurnId
  if (bundleId || bundleTurnId) {
    if (!context || !bundleId || !bundleTurnId) {
      throw new Error("Session has no complete Bundle handoff to undo")
    }
    const outcome = await undoWorkspaceBundleHandoff(bundleId, bundleTurnId)
    if (outcome.state === "active" && outcome.conflicts.length === 0) {
      const managed = { ...context, location: "managedWorktree" as const }
      await updateSession(sessionId, {
        executionContext: transitionManagedWorktree(managed, "ready", now),
      })
    }
    return outcome
  }
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
    const ready = transitionManagedWorktree(restoring, "ready", Date.now())
    const execution = ready.execution
      ? {
          ...ready.execution,
          roots: ready.execution.roots.map((root) =>
            root.role === "primary" ? { ...root, aliasPath: run.executionRoot } : root
          ),
        }
      : undefined
    await updateSession(sessionId, {
      executionContext: {
        ...ready,
        ...(execution ? { execution } : {}),
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
  const bundleId = context.execution?.bundleId
  const bundleTurnId = context.taskWorkspace.bundleTurnId
  if (bundleId || bundleTurnId) {
    if (!bundleId || !bundleTurnId) {
      throw new Error("Managed workspace Bundle has no restorable conflict")
    }
    if (resolution !== "retryMerge") {
      throw new Error("Bundle handoff supports exact retry only")
    }
    const previous = await getBundleHandoffOutcome(bundleTurnId)
    if (!previous) throw new Error("Managed workspace Bundle has no persisted handoff")
    const retried = await retryWorkspaceBundleHandoff(bundleId, previous.request)
    await updateSession(sessionId, {
      executionContext: transitionManagedWorktree(
        context,
        retried.outcome.state === "conflict" ? "conflict" : "ready",
        now
      ),
    })
    return retried.outcome
  }
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
