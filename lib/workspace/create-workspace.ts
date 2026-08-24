/**
 * "New workspace" — create a directory that did not exist and land it as an
 * activated workspace.
 *
 * Modelled on the clone flow (`components/source-control/clone-repository-dialog.tsx`),
 * which was the only path in the app that produced a directory and ended at
 * `openPathAsWorkspace`. Both filesystem steps go through `transport.call`
 * (`fs_create_workspace_dir` / `git_init`), so this works unchanged against a
 * paired host: a phone or browser can start the creation and the directory is
 * made on the machine that will actually run the agent.
 */

import type { Project } from "@/types"
import { proposeWorkspacePath } from "./projects-root"

export interface CreateWorkspaceInput {
  /** Parent directory — normally the resolved `projectsRoot`. */
  parentDir: string | null | undefined
  name: string
  initGit: boolean
}

export interface CreateWorkspaceDeps {
  /** `createWorkspaceDir(root, relPath)` — parent + one segment. */
  createDir: (root: string, relPath: string) => Promise<void>
  initGit: (path: string) => Promise<void>
  openAsWorkspace: (path: string, name: string) => Project | null
}

export type CreateWorkspaceResult =
  | {
      ok: true
      project: Project
      path: string
      /** Set when the directory landed but `git init` did not. */
      gitInitError?: unknown
    }
  | { ok: false; reason: "no-parent" | "empty-name" | "escapes-parent" }
  | { ok: false; reason: "mkdir-failed" | "not-registered"; cause?: unknown }

export async function createWorkspaceFromScratch(
  input: CreateWorkspaceInput,
  deps: CreateWorkspaceDeps
): Promise<CreateWorkspaceResult> {
  const proposal = proposeWorkspacePath(input.parentDir, input.name)
  if (!proposal.ok) return { ok: false, reason: proposal.reason }

  try {
    await deps.createDir(input.parentDir!.trim(), proposal.folderName)
  } catch (cause) {
    return { ok: false, reason: "mkdir-failed", cause }
  }

  // A failed `git init` does NOT fail the creation. The directory exists and is
  // a perfectly usable workspace; refusing here would leave it orphaned on disk
  // with nothing in the app pointing at it, which is worse than an
  // un-initialized repository the user can init later from Source Control.
  let gitInitError: unknown
  if (input.initGit) {
    try {
      await deps.initGit(proposal.path)
    } catch (cause) {
      gitInitError = cause
    }
  }

  const project = deps.openAsWorkspace(proposal.path, input.name.trim())
  if (!project) return { ok: false, reason: "not-registered" }
  return { ok: true, project, path: proposal.path, ...(gitInitError ? { gitInitError } : {}) }
}
