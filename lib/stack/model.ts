/**
 * What a stack is, and the two ways people author one — of which this codebase
 * currently produces the first.
 *
 * # Two authoring models, one thing on the forge
 *
 * **Branch per layer** is what most people mean: `main <- a <- b <- c`, one
 * branch and one pull request per layer, identity carried by the branch name
 * and the parent pointer in git config.
 *
 * **Commit per pull request** is the ghstack/spr model: you work on one branch
 * and every commit becomes its own pull request, identity carried by a
 * `Cognia-Change-Id` trailer that survives rebases and amends.
 *
 * They differ only in where identity lives. Both produce the same thing on the
 * forge — a chain of real branches, each based on the one below — because that
 * is the only shape a forge understands, the only one branch protection can be
 * evaluated against, and the only one a merge queue can process. Everything
 * downstream of a {@link Stack} therefore sees one shape.
 *
 * Only the first is implemented. See {@link StackAuthoringModel}.
 *
 * # Why not a synthetic base branch
 *
 * ghstack's `gh/<user>/<n>/{base,head}` pairs are not used. They cannot be
 * registered as a forge-native stack, and landing them requires pushing
 * straight to the trunk — which is exactly what branch protection exists to
 * prevent, and is why ghstack's own issue about it has been open since 2021.
 */

/**
 * Where a layer's identity comes from.
 *
 * ## `commitPerPullRequest` is declared, not implemented
 *
 * Nothing produces it. `discoverStacks` stamps `branchPerLayer`, the Stacks
 * panel creates `branchPerLayer`, and Agent Team publishes `branchPerLayer`;
 * the only code that reads the other member is {@link chooseMergeMethod}, which
 * refuses to squash it. It is declared here because the merge rule genuinely
 * differs and writing that rule against a model the type does not know is how
 * it gets forgotten — but a stack in this member's shape cannot currently be
 * authored, and the panel says so where someone would look for it
 * (`sourceControl.stacks.model.branchPerLayer`).
 *
 * Building it means rewriting commits to carry {@link CHANGE_ID_TRAILER} and
 * exploding one branch into the chain of real branches a forge needs. Both
 * halves of that are absent. `model.test.ts` pins the absence so this comment
 * cannot quietly become false.
 */
export type StackAuthoringModel =
  /** The branch name is the identity; the parent lives in git config. */
  | "branchPerLayer"
  /**
   * A `Cognia-Change-Id` commit trailer is the identity.
   *
   * Inert — see the note above. No code path produces a stack with this model.
   */
  | "commitPerPullRequest"

/**
 * The trailer that carries identity in the commit-per-pull-request model.
 *
 * Inert alongside {@link StackAuthoringModel}: nothing writes it and nothing
 * reads it back out of a commit.
 */
export const CHANGE_ID_TRAILER = "Cognia-Change-Id"

export interface StackPullRequest {
  number: number
  url: string
  /** Branch the forge currently has this pull request based on. */
  baseBranch: string
  /** The forge's own stack object, when it has one. */
  nativeStackId?: string
}

export interface StackLayer {
  /**
   * Stable across restacks. The branch name in `branchPerLayer`, the change id
   * in `commitPerPullRequest` — a rebase rewrites every SHA, so a SHA cannot
   * be it.
   */
  id: string
  /** The real branch this layer publishes as. Both models end up with one. */
  branch: string
  title: string
  /** 0 is the bottom of the stack. */
  order: number
  /** Present only in the commit-per-pull-request model. */
  changeId?: string
  pullRequest?: StackPullRequest
}

export interface Stack {
  id: string
  /** Absolute path of the repository the layers live in. */
  repositoryRoot: string
  /** Branch the bottom layer is based on. */
  trunk: string
  model: StackAuthoringModel
  /** Bottom first. Callers may rely on this order. */
  layers: StackLayer[]
}

/** `dependsOn`/`order` view of a stack, for `lib/stack/topology`. */
export function stackTopology(stack: Pick<Stack, "layers">) {
  const ordered = [...stack.layers].sort((left, right) => left.order - right.order)
  return ordered.map((layer, index) => ({
    id: layer.id,
    dependsOn: index === 0 ? [] : [ordered[index - 1]!.id],
    order: layer.order,
    tieBreaker: layer.branch,
  }))
}

/** The branch each layer should be based on, as `branch -> base`. */
export function baseBranches(stack: Pick<Stack, "trunk" | "layers">): Map<string, string> {
  const ordered = [...stack.layers].sort((left, right) => left.order - right.order)
  const bases = new Map<string, string>()
  ordered.forEach((layer, index) => {
    bases.set(layer.branch, index === 0 ? stack.trunk : ordered[index - 1]!.branch)
  })
  return bases
}

// ── Branch naming ──────────────────────────────────────────────────────────

/**
 * Default template for a branch a person adds by hand.
 *
 * Machine-produced branches keep their own prefixes (`agent/…`, `issue/…`) —
 * those encode where the work came from and changing them would break the
 * surfaces that read them.
 */
export const DEFAULT_BRANCH_TEMPLATE = "{user}/{slug}"

/** Lower-case, hyphenated, no leading or trailing punctuation. */
export function slugifyBranchSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
}

/**
 * Fill a branch template.
 *
 * Unknown placeholders are left alone rather than blanked: a template with a
 * typo produces a visibly wrong branch name the user can fix, where silently
 * dropping the segment produces a plausible name that collides with the next
 * one.
 */
export function renderBranchName(
  template: string,
  values: { user?: string; slug?: string; index?: number; [key: string]: unknown }
): string {
  const filled = template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = values[key]
    if (value === undefined || value === null || value === "") return whole
    return slugifyBranchSegment(String(value))
  })
  // A template can leave doubled or trailing separators behind — `{user}/{slug}`
  // with no user gives `/thing`, which git rejects outright.
  return filled.replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "")
}
