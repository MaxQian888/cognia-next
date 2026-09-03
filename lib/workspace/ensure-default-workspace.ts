/**
 * Give a brand-new install a real directory to work in, without asking.
 *
 * The Default workspace is created with `roots: []`
 * (`lib/db/project-defaults.ts`), and `components/onboarding/workspace-setup.tsx`
 * is deliberately a line rather than a gate — so a user who skips it (and the
 * express path never even renders it) reaches chat with no directory at all.
 * `resolveEffectiveCwd` then resolves to nothing, the session falls back to a
 * managed identity, and the first thing the agent is asked to do with a file
 * fails. That is the state this closes: the second chance at the same repair,
 * taken automatically at the moment it would otherwise bite.
 *
 * Every piece here already existed and is reused unchanged —
 * `resolveProjectsRoot` → `proposeWorkspacePath` → `createWorkspaceFromScratch`
 * → `openPathAsWorkspace`. What was missing was a caller that runs them without
 * a human clicking.
 *
 * A NEW workspace, never a root grafted onto Default: workspace trust resolves
 * through `session.projectId`, and every pre-existing session is attributed to
 * `project-default`, so giving Default a root would flip the whole existing
 * population into Restricted Mode at once. Creating a workspace restricts only
 * the sessions that go on to use it — and this pairs the directory with a
 * `trustWorkspace` write in the same step, because the app made the directory
 * itself, which is precisely the question trust asks.
 */

import type { Project } from "@/types"
import { createApprovedWorkspaceDir, initApprovedGitRepository } from "./host-approved-fs"
import { trustWorkspace } from "@/lib/db/trusted-workspaces"
import { useProjectStore } from "@/stores/project/project-store"
import { createWorkspaceFromScratch, type CreateWorkspaceDeps } from "./create-workspace"
import { openPathAsWorkspace } from "./open-folder"
import { resolveProjectsRoot } from "./projects-root"
import { primaryRootOf } from "./roots"

/** Folder name for the auto-provisioned workspace, under `projectsRoot`. */
export const DEFAULT_WORKSPACE_FOLDER_NAME = "Cognia"

/**
 * Kill switch for automatic provisioning.
 *
 * Set to `"false"` to stop the send path creating a workspace on its own. It
 * fails **closed**: an unreadable storage (a private window, a browser that
 * blocks site data) leaves provisioning on, because the alternative — silently
 * refusing every send on a fresh install — is the failure this feature exists
 * to remove, and it looks identical to the app being broken.
 *
 * Turning it off never deletes a directory that was already created. The
 * workspace is the user's from the moment it exists, and a switch that removed
 * files would be a destructive action wearing a preference's clothes.
 */
export const AUTO_PROVISION_STORAGE_KEY = "cognia.workspace.auto-provision"

export function isAutoProvisionEnabled(
  storage: Storage | undefined = globalThis.localStorage
): boolean {
  if (process.env.NEXT_PUBLIC_WORKSPACE_AUTO_PROVISION === "0") return false
  try {
    return storage?.getItem(AUTO_PROVISION_STORAGE_KEY) !== "false"
  } catch {
    return true
  }
}

export type EnsureDefaultWorkspaceOutcome =
  | { kind: "existing"; project: Project }
  | { kind: "created"; project: Project; path: string; gitInitError?: unknown }
  | {
      kind: "unavailable"
      reason: "no-local-filesystem" | "create-failed" | "auto-provision-disabled"
      cause?: unknown
    }

export interface EnsureDefaultWorkspaceDeps extends CreateWorkspaceDeps {
  /** Workspaces as the store currently holds them. */
  listProjects: () => readonly Project[]
  /** `<home>/Projects` or the configured override; null off-desktop. */
  resolveParentDir: () => Promise<string | null>
  /** Records the directory as trusted. The app created it, so it is. */
  trust: (path: string) => Promise<void>
  folderName?: string
  /** Kill-switch read. Defaults to {@link isAutoProvisionEnabled}. */
  isEnabled?: () => boolean
}

/**
 * Resolve a workspace that has a directory, provisioning one if none does.
 *
 * Never throws: a failure to provision is an outcome the caller renders, not an
 * exception that takes the turn down. `unavailable` is the honest answer on a
 * browser with no host — there is no local filesystem to make a directory in.
 */
export async function ensureDefaultWorkspace(
  deps: EnsureDefaultWorkspaceDeps
): Promise<EnsureDefaultWorkspaceOutcome> {
  const rooted = deps
    .listProjects()
    .find((project) => !project.isArchived && primaryRootOf(project))
  // Checked before the kill switch on purpose: an existing rooted workspace is
  // a fact, not a provisioning decision, and reporting it as "disabled" would
  // make the switch look like it had broken something it never touched.
  if (rooted) return { kind: "existing", project: rooted }

  if (!(deps.isEnabled ?? isAutoProvisionEnabled)()) {
    return { kind: "unavailable", reason: "auto-provision-disabled" }
  }

  const parentDir = await deps.resolveParentDir().catch(() => null)
  if (!parentDir) return { kind: "unavailable", reason: "no-local-filesystem" }

  const result = await createWorkspaceFromScratch(
    {
      parentDir,
      name: deps.folderName ?? DEFAULT_WORKSPACE_FOLDER_NAME,
      // A repository makes the managed-worktree contract and every diff surface
      // meaningful. `createWorkspaceFromScratch` already treats a failed init as
      // non-fatal, so this cannot cost us the directory.
      initGit: true,
    },
    deps
  )
  if (!result.ok) return { kind: "unavailable", reason: "create-failed", cause: result.reason }

  // Trust before returning, so the caller never hands back a workspace that is
  // usable for chat and silently Restricted for tools.
  await deps.trust(result.path).catch(() => undefined)
  return {
    kind: "created",
    project: result.project,
    path: result.path,
    ...(result.gitInitError ? { gitInitError: result.gitInitError } : {}),
  }
}

/**
 * Production wiring, identical to what `NewWorkspaceDialog` hands the same
 * pipeline — the filesystem steps go through `transport.call`, so this works
 * unchanged against a paired host.
 */
export function defaultEnsureDefaultWorkspaceDeps(
  configuredProjectsRoot: string | null | undefined
): EnsureDefaultWorkspaceDeps {
  return {
    listProjects: () => useProjectStore.getState().projects,
    resolveParentDir: () => resolveProjectsRoot(configuredProjectsRoot),
    // Approval-aware: both commands are `approval: "interactive"`, so against
    // a paired host a bare call creates nothing and answers
    // `interactive_approval_required`.
    createDir: createApprovedWorkspaceDir,
    initGit: initApprovedGitRepository,
    openAsWorkspace: openPathAsWorkspace,
    trust: (path) => trustWorkspace(path, "auto-provisioned default workspace"),
  }
}
