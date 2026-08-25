/**
 * The seam between a stack and whatever hosts its pull requests.
 *
 * Only GitHub is implemented (`./github`). The interface exists anyway for two
 * reasons: a fake implementation is the only way to test publishing and merging
 * without a network, and a second forge later should be a new file rather than
 * a rewrite of the engine. `./fake` is not a mock of GitHub — it is a second
 * implementation, and its test is what proves the engine has no GitHub in it.
 */

/**
 * The three ways a forge can land a pull request.
 *
 * A runtime list rather than a bare union, because two callers need to iterate
 * it: `chooseMergeMethod` picks from what a repository allows, and a settings
 * surface offers them. A union alone would be duplicated in both.
 */
export const FORGE_MERGE_METHODS = ["squash", "rebase", "merge"] as const
export type ForgeMergeMethod = (typeof FORGE_MERGE_METHODS)[number]

export interface ForgePullRequest {
  number: number
  url: string
  /** The branch the forge currently has this pull request based on. */
  baseBranch: string
  headSha: string
  /** Set when this pull request belongs to one of the forge's own stacks. */
  nativeStackId?: string
}

/**
 * Check state, with "there are none" kept apart from "could not tell".
 *
 * A repository with no CI configured must still be able to merge a stack, and
 * a repository whose CI state could not be fetched must not. Collapsing both
 * into `unknown` forces the gate to choose which of those two to get wrong.
 */
export const FORGE_CI_STATES = ["none", "unknown", "pending", "passing", "failing"] as const
export type ForgeCiState = (typeof FORGE_CI_STATES)[number]

/**
 * Review state as the forge's own decision, not as a boolean.
 *
 * `approved` on its own cannot tell "nobody has reviewed and nobody needs to"
 * from "a review is required and has not happened" — and a gate built on it
 * blocks every repository that does not require review.
 */
export const FORGE_REVIEW_STATES = [
  "approved",
  "changesRequested",
  "reviewRequired",
  "none",
] as const
export type ForgeReviewState = (typeof FORGE_REVIEW_STATES)[number]

export interface ForgeObservation {
  ci: ForgeCiState
  review: ForgeReviewState
  mergeable: boolean
  conflict: boolean
  merged: boolean
}

export interface ForgeStackCapabilities {
  /**
   * The forge has a first-class stack object to register with. Registering
   * buys the forge's own stack UI, its merge queue's stack awareness, and
   * branch protection evaluated against the stack base rather than the
   * immediate parent. Absent, the chain of base branches carries all of it.
   */
  nativeStacks: boolean
  /**
   * Branches can be pushed to the target repository itself.
   *
   * False means fork-only, which is not a degraded mode but a refusal: a pull
   * request's base must be a branch in the target repository, and every layer
   * above the bottom is based on a branch that exists only in the fork.
   */
  canPushToTarget: boolean
  /** The fork this account can push to, when `canPushToTarget` is false. */
  forkFullName?: string
  /** Merge methods the repository actually allows. */
  allowedMergeMethods: ForgeMergeMethod[]
}

export interface CreatePullRequestInput {
  repository: string
  branch: string
  baseBranch: string
  title: string
  body?: string
  /** Where in the stack this is, for the body the adapter writes. */
  order: number
  total: number
}

export interface ForgeStackAdapter {
  /** Stable id, for logs and for telling two adapters apart in a test. */
  readonly id: string
  capabilities(repository: string): Promise<ForgeStackCapabilities>
  /** The open pull request for this branch, or null. */
  findByBranch(repository: string, branch: string): Promise<ForgePullRequest | null>
  createPullRequest(input: CreatePullRequestInput): Promise<ForgePullRequest>
  retarget(repository: string, pullRequest: number, baseBranch: string): Promise<void>
  observe(repository: string, pullRequest: number): Promise<ForgeObservation>
  merge(repository: string, pullRequest: number, method: ForgeMergeMethod): Promise<void>
  comment(repository: string, pullRequest: number, body: string): Promise<void>
  /**
   * Register a chain as one of the forge's own stacks, returning its id.
   *
   * Optional, and allowed to return null: a forge that has stacks may still
   * refuse this particular one (GitHub's are same-repository only). The caller
   * treats null as "the base chain is the whole truth", which it already was.
   */
  registerStack?(repository: string, pullRequests: number[]): Promise<string | null>
}
