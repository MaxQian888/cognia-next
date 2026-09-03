/**
 * The two filesystem steps that create a workspace, with the approval a paired
 * host demands for them.
 *
 * `fs_create_workspace_dir` and `git_init` are both `approval: "interactive"`
 * in `protocol/companion-commands.json`, so
 * `remote_execution::authorize_approval` refuses either one unless the request
 * carries a current device-bound `adminLease`. Both were called bare by the
 * workspace-creation pipeline, which meant every "New workspace" from a browser
 * or phone answered `interactive_approval_required` and created nothing, and
 * the automatic first-run provisioning fell through to a managed identity that
 * no companion can materialize. On the desktop neither call needs a lease, so
 * the whole pipeline looked fine from the only shell anyone tested it in.
 *
 * The repair is the one the rest of the app already uses: mint one exact
 * 120-second lease around the call. Nothing here is a new grant. The lease is
 * minted by the device itself only when it is the tenant's Owner device, which
 * `host_admin_lease_issue` already allows precisely so a deployment with one
 * paired device is not deadlocked. Every other device gets a consent ask on the
 * host and this refuses until someone answers it.
 *
 * Each plane keeps its own queue, because each attaches the token in its own
 * transport shim: the workspace lease rides `approvalAwareTransport`, and
 * `git_init` goes through `lib/git/commands.ts`, whose shim reads the git
 * queue. Crossing them would mint a lease nothing picks up.
 */

import { isDescendant, stripTrailingSep } from "@/lib/claude/instructions/paths"
import { listWorkspaceRoots } from "@/lib/files/workspace-fs"
import type { WorkspaceRoot } from "@/lib/files/types"
import { gitInit, runGitUserAction } from "@/lib/git/commands"
import { gitTargetFromRemote } from "@/lib/git/target"
import { getRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"
import { approvalAwareTransport, runWorkspaceUserAction } from "@/lib/task-workspace/user-action"

/**
 * Create `root`/`relPath` on whichever machine owns the workspace.
 *
 * Shape-compatible with `createWorkspaceDir` from `lib/files/workspace-fs.ts`,
 * so it drops straight into `CreateWorkspaceDeps.createDir`.
 */
export async function createApprovedWorkspaceDir(root: string, relPath: string): Promise<void> {
  await runWorkspaceUserAction("fs_create_workspace_dir", () =>
    approvalAwareTransport.call<null>("fs_create_workspace_dir", { root, relPath })
  )
}

/**
 * Turn an absolute host path into the opaque target a remote `git_init` takes.
 *
 * `prepareGitTransportArgs` refuses an absolute `path` from any non-Tauri
 * shell, because the remote git plane names a repository by workspace id and
 * never by a path the client chose. A headless Host's workspace id is the
 * directory name directly under its workspaces root
 * (`headless_workspace_dir_name`), which is exactly the root
 * `fs_workspace_roots` reported when this same module was asked where to
 * create the directory.
 *
 * A `desktop-project` root is deliberately not handled. Its id space is the
 * desktop's registered root id, which `fs_workspace_roots` does not report, so
 * deriving one would be a guess that fails at the Host instead of here.
 */
export async function remoteGitTargetForHostPath(
  path: string,
  roots: readonly WorkspaceRoot[]
): Promise<string> {
  const absolute = stripTrailingSep(path.trim())
  const root = roots.find(
    (candidate) =>
      candidate.source === "headless-workspaces-dir" &&
      isDescendant(stripTrailingSep(candidate.path.trim()), absolute)
  )
  if (!root) {
    throw new Error(`no headless workspaces root contains ${absolute}`)
  }
  const relative = absolute.slice(stripTrailingSep(root.path.trim()).length).replace(/^[\\/]+/, "")
  const [workspaceId, ...rest] = relative.split(/[\\/]+/).filter(Boolean)
  if (!workspaceId) throw new Error(`${absolute} is the workspaces root itself`)
  return gitTargetFromRemote(workspaceId, rest.join("/"))
}

/**
 * `git init` the directory that was just created.
 *
 * The no-target short-circuit is the same one `runWorkspaceUserAction` makes
 * and for the same reason: with no client target this shell IS the execution
 * host, so there is no host to mint a lease from. `runGitUserAction` gates on
 * `isTauri()` instead, which is also false in the headless brain, and asking
 * that process for a lease would fail a call that needs none.
 *
 * A throw here is not fatal to workspace creation:
 * `createWorkspaceFromScratch` keeps the directory and reports `gitInitError`,
 * because a usable directory with no repository beats one orphaned on disk.
 */
export async function initApprovedGitRepository(path: string): Promise<void> {
  if (!getRuntimeSnapshot().target) {
    await gitInit(path)
    return
  }
  const target = await remoteGitTargetForHostPath(path, await listWorkspaceRoots())
  await runGitUserAction("git_init", () => gitInit(target))
}
