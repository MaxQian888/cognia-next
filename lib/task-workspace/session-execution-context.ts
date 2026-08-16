import type {
  ManagedWorktreeLifecycleState,
  SessionExecutionContext,
  SessionExecutionLocation,
} from "@/types/execution-context"

export interface CreateSessionExecutionContextInput {
  sessionId: string
  projectId: string
  projectRoot: string
  rootId?: string
  environmentId?: string
  requestedLocation: SessionExecutionLocation
  isGitRepository: boolean
  baseRef?: string
  managedWorkspaceId?: string
  managedWorkspaceRoot?: string
  now: number
}

/**
 * Create the durable binding for a new persisted chat. `managedWorktree`
 * describes the managed execution contract; Task Workspace chooses a Git
 * worktree or its non-Git shadow backend when it materializes that contract.
 */
export function createSessionExecutionContext(
  input: CreateSessionExecutionContextInput
): SessionExecutionContext {
  const location = input.requestedLocation
  const managedWorkspaceId = input.managedWorkspaceId?.trim()
  const workspaceBinding = managedWorkspaceId
    ? ({ kind: "managed", workspaceId: managedWorkspaceId } as const)
    : ({ kind: "project", projectId: input.projectId } as const)
  return {
    location,
    workspaceBinding,
    ...(managedWorkspaceId
      ? {
          managedWorkspace: input.managedWorkspaceRoot
            ? {
                availability: "available" as const,
                localRoot: input.managedWorkspaceRoot,
                materializedAt: input.now,
              }
            : { availability: "missing-on-device" as const },
        }
      : {}),
    projectId: input.projectId,
    projectRoot: input.projectRoot,
    rootId: input.rootId,
    environmentId: input.environmentId,
    taskWorkspace: {
      taskId: `task-workspace:${input.sessionId}`,
      workspaceKey: managedWorkspaceId ?? input.sessionId,
    },
    baseRef:
      location === "managedWorktree" && input.isGitRepository
        ? (input.baseRef ?? "HEAD")
        : undefined,
    lifecycle:
      location === "managedWorktree"
        ? {
            state: "requested",
            createdAt: input.now,
            updatedAt: input.now,
            pinned: false,
          }
        : undefined,
  }
}

/** Repeated turns must keep the same task/worktree identity. */
export function bindExecutionRun(
  context: SessionExecutionContext,
  runId: string
): SessionExecutionContext {
  return {
    ...context,
    taskWorkspace: { ...context.taskWorkspace, runId },
  }
}

export function transitionManagedWorktree(
  context: SessionExecutionContext,
  state: ManagedWorktreeLifecycleState,
  now: number,
  patch: Partial<Pick<SessionExecutionContext, "worktreePath" | "branch">> = {}
): SessionExecutionContext {
  if (context.location !== "managedWorktree" || !context.lifecycle) {
    throw new Error("Managed worktree transition requires a managed-worktree context")
  }
  return {
    ...context,
    ...patch,
    lifecycle: { ...context.lifecycle, state, updatedAt: now },
  }
}

/** Scheduled setup failures are never bypassable. */
export function canBypassEnvironmentSetup(surface: "interactive" | "scheduled"): boolean {
  return surface === "interactive"
}

/** Resolve only an explicitly available device-local root; never guess one. */
export function resolveSessionWorkspaceRoot(context: SessionExecutionContext): string | undefined {
  if (context.workspaceBinding?.kind !== "managed") return context.projectRoot || undefined
  return context.managedWorkspace?.availability === "available"
    ? context.managedWorkspace.localRoot
    : undefined
}
