/**
 * Is this stack in a state that may be published, restacked, or merged — and
 * if not, what is the user supposed to do about it?
 *
 * Every problem here is one that produces a *plausible wrong result* rather
 * than an error. A layer that no longer contains its parent still publishes;
 * the pull request just quietly contains its parent's diff too. A layer checked
 * out in a worktree still restacks; that worktree just ends up showing changes
 * nobody made. So each problem carries the remedy, and the caller offers it
 * instead of printing "invalid stack".
 */

import type { GitStackLayerState } from "@/types/git"

import type { Stack } from "./model"
import { baseBranches } from "./model"

export type StackProblem =
  /** The branch does not exist yet — nothing has been pushed for this layer. */
  | { kind: "missingBranch"; branch: string }
  /** The layer no longer contains its parent: its diff includes the parent's. */
  | { kind: "behindParent"; branch: string; parent: string }
  /** The recorded parent is not the layer below it in this stack. */
  | { kind: "parentMismatch"; branch: string; recorded: string; expected: string }
  /** No parent recorded at all, so git does not know this layer is stacked. */
  | { kind: "parentUnrecorded"; branch: string; expected: string }
  /** Moving this layer would desynchronise a worktree from its own HEAD. */
  | { kind: "checkedOut"; branch: string; worktree: string }
  /**
   * Write access is only to a fork.
   *
   * A stack cannot exist across a fork boundary: a pull request's base must be
   * a branch in the target repository, and every layer above the bottom is
   * based on a branch that only exists in the fork. No forge supports this —
   * not GitHub's native stacks, not ghstack, not spr. Saying so is the only
   * honest answer; producing a stack whose middle layers target the trunk would
   * publish pull requests containing each other's work.
   */
  | { kind: "forkOnly"; repository: string }

/**
 * Every problem kind, as a runtime list.
 *
 * The panel builds a message key from the kind (`problem.${kind}`), which
 * `lint:i18n` cannot see. This is what the catalogue guard checks against, so a
 * new problem without a message fails a test rather than rendering a raw key at
 * the moment someone's stack is broken.
 */
export const STACK_PROBLEM_KINDS = [
  "missingBranch",
  "behindParent",
  "parentMismatch",
  "parentUnrecorded",
  "checkedOut",
  "forkOnly",
] as const

export type StackRemedy =
  | "none"
  /** Run a restack: the layers exist but no longer sit on each other. */
  | "restack"
  /** Push or create the missing branches first. */
  | "createBranch"
  /** Close or move the worktree holding a layer. */
  | "releaseWorktree"
  /** The recorded shape and the actual shape disagree; a person must choose. */
  | "repair"
  /** Nothing will make this work here. */
  | "blocked"

export interface StackVerdict {
  /** True only when the stack can be published or merged as it stands. */
  ok: boolean
  problems: StackProblem[]
  /** The single most useful next action, for a one-button surface. */
  remedy: StackRemedy
}

/** Every remedy, for the same catalogue guard. */
export const STACK_REMEDIES = [
  "none",
  "restack",
  "createBranch",
  "releaseWorktree",
  "repair",
  "blocked",
] as const

/**
 * Precedence when several things are wrong at once.
 *
 * Ordered by what has to happen first, not by severity: a restack cannot run
 * while a layer is checked out, and neither can run while a branch is missing.
 * Offering the deepest remedy first would fail on the shallower problem.
 */
const REMEDY_ORDER: StackRemedy[] = [
  "blocked",
  "createBranch",
  "releaseWorktree",
  "repair",
  "restack",
  "none",
]

function remedyFor(problem: StackProblem): StackRemedy {
  switch (problem.kind) {
    case "forkOnly":
      return "blocked"
    case "missingBranch":
      return "createBranch"
    case "checkedOut":
      return "releaseWorktree"
    case "parentMismatch":
      return "repair"
    case "parentUnrecorded":
    case "behindParent":
      return "restack"
  }
}

export interface ValidateStackInput {
  stack: Pick<Stack, "trunk" | "layers">
  /** Per-branch truth from `git_stack_validate`. */
  states: readonly GitStackLayerState[]
  /**
   * Set when the only push access is to a fork of the target repository.
   * Supplied by the forge adapter — git cannot know it.
   */
  forkOnlyRepository?: string
}

export function validateStack(input: ValidateStackInput): StackVerdict {
  const problems: StackProblem[] = []
  if (input.forkOnlyRepository) {
    problems.push({ kind: "forkOnly", repository: input.forkOnlyRepository })
  }

  const expectedBases = baseBranches(input.stack)
  const byBranch = new Map(input.states.map((state) => [state.branch, state]))
  const ordered = [...input.stack.layers].sort((left, right) => left.order - right.order)

  for (const layer of ordered) {
    const state = byBranch.get(layer.branch)
    if (!state || state.head === null) {
      problems.push({ kind: "missingBranch", branch: layer.branch })
      // Everything below depends on the branch existing; reporting that it is
      // also behind its parent would just be noise.
      continue
    }
    if (state.checkedOutIn) {
      problems.push({
        kind: "checkedOut",
        branch: layer.branch,
        worktree: state.checkedOutIn,
      })
    }
    const expected = expectedBases.get(layer.branch)
    if (expected) {
      if (state.parent === null) {
        problems.push({ kind: "parentUnrecorded", branch: layer.branch, expected })
      } else if (state.parent !== expected) {
        problems.push({
          kind: "parentMismatch",
          branch: layer.branch,
          recorded: state.parent,
          expected,
        })
        // A mismatch means `containsParent` was answered about the WRONG
        // parent, so it says nothing about this stack.
        continue
      }
    }
    if (!state.containsParent) {
      problems.push({
        kind: "behindParent",
        branch: layer.branch,
        parent: expected ?? state.parent ?? input.stack.trunk,
      })
    }
  }

  const remedy = problems
    .map(remedyFor)
    .sort((left, right) => REMEDY_ORDER.indexOf(left) - REMEDY_ORDER.indexOf(right))[0]

  return { ok: problems.length === 0, problems, remedy: remedy ?? "none" }
}

/**
 * Whether a verdict permits publishing.
 *
 * Deliberately stricter than "no blocking problem": an unrecorded parent is
 * harmless to git and fatal to a pull request, because the base branch is
 * computed from it.
 */
export function canPublish(verdict: StackVerdict): boolean {
  return verdict.ok
}

/**
 * Whether a restack would fix what is wrong.
 *
 * A stack that is only behind can be repaired by a machine. One with a missing
 * branch, a contradicting pointer, or a fork boundary cannot, and offering the
 * button anyway teaches people that the button does not work.
 */
export function canRestack(verdict: StackVerdict): boolean {
  return (
    verdict.problems.length > 0 &&
    verdict.problems.every((problem) => remedyFor(problem) === "restack")
  )
}
