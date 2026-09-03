/**
 * Branches and worktrees (ADR-0129). Nineteen providers and none of them could
 * find a branch by name, so the one thing a person opens Source Control to do
 * had no keyboard route.
 *
 * Two providers rather than one because the registry keys by `kind`, the same
 * shape `library.ts` and `host.ts` already use.
 *
 * # Why these rows and no others
 *
 * A provider runs on every keystroke, so it reads `useGitStore`, an O(1)
 * synchronous snapshot the fs watcher already keeps fresh, and nothing else.
 * `cache: false` for the same reason: there is nothing to amortise, and a TTL
 * would only let the palette show a branch list older than the panel beside it.
 *
 * Deliberately not indexed:
 *
 *  - **commits.** `git log` search is a different feature, and the timeline
 *    filter already owns it. Running it per keystroke is not that feature.
 *  - **stacks.** A stack has no name a person types. It is identified by its
 *    tip branch, which the branch provider already returns.
 *
 * # Rows reveal, they never mutate
 *
 * Enter binds the panel to the right repository and reveals Source Control. It
 * does NOT check out. A working-tree switch from a fuzzy match is the worst
 * outcome a palette can produce, and the panel it lands on offers the checkout
 * with its own gate and its own placement rules.
 */

import { GitBranchIcon, FolderGitIcon } from "lucide-react"

import {
  describePlacement,
  isAgentBranch,
  worktreeLabel,
  worktreeTargetFor,
} from "@/lib/git/branch-placement"
import { isSourceControlUiAvailable } from "@/lib/git/commands"
import { useGitStore } from "@/stores/git/git-store"
import type { GitBranch, GitWorktree } from "@/types/git"

import { createListProvider } from "./list-provider"
import type { GlobalSearchItem } from "../types"

export const GIT_BRANCHES_PROVIDER_ID = "builtin.git-branches"
export const GIT_WORKTREES_PROVIDER_ID = "builtin.git-worktrees"

export interface GitSearchSnapshot {
  rootDir: string | null
  branches: readonly GitBranch[]
  worktrees: readonly GitWorktree[]
}

function readStore(): GitSearchSnapshot {
  const state = useGitStore.getState()
  return { rootDir: state.rootDir, branches: state.branches, worktrees: state.worktrees }
}

export interface GitProviderDeps {
  readSnapshot: () => GitSearchSnapshot
  /** Whether the Source Control surface is offered on this client at all. */
  available: () => boolean
}

const defaultDeps: GitProviderDeps = {
  readSnapshot: readStore,
  available: isSourceControlUiAvailable,
}

/**
 * Where a row sends you: `/source-control`, bound to `target`.
 *
 * A `navigate` action with a query param rather than a callback that pushes,
 * which is the idiom every other provider here already uses (`/devices?device=`).
 * It goes through the dialog's router, so it works in the desktop shell and a
 * browser tab alike, and the link is shareable.
 *
 * A branch living in another worktree points at THAT worktree, so the row lands
 * where the branch actually is rather than on a panel that then has to explain
 * it is looking somewhere else.
 */
export function sourceControlHref(target: string | null): string {
  return target
    ? `${SOURCE_CONTROL_PATH}?${SOURCE_CONTROL_ROOT_PARAM}=${encodeURIComponent(target)}`
    : SOURCE_CONTROL_PATH
}

const SOURCE_CONTROL_PATH = "/source-control"

/** `?root=` on `/source-control`: which repository or worktree to bind to. */
export const SOURCE_CONTROL_ROOT_PARAM = "root"

export function createGitBranchesProvider(deps: GitProviderDeps = defaultDeps) {
  return createListProvider<GitBranch>({
    id: GIT_BRANCHES_PROVIDER_ID,
    kind: "git-branch",
    cache: false,
    load: () => (deps.available() ? deps.readSnapshot().branches : []),
    getTitle: (branch) => branch.name,
    getSecondary: (branch) => {
      const placement = describePlacement(branch)
      if (placement.kind === "otherWorktree") return worktreeLabel(placement.path)
      return branch.upstream ?? undefined
    },
    getKeywords: (branch) => {
      const placement = describePlacement(branch)
      const words: string[] = []
      if (placement.kind === "otherWorktree") words.push(worktreeLabel(placement.path), "worktree")
      if (placement.kind === "remoteOnly") words.push(placement.remote, "remote")
      if (isAgentBranch(branch.name)) words.push("agent")
      return words
    },
    toItem: ({ row, match }, ctx): GlobalSearchItem => {
      const placement = describePlacement(row)
      const snapshot = deps.readSnapshot()
      // Rebind to the worktree that actually holds it, when one does.
      const target =
        placement.kind === "otherWorktree" && snapshot.rootDir
          ? worktreeTargetFor(snapshot.rootDir, placement.path)
          : snapshot.rootDir
      return {
        id: `git-branch:${row.isRemote ? "r" : "l"}:${row.name}`,
        kind: "git-branch",
        title: row.name,
        titlePositions: match.positions,
        subtitle:
          placement.kind === "otherWorktree"
            ? ctx.t("globalSearch.git.inWorktree", { name: worktreeLabel(placement.path) })
            : (row.upstream ?? undefined),
        icon: { lucide: GitBranchIcon },
        score: match.score,
        extra: { current: row.isCurrent },
        action: { type: "navigate", href: sourceControlHref(target) },
      }
    },
  })
}

export function createGitWorktreesProvider(deps: GitProviderDeps = defaultDeps) {
  return createListProvider<GitWorktree>({
    id: GIT_WORKTREES_PROVIDER_ID,
    kind: "git-worktree",
    cache: false,
    load: () => (deps.available() ? deps.readSnapshot().worktrees : []),
    getTitle: (worktree) => worktreeLabel(worktree.path),
    getSecondary: (worktree) => worktree.branch ?? undefined,
    getKeywords: (worktree) => {
      const words = [worktree.path]
      if (worktree.branch) words.push(worktree.branch)
      if (worktree.locked) words.push("locked")
      if (worktree.isMain) words.push("main")
      return words
    },
    toItem: ({ row, match }, ctx): GlobalSearchItem => {
      const snapshot = deps.readSnapshot()
      const target = snapshot.rootDir ? worktreeTargetFor(snapshot.rootDir, row.path) : null
      return {
        id: `git-worktree:${row.path}`,
        kind: "git-worktree",
        title: worktreeLabel(row.path),
        titlePositions: match.positions,
        subtitle: row.branch ?? ctx.t("globalSearch.git.detached"),
        icon: { lucide: FolderGitIcon },
        score: match.score,
        extra: { current: row.isMain },
        action: { type: "navigate", href: sourceControlHref(target) },
      }
    },
  })
}

export const gitBranchesProvider = createGitBranchesProvider()
export const gitWorktreesProvider = createGitWorktreesProvider()
