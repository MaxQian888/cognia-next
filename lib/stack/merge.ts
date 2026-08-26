/**
 * Landing a stack, bottom layer first.
 *
 * # The problem every stack tool has here
 *
 * Merging the bottom layer changes the trunk, and every layer above it is
 * based on commits that are no longer how the trunk got there. With a squash
 * or a rebase merge the bottom layer's commits are REWRITTEN into the trunk, so
 * layer 2 still carries the originals: retarget it to the trunk and its pull
 * request shows layer 1's diff a second time, as a conflict.
 *
 * The fix is not a special case. After each merge the remaining layers are
 * restacked onto the trunk — which drops the now-duplicated commits — pushed,
 * and only then retargeted. With a merge-commit method the restack finds the
 * ancestry already intact and does nothing, so the same sequence is correct
 * for all three methods and free where it is unnecessary.
 *
 * Order matters within that: restack, push, THEN retarget. Retargeting first
 * leaves the pull request showing every layer below it until the push lands,
 * which is exactly when a reviewer is looking at it.
 *
 * # Idempotent
 *
 * A stack merge is a sequence of network calls that can fail halfway. Running
 * it again skips what is already merged rather than erroring, because the
 * alternative is finishing the job by hand.
 */

import type { Stack, StackLayer } from "./model"
import type { ForgeMergeMethod, ForgeObservation, ForgeStackAdapter } from "./forge/types"
import { restackStack, type RestackDeps, type RestackStackResult } from "./restack"

/**
 * Every reason a layer can be refused, as a runtime list.
 *
 * A surface builds its message key from the reason (`mergeBlocked.${reason}`),
 * which `lint:i18n` cannot see. A new reason without a sentence would render a
 * raw key at the moment somebody's merge stopped, so the list is exported and
 * a catalogue test checks it rather than a person remembering.
 */
export const MERGE_BLOCK_REASONS = [
  "noPullRequest",
  "ciFailing",
  "ciPending",
  "ciUnknown",
  "changesRequested",
  "reviewRequired",
  "conflict",
  "notMergeable",
] as const

export type MergeBlockReason = (typeof MERGE_BLOCK_REASONS)[number]

/**
 * Whether this layer may be merged, or why not.
 *
 * `ci: "none"` passes — a repository with no checks configured must still be
 * able to land a stack. `ci: "unknown"` does not: it means the state could not
 * be read, and merging on an unread signal is how a red stack lands.
 */
export function mergeBlockReason(observation: ForgeObservation): MergeBlockReason | null {
  if (observation.conflict) return "conflict"
  switch (observation.ci) {
    case "failing":
      return "ciFailing"
    case "pending":
      return "ciPending"
    case "unknown":
      return "ciUnknown"
    case "none":
    case "passing":
      break
  }
  if (observation.review === "changesRequested") return "changesRequested"
  if (observation.review === "reviewRequired") return "reviewRequired"
  if (!observation.mergeable) return "notMergeable"
  return null
}

/**
 * The merge method to use, given what the repository allows.
 *
 * Branch-per-layer prefers a squash: one layer is one logical change and its
 * intermediate commits are workspace noise. Commit-per-pull-request must not
 * squash — each commit IS a pull request, and collapsing it destroys the
 * `Cognia-Change-Id` trailer that identifies the next one.
 *
 * Returns null when the repository allows none of the acceptable methods,
 * which is a refusal rather than a fallback: merging a commit-per-PR stack by
 * squash would silently break every layer above it.
 */
export function chooseMergeMethod(
  model: Stack["model"],
  allowed: readonly ForgeMergeMethod[],
  preferred?: ForgeMergeMethod
): ForgeMergeMethod | null {
  const acceptable: ForgeMergeMethod[] =
    model === "commitPerPullRequest" ? ["rebase", "merge"] : ["squash", "merge", "rebase"]
  if (preferred && acceptable.includes(preferred) && allowed.includes(preferred)) {
    return preferred
  }
  return acceptable.find((method) => allowed.includes(method)) ?? null
}

export interface MergeStackInput {
  stack: Stack
  repository: string
  adapter: ForgeStackAdapter
  /** Overrides the model's preference, when the repository allows it. */
  method?: ForgeMergeMethod
  /** Push the restacked remainder after each merge. Omit for local-only. */
  remote?: string
  /** Told what moved after each intermediate restack. */
  announce?: (result: Extract<RestackStackResult, { status: "restacked" }>) => Promise<void>
}

export interface MergedLayer {
  branch: string
  pullRequest: number
  method: ForgeMergeMethod
}

export type MergeStackResult =
  /** The repository allows none of the methods this stack's model can use. */
  | { status: "unsupportedMethod"; allowed: ForgeMergeMethod[] }
  /** A layer is not ready. Everything below it is already merged. */
  | {
      status: "blocked"
      branch: string
      pullRequest: number | null
      reason: MergeBlockReason
      merged: MergedLayer[]
    }
  /** Restacking the remainder onto the trunk hit a conflict a person must resolve. */
  | {
      status: "conflict"
      branch: string
      worktree: string
      merged: MergedLayer[]
    }
  /** Restacking the remainder was refused — the stack is not in a fit state. */
  | {
      status: "restackRefused"
      result: RestackStackResult
      merged: MergedLayer[]
    }
  | { status: "merged"; merged: MergedLayer[] }

export interface MergeStackDeps {
  restack: typeof restackStack
  setParent: RestackDeps["setParent"]
}

const DEFAULT_DEPS: MergeStackDeps = {
  restack: restackStack,
  setParent: async (repositoryRoot, branch, parent) => {
    const { gitStackSetParent } = await import("@/lib/git/commands")
    return gitStackSetParent(repositoryRoot, branch, parent)
  },
}

export async function mergeStack(
  input: MergeStackInput,
  deps?: Partial<MergeStackDeps>
): Promise<MergeStackResult> {
  const resolved: MergeStackDeps = { ...DEFAULT_DEPS, ...deps }
  const capabilities = await input.adapter.capabilities(input.repository)
  const method = chooseMergeMethod(
    input.stack.model,
    capabilities.allowedMergeMethods,
    input.method
  )
  if (!method) {
    return { status: "unsupportedMethod", allowed: [...capabilities.allowedMergeMethods] }
  }

  const ordered = [...input.stack.layers].sort((left, right) => left.order - right.order)
  const merged: MergedLayer[] = []

  for (const [index, layer] of ordered.entries()) {
    const number = layer.pullRequest?.number ?? null
    if (number === null) {
      return {
        status: "blocked",
        branch: layer.branch,
        pullRequest: null,
        reason: "noPullRequest",
        merged,
      }
    }
    const observation = await input.adapter.observe(input.repository, number)
    if (!observation.merged) {
      const blocked = mergeBlockReason(observation)
      if (blocked) {
        return {
          status: "blocked",
          branch: layer.branch,
          pullRequest: number,
          reason: blocked,
          merged,
        }
      }
      await input.adapter.merge(input.repository, number, method)
    }
    merged.push({ branch: layer.branch, pullRequest: number, method })

    const remaining = ordered.slice(index + 1)
    if (remaining.length === 0) break

    const outcome = await settleRemainder({
      input,
      remaining,
      deps: resolved,
    })
    if (outcome.status === "conflict") {
      return { status: "conflict", branch: outcome.branch, worktree: outcome.worktree, merged }
    }
    if (outcome.status === "refused") {
      return { status: "restackRefused", result: outcome.result, merged }
    }
  }

  return { status: "merged", merged }
}

type SettleOutcome =
  | { status: "ok" }
  | { status: "conflict"; branch: string; worktree: string }
  | { status: "refused"; result: RestackStackResult }

/**
 * Put the layers above a just-merged one back on the trunk.
 *
 * The parent pointer is rewritten first so the restack — and every later
 * validation — agrees that the layer below is gone. Then restack + push, then
 * retarget the pull request, in that order.
 */
async function settleRemainder(args: {
  input: MergeStackInput
  remaining: StackLayer[]
  deps: MergeStackDeps
}): Promise<SettleOutcome> {
  const { input, remaining, deps } = args
  const next = remaining[0]
  if (!next) return { status: "ok" }

  await deps.setParent(input.stack.repositoryRoot, next.branch, input.stack.trunk)

  const result = await deps.restack({
    stack: {
      ...input.stack,
      layers: remaining.map((layer, order) => ({ ...layer, order })),
    },
    onto: input.stack.trunk,
    ...(input.remote ? { remote: input.remote } : {}),
  })
  if (result.status === "conflict") {
    return { status: "conflict", branch: result.branch, worktree: result.worktree }
  }
  if (result.status === "refused") {
    return { status: "refused", result }
  }
  if (result.status === "restacked" && input.announce) {
    await input.announce(result)
  }

  // Last, and only now: the branch on the remote is the restacked one, so the
  // pull request's diff is right the moment its base changes.
  if (next.pullRequest && next.pullRequest.baseBranch !== input.stack.trunk) {
    await input.adapter.retarget(input.repository, next.pullRequest.number, input.stack.trunk)
    next.pullRequest.baseBranch = input.stack.trunk
  }
  return { status: "ok" }
}
