import type {
  Project,
  ProjectCoordinatorConfig,
  ProjectCoordinatorPreferences,
  ProjectThreadExecution,
} from "@/types"
import type { WorkspaceRoot } from "@/types/workspace"
import type { SessionExecutionLocation } from "@/types/execution-context"
import { primaryRootOf } from "@/lib/workspace/roots"

/**
 * Defaults and read helpers for `Project.coordinator` (ADR-0204). Every reader
 * goes through here so an absent or partially-written config means one thing.
 */

/** Hard cap on threads created per local day when the user set none. */
export const DEFAULT_DAILY_THREAD_CAP = 20
/** Upper bound the settings UI and `set_project_preference` accept. */
export const MAX_DAILY_THREAD_CAP = 200
export const MAX_CONCURRENT_THREADS_LIMIT = 16
/** Same budget as workspace instructions — the goal is one line, not a brief. */
export const PROJECT_GOAL_MAX_CHARS = 500

export interface ResolvedCoordinatorPreferences {
  maxConcurrentThreads?: number
  proposeBeforeStart: boolean
  dailyThreadCap: number
  autoFixPr: boolean
}

export interface ResolvedCoordinatorConfig {
  enabled: boolean
  sessionId?: string
  goal?: string
  threadExecution: ProjectThreadExecution
  preferences: ResolvedCoordinatorPreferences
  paused?: ProjectCoordinatorConfig["paused"]
  model: NonNullable<ProjectCoordinatorConfig["model"]>
  icon?: string
  setupOfferedAt?: number
}

function clampInt(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

export function resolveCoordinatorPreferences(
  prefs: ProjectCoordinatorPreferences | undefined
): ResolvedCoordinatorPreferences {
  const maxConcurrentThreads = clampInt(
    prefs?.maxConcurrentThreads,
    1,
    MAX_CONCURRENT_THREADS_LIMIT
  )
  return {
    ...(maxConcurrentThreads !== undefined ? { maxConcurrentThreads } : {}),
    proposeBeforeStart: prefs?.proposeBeforeStart === true,
    dailyThreadCap:
      clampInt(prefs?.dailyThreadCap, 1, MAX_DAILY_THREAD_CAP) ?? DEFAULT_DAILY_THREAD_CAP,
    autoFixPr: prefs?.autoFixPr === true,
  }
}

export function resolveCoordinatorConfig(
  project: Pick<Project, "coordinator"> | null | undefined
): ResolvedCoordinatorConfig {
  const raw = project?.coordinator
  const goal = raw?.goal?.trim()
  const icon = raw?.icon?.trim()
  return {
    enabled: raw?.enabled === true,
    ...(raw?.sessionId ? { sessionId: raw.sessionId } : {}),
    ...(goal ? { goal: goal.slice(0, PROJECT_GOAL_MAX_CHARS) } : {}),
    threadExecution: raw?.threadExecution ?? "auto",
    preferences: resolveCoordinatorPreferences(raw?.preferences),
    ...(raw?.paused ? { paused: raw.paused } : {}),
    model: raw?.model ?? {},
    ...(icon ? { icon } : {}),
    ...(raw?.setupOfferedAt ? { setupOfferedAt: raw.setupOfferedAt } : {}),
  }
}

/** Coordination is on for this workspace. */
export function isCoordinatorEnabled(project: Pick<Project, "coordinator"> | null | undefined) {
  return project?.coordinator?.enabled === true
}

/**
 * A coordinator or thread gets its project tools, protocol and goal only while
 * coordination is on for its workspace — turning it off returns every such
 * conversation to an ordinary one without touching the rows.
 */
export function projectRoleToolsApply(
  session: { projectRole?: "coordinator" | "thread" } | null | undefined,
  project: Pick<Project, "coordinator"> | null | undefined
): boolean {
  return Boolean(session?.projectRole) && isCoordinatorEnabled(project)
}

/** Workspace is paused (ADR-0204): no turn in it may start until resumed. */
export function isProjectPausedConfig(
  project: Pick<Project, "coordinator"> | null | undefined
): boolean {
  return Boolean(project?.coordinator?.paused)
}

/**
 * The root a thread works in: the named one when it belongs to the workspace,
 * otherwise the primary root. Returns undefined for a rootless workspace.
 */
export function resolveThreadRoot(
  project: Pick<Project, "roots">,
  rootId: string | undefined
): WorkspaceRoot | undefined {
  if (rootId) {
    const named = project.roots?.find((root) => root.id === rootId)
    if (named) return named
  }
  return primaryRootOf(project)
}

export interface ThreadExecutionDeps {
  isGitRepo: (path: string) => Promise<boolean>
}

/**
 * Where a new thread runs. `auto` isolates a thread in a managed worktree only
 * when its root is a git repository — a non-git directory has no branch to
 * isolate onto, and a rootless workspace has nothing to isolate at all.
 * A failed probe reads as "not git": sharing the directory is the safe
 * default, never a worktree against a repo we could not see.
 */
export async function resolveThreadExecutionLocation(
  project: Pick<Project, "roots" | "coordinator">,
  rootId: string | undefined,
  deps: ThreadExecutionDeps
): Promise<SessionExecutionLocation> {
  const mode = resolveCoordinatorConfig(project).threadExecution
  if (mode !== "auto") return mode
  const root = resolveThreadRoot(project, rootId)
  if (!root) return "local"
  try {
    return (await deps.isGitRepo(root.path)) ? "managedWorktree" : "local"
  } catch {
    return "local"
  }
}

/** Merge a partial config patch onto the stored one, keeping `enabled` explicit. */
export function patchCoordinatorConfig(
  current: ProjectCoordinatorConfig | undefined,
  patch: Partial<ProjectCoordinatorConfig>
): ProjectCoordinatorConfig {
  return {
    ...current,
    ...patch,
    enabled: patch.enabled ?? current?.enabled ?? false,
    ...(patch.preferences || current?.preferences
      ? { preferences: { ...current?.preferences, ...patch.preferences } }
      : {}),
  }
}
