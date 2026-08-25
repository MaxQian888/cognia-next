/**
 * Finding the stacks in a repository, from the repository.
 *
 * There is no stack table. The parent pointers in git config are the whole
 * record, and everything a stack is — which branches, in what order, on which
 * trunk — falls out of walking them. A projection table would have to be kept
 * in step with `git branch -d`, `git branch -m`, a colleague's push, and a
 * checkout on another machine; the first time it disagreed with `git log` it
 * would be worse than not existing.
 *
 * What is NOT derivable from git is which pull request a branch has, and that
 * is not stored either — it is one lookup per branch against the forge, which
 * is also the only way to notice that somebody closed one.
 *
 * # A branch with two children is two stacks
 *
 * Nothing stops a person branching twice off the same layer, and the result is
 * two chains sharing a prefix. Each is returned separately, with the shared
 * layers appearing in both, because that is what they are: two independent
 * things to publish, restack and land, which happen to rest on the same work.
 */

import type { Stack, StackAuthoringModel } from "./model"

export interface DiscoverStacksDeps {
  /** Every recorded parent pointer, as `[child, parent]`. */
  parents(repositoryRoot: string): Promise<Array<[string, string]>>
}

const DEFAULT_DEPS: DiscoverStacksDeps = {
  parents: async (repositoryRoot) => {
    const { gitStackParents } = await import("@/lib/git/commands")
    return gitStackParents(repositoryRoot)
  },
}

export interface DiscoverStacksInput {
  repositoryRoot: string
  /** Authoring model to stamp on what is found. Defaults to branch-per-layer. */
  model?: StackAuthoringModel
}

/** Stable id for a chain, so a caller can key UI state on it across reloads. */
export function stackIdFor(tipBranch: string): string {
  return `stack:${tipBranch}`
}

/**
 * Every stack recorded in this repository, each bottom layer first.
 *
 * Cycles are dropped rather than throwing. A pointer loop is corrupt data
 * someone can fix with one `git config --unset`, and refusing to show any
 * stack because one is broken hides the nine that are fine.
 */
export async function discoverStacks(
  input: DiscoverStacksInput,
  deps?: Partial<DiscoverStacksDeps>
): Promise<Stack[]> {
  const resolved: DiscoverStacksDeps = { ...DEFAULT_DEPS, ...deps }
  const pairs = await resolved.parents(input.repositoryRoot)
  const parentOf = new Map(pairs)
  const hasChild = new Set(pairs.map(([, parent]) => parent))

  const stacks: Stack[] = []
  for (const [child] of pairs) {
    // Only start from a tip. Every other branch is reached while walking one.
    if (hasChild.has(child)) continue
    const chain = walkDown(child, parentOf)
    if (!chain) continue
    const { layers, trunk } = chain
    stacks.push({
      id: stackIdFor(child),
      repositoryRoot: input.repositoryRoot,
      trunk,
      model: input.model ?? "branchPerLayer",
      layers: layers.map((branch, order) => ({
        id: branch,
        branch,
        title: branch,
        order,
      })),
    })
  }
  // Deterministic: the tip branch names, sorted. A list that reorders itself
  // between reads makes a panel impossible to use.
  return stacks.sort((left, right) => left.id.localeCompare(right.id))
}

/**
 * Walk from a tip down to the first branch with no recorded parent.
 *
 * Returns null on a pointer cycle. The visited set is the guard: without it a
 * loop spins forever, and a loop is exactly what a mistyped `git config` makes.
 */
function walkDown(
  tip: string,
  parentOf: Map<string, string>
): { layers: string[]; trunk: string } | null {
  const layers: string[] = []
  const visited = new Set<string>()
  let current = tip
  for (;;) {
    if (visited.has(current)) return null
    visited.add(current)
    layers.unshift(current)
    const parent = parentOf.get(current)
    if (!parent) {
      // `current` has no parent, so it is the bottom layer and its own base is
      // unknown to us. This only happens for a tip with no pointer at all,
      // which `discoverStacks` never starts from.
      return null
    }
    if (!parentOf.has(parent)) {
      return { layers, trunk: parent }
    }
    current = parent
  }
}

/**
 * Fill in each layer's pull request, or leave it absent.
 *
 * One lookup per branch. Not cached: a cached pull request number outlives the
 * pull request being closed, and a stack panel showing a link to a closed pull
 * request is how someone merges the wrong thing.
 */
export async function attachPullRequests(
  stack: Stack,
  repository: string,
  adapter: {
    findByBranch(
      repository: string,
      branch: string
    ): Promise<Stack["layers"][number]["pullRequest"] | null>
  }
): Promise<Stack> {
  const layers = await Promise.all(
    stack.layers.map(async (layer) => {
      const found = await adapter.findByBranch(repository, layer.branch).catch(() => null)
      return found ? { ...layer, pullRequest: found } : layer
    })
  )
  return { ...stack, layers }
}
