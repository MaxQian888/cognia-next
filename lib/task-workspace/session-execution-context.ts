import type {
  ManagedWorktreeLifecycleState,
  SessionExecutionRootLease,
  SessionWorkspaceBaseSpec,
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
  base?: SessionWorkspaceBaseSpec
  bundleId?: string
  environmentKind?: "managed" | "permanent"
  rootLeases?: SessionExecutionRootLease[]
  managedWorkspaceId?: string
  managedWorkspaceRoot?: string
  now: number
}

/**
 * Give a managed context back the project id it was created without.
 *
 * `createManagedWorkspaceContext` stamps `projectId: ""` on every rootless
 * chat, and `materializeManagedWorkspace` carries that through verbatim. The
 * send path then looks the project up by that id, `.find(c => c.id === "")`
 * never matches, and the turn is refused as `managed_project_unavailable`
 * before it starts — on desktop and on web alike.
 *
 * The right value was never a guess: `ChatSession.projectId` is already on the
 * row and `resolveScopeProjectId` guarantees it is non-empty. `planSessionMove`
 * already does exactly this for the same condition (a rootless destination
 * keeps the real project id and takes the managed contract), so this brings the
 * creation path in line with the move path rather than inventing a rule.
 *
 * Returns the context unchanged when there is nothing to repair, so callers can
 * assign the result unconditionally.
 */
export function repairManagedContextProjectId<T extends SessionExecutionContext>(
  context: T | undefined,
  sessionProjectId: string | undefined
): T | undefined {
  if (!context) return context
  if (context.projectId) return context
  const repaired = sessionProjectId?.trim()
  if (!repaired) return context
  return { ...context, projectId: repaired }
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
    execution: {
      mode:
        location === "local"
          ? "local"
          : input.environmentKind === "permanent"
            ? "permanent"
            : "managed",
      ...(input.environmentId ? { environmentId: input.environmentId } : {}),
      ...(input.bundleId ? { bundleId: input.bundleId } : {}),
      base:
        input.base ??
        (input.baseRef ? { kind: "gitRef", gitRef: input.baseRef } : { kind: "workingState" }),
      roots:
        input.rootLeases ??
        (input.projectRoot
          ? [
              {
                logicalRootId: input.rootId ?? "primary",
                role: "primary" as const,
                aliasPath: input.projectRoot,
              },
            ]
          : []),
    },
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

export function bindExecutionBundleTurn(
  context: SessionExecutionContext,
  bundleTurnId: string,
  primaryRunId?: string
): SessionExecutionContext {
  return {
    ...context,
    taskWorkspace: {
      ...context.taskWorkspace,
      ...(primaryRunId ? { runId: primaryRunId } : {}),
      bundleTurnId,
    },
  }
}

export function transitionManagedWorktree(
  context: SessionExecutionContext,
  state: ManagedWorktreeLifecycleState,
  now: number
): SessionExecutionContext {
  if (context.location !== "managedWorktree" || !context.lifecycle) {
    throw new Error("Managed worktree transition requires a managed-worktree context")
  }
  return {
    ...context,
    lifecycle: { ...context.lifecycle, state, updatedAt: now },
  }
}

/** Scheduled setup failures are never bypassable. */
export function canBypassEnvironmentSetup(surface: "interactive" | "scheduled"): boolean {
  return surface === "interactive"
}

/** Resolve only an explicitly available device-local root; never guess one. */
export function resolveSessionWorkspaceRoot(context: SessionExecutionContext): string | undefined {
  const primary = context.execution?.roots.find((root) => root.role === "primary")
  if (primary) return primary.aliasPath
  if (context.workspaceBinding?.kind !== "managed") return context.projectRoot || undefined
  return context.managedWorkspace?.availability === "available"
    ? context.managedWorkspace.localRoot
    : undefined
}
