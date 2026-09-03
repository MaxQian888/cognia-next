/**
 * Where a branch lives, and therefore what a row may offer to do with it.
 *
 * One module so the branch picker, the ⌘K provider and the workspace's
 * agent-branch list all reach the same verdict. They used to each render a
 * checkout button and let git decide, which is how the panel came to offer a
 * checkout of a branch a worktree of its own making already held.
 *
 * Pure by construction: everything here is a function of `GitBranch` plus the
 * repository the panel is currently bound to. No fetching, no store reads.
 */

import type { GitBranch } from "@/types/git"
import { gitTargetFromRemote, parseGitTarget } from "@/lib/git/target"

/** Where a branch is checked out, if anywhere. */
export type BranchPlacement =
  /** The checkout this panel is bound to. */
  | { kind: "here" }
  /** A different linked worktree of the same repository. */
  | { kind: "otherWorktree"; path: string; locked: boolean }
  /** A local branch no worktree holds. */
  | { kind: "free" }
  /** A remote-tracking ref, never checked out, since a worktree holds local refs. */
  | { kind: "remoteOnly"; remote: string; shortName: string }

/**
 * What a row's primary button should do.
 *
 * `openWorktree` is the whole point: git refuses to move a branch a second
 * worktree holds, so the useful action is to go to that worktree, not to
 * attempt a checkout that will fail.
 *
 * `createTracking` exists because `git checkout origin/x` detaches HEAD. What
 * a person means by "switch to origin/x" is `checkout -b x origin/x`, which
 * also sets the upstream.
 */
export type BranchPrimaryAction = "none" | "checkout" | "openWorktree" | "createTracking"

/**
 * Read a branch's placement.
 *
 * `isCurrent` is trusted over any path comparison. Over a companion the
 * panel's `rootDir` is an opaque `git-workspace:<id>` target while worktree
 * paths arrive workspace-relative, and even locally the two disagree under
 * symlinks (`/var` vs `/private/var` on macOS). `isCurrent` is git's own
 * answer for the repository actually opened, including when that repository
 * IS a linked worktree, so it is right in every case a path test is wrong.
 */
export function describePlacement(branch: GitBranch): BranchPlacement {
  if (branch.isRemote) {
    const slash = branch.name.indexOf("/")
    return slash === -1
      ? { kind: "remoteOnly", remote: "", shortName: branch.name }
      : {
          kind: "remoteOnly",
          remote: branch.name.slice(0, slash),
          shortName: branch.name.slice(slash + 1),
        }
  }
  if (branch.isCurrent) return { kind: "here" }
  if (branch.checkedOutIn !== null) {
    return { kind: "otherWorktree", path: branch.checkedOutIn, locked: branch.checkoutLocked }
  }
  return { kind: "free" }
}

/** The action a row's primary control should perform for this placement. */
export function primaryActionFor(placement: BranchPlacement): BranchPrimaryAction {
  switch (placement.kind) {
    case "here":
      return "none"
    case "otherWorktree":
      return "openWorktree"
    case "remoteOnly":
      return "createTracking"
    case "free":
      return "checkout"
  }
}

/**
 * Whether this branch can be deleted from the bound repository.
 *
 * Git refuses to delete a branch any worktree has checked out, and a
 * remote-tracking ref is not ours to delete with `branch -d`. Offering the
 * button anyway is how the picker produced failures it could have predicted.
 */
export function canDeleteBranch(branch: GitBranch): boolean {
  return describePlacement(branch).kind === "free"
}

/** The prefix every isolated run's branch carries (ADR-0111). */
export const AGENT_BRANCH_PREFIX = "agent/"

/** Whether an isolated run cut this branch. */
export function isAgentBranch(name: string): boolean {
  return name.startsWith(AGENT_BRANCH_PREFIX)
}

/** The worktree directory's last segment, for a label that fits a row. */
export function worktreeLabel(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "")
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  return cut === -1 ? trimmed : trimmed.slice(cut + 1)
}

/**
 * Index `[child, parent]` pairs so a row can name its stack parent in O(1).
 * Git config is the record (ADR-0151). This is only a lookup over it.
 */
export function stackParentIndex(
  pairs: readonly (readonly [string, string])[]
): ReadonlyMap<string, string> {
  return new Map(pairs.map(([child, parent]) => [child, parent]))
}

/**
 * The value to hand `setRootDir` to bind the panel to a worktree.
 *
 * On a desktop host a worktree path is already the coordinate system the
 * panel speaks, so it passes through. Over a companion the panel's `rootDir`
 * is an opaque `git-workspace:<id>` target while worktree paths arrive
 * workspace-relative, so the path has to be re-wrapped against the same
 * workspace or the panel binds to nothing.
 */
export function worktreeTargetFor(currentRootDir: string, worktreePath: string): string {
  const target = parseGitTarget(currentRootDir)
  return target.kind === "remote"
    ? gitTargetFromRemote(target.workspaceId, worktreePath)
    : worktreePath
}
