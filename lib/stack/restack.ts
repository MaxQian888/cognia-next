/**
 * Moving a whole stack, and everything that has to be true for that to be safe.
 *
 * The git work itself is in `crates/cognia-git/src/stack.rs`. What lives here is
 * the order of operations around it:
 *
 *   1. ask git what is actually true (not what was recorded);
 *   2. refuse when a machine cannot fix what is wrong, and say what would;
 *   3. record the parent pointers the stack is missing, because that IS the fix
 *      for a layer git was never told about;
 *   4. move the branches;
 *   5. tell people what moved.
 *
 * Steps 2 and 5 are the ones that get skipped in a first implementation and are
 * the reason stack tools get a reputation. A restack that runs anyway on a
 * broken stack produces pull requests containing each other's diffs; one that
 * force-pushes silently leaves reviewers looking at commits that no longer
 * exist with no idea why.
 *
 * Every effect is injected. The default wiring reaches Tauri, which means the
 * only way this logic gets tested is if the seam is explicit.
 */

import type { GitRestackOutcome, GitStackLayerState, GitStackPushOutcome } from "@/types/git"

import { baseBranches, type Stack } from "./model"
import { canRestack, validateStack, type StackVerdict } from "./validate"

export interface RestackDeps {
  validate(repositoryRoot: string, branches: string[]): Promise<GitStackLayerState[]>
  restack(repositoryRoot: string, onto: string, branches: string[]): Promise<GitRestackOutcome>
  setParent(repositoryRoot: string, branch: string, parent: string | null): Promise<void>
  push(repositoryRoot: string, remote: string, branches: string[]): Promise<GitStackPushOutcome>
}

const DEFAULT_DEPS: RestackDeps = {
  validate: async (repositoryRoot, branches) => {
    const { gitStackValidate } = await import("@/lib/git/commands")
    return gitStackValidate(repositoryRoot, branches)
  },
  restack: async (repositoryRoot, onto, branches) => {
    const { gitStackRestack } = await import("@/lib/git/commands")
    return gitStackRestack(repositoryRoot, onto, branches)
  },
  setParent: async (repositoryRoot, branch, parent) => {
    const { gitStackSetParent } = await import("@/lib/git/commands")
    return gitStackSetParent(repositoryRoot, branch, parent)
  },
  push: async (repositoryRoot, remote, branches) => {
    const { gitStackPush } = await import("@/lib/git/commands")
    return gitStackPush(repositoryRoot, remote, branches)
  },
}

/** What a restack tells the layers' pull requests once their tips have moved. */
export interface RestackAnnouncement {
  branch: string
  from: string
  to: string
  /** The ref the old tip was pinned to, so the note can offer a way back. */
  historyRef: string
}

export interface RestackStackInput {
  stack: Stack
  /** New base for the bottom layer. Defaults to the stack's own trunk. */
  onto?: string
  /** Push the moved branches when set. Omit to restack locally only. */
  remote?: string
  /** From the forge adapter — git cannot know this. */
  forkOnlyRepository?: string
  /**
   * Told what moved, once, after the branches have moved and been pushed.
   *
   * Deliberately after the push: a note saying "your branch is now abc123"
   * published before abc123 exists on the remote sends every reader to a 404.
   */
  announce?: (announcements: RestackAnnouncement[]) => Promise<void>
}

export type RestackStackResult =
  /** Nothing to do — every layer already sits on the one below it. */
  | { status: "upToDate"; verdict: StackVerdict }
  /** Something a restack cannot fix. `verdict.remedy` says what would. */
  | { status: "refused"; verdict: StackVerdict }
  /** A layer stopped mid-rebase. The worktree is where it can be resolved. */
  | {
      status: "conflict"
      verdict: StackVerdict
      branch: string
      worktree: string
      /** Layers that moved before the conflict; each is undoable. */
      updates: RestackAnnouncement[]
    }
  | {
      status: "restacked"
      verdict: StackVerdict
      method: GitRestackOutcome["method"]
      updates: RestackAnnouncement[]
      /** Present only when `remote` was given. */
      pushed?: GitStackPushOutcome
    }

export async function restackStack(
  input: RestackStackInput,
  deps?: Partial<RestackDeps>
): Promise<RestackStackResult> {
  const resolved: RestackDeps = { ...DEFAULT_DEPS, ...deps }
  const root = input.stack.repositoryRoot
  const onto = input.onto ?? input.stack.trunk
  const ordered = [...input.stack.layers].sort((left, right) => left.order - right.order)
  const branches = ordered.map((layer) => layer.branch)

  const states = await resolved.validate(root, branches)
  const verdict = validateStack({
    stack: input.stack,
    states,
    ...(input.forkOnlyRepository ? { forkOnlyRepository: input.forkOnlyRepository } : {}),
  })
  if (verdict.ok) return { status: "upToDate", verdict }
  if (!canRestack(verdict)) return { status: "refused", verdict }

  // A layer git was never told about is not an error to report back — it is
  // the one problem in the list that this function is supposed to fix. Written
  // BEFORE the move so the native side sees the shape the caller intends, and
  // so a crash mid-restack leaves the stack recorded rather than anonymous.
  const bases = baseBranches(input.stack)
  for (const problem of verdict.problems) {
    if (problem.kind !== "parentUnrecorded") continue
    await resolved.setParent(root, problem.branch, bases.get(problem.branch) ?? onto)
  }

  const outcome = await resolved.restack(root, onto, branches)
  const updates: RestackAnnouncement[] = outcome.updates.map((update) => ({
    branch: update.branch,
    from: update.from,
    to: update.to,
    historyRef: update.historyRef,
  }))

  if (outcome.conflict) {
    return {
      status: "conflict",
      verdict,
      branch: outcome.conflict.branch,
      worktree: outcome.conflict.worktree,
      updates,
    }
  }

  let pushed: GitStackPushOutcome | undefined
  if (input.remote && updates.length) {
    pushed = await resolved.push(
      root,
      input.remote,
      updates.map((update) => update.branch)
    )
  }
  if (input.announce && updates.length) {
    await input.announce(updates)
  }

  return {
    status: "restacked",
    verdict,
    method: outcome.method,
    updates,
    ...(pushed ? { pushed } : {}),
  }
}

/**
 * The note left on a pull request whose branch a restack moved.
 *
 * Short and factual. A reviewer who opens a pull request to find their comments
 * attached to commits that no longer exist needs to know it was a restack and
 * not a rewrite of the work — and needs the old tip, which is why every update
 * carries the ref it was pinned to.
 */
export function restackNoteBody(announcements: readonly RestackAnnouncement[]): string {
  const lines = announcements.map(
    (update) =>
      `- \`${update.branch}\`: ${update.from.slice(0, 8)} → ${update.to.slice(0, 8)} (previous tip kept at \`${update.historyRef}\`)`
  )
  return [
    "This branch was restacked onto its updated base. The changes are the same; the commits are new.",
    "",
    ...lines,
  ].join("\n")
}
