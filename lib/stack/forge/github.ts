/**
 * GitHub, as a stack forge.
 *
 * # Native stacks
 *
 * GitHub has a first-class stack object (`/repos/{owner}/{repo}/stacks`), and
 * registering with it buys the forge's own stack UI, a merge queue that
 * understands the stack, and branch protection evaluated against the stack base
 * rather than the immediate parent. Its one rule — each pull request's base ref
 * must equal the previous one's head ref — is exactly the chain `publishStack`
 * builds, so registration is a single call at the end rather than a different
 * publishing strategy.
 *
 * It is also new, same-repository-only, and absent on GitHub Enterprise Server
 * until it ships there. So `capabilities` probes for the endpoint instead of
 * assuming it, and every path works without it: the chain of base branches
 * already carries the shape, and always did.
 *
 * # Two things this deliberately does not do
 *
 * It does not create ghstack-style synthetic base branches. Those cannot be
 * registered as a native stack, and landing them requires pushing straight to
 * the trunk — which is what branch protection exists to prevent.
 *
 * It does not fall back to a fork when it cannot push to the target. A pull
 * request's base must exist in the target repository, and every layer above the
 * bottom is based on a branch that only exists in the fork. `capabilities`
 * reports the refusal and the caller states it.
 */

import { fetchPrObservation } from "@/lib/github/pr-observe/fetch"
import {
  parseRepoFullName,
  type ObserveRepo,
  type OctokitLike,
} from "@/lib/github/pr-observe/types"

import type {
  CreatePullRequestInput,
  ForgeCiState,
  ForgeMergeMethod,
  ForgeObservation,
  ForgePullRequest,
  ForgeReviewState,
  ForgeStackAdapter,
  ForgeStackCapabilities,
} from "./types"

export interface GithubStackAdapterOptions {
  octokit: OctokitLike
  /** Injected in tests; production reads GitHub. */
  observe?: (repository: string, pullRequest: number) => Promise<ForgeObservation>
  now?: () => number
}

function ensureSuccess(status: number, operation: string): void {
  if (status < 200 || status >= 300) {
    throw new Error(`GitHub ${operation} failed with ${status}`)
  }
}

function statusOf(error: unknown): number | undefined {
  return (error as { status?: number } | null)?.status
}

/**
 * Map GitHub's roll-up to the state the merge gate reads.
 *
 * The distinction that matters: `fetchPrObservation` reports `summary:
 * "unknown"` when a pull request has NO checks at all, and reports
 * `fetched: false` when it could not read them. Those are opposite answers for
 * a merge gate — the first must be allowed to merge and the second must not —
 * and they arrive on different fields.
 */
export function ciStateFrom(fetched: boolean, summary: string): ForgeCiState {
  if (!fetched) return "unknown"
  switch (summary) {
    case "passing":
      return "passing"
    case "failing":
      return "failing"
    case "pending":
      return "pending"
    default:
      // Fetched successfully and found no checks configured.
      return "none"
  }
}

export function reviewStateFrom(fetched: boolean, decision: string): ForgeReviewState {
  if (!fetched) return "reviewRequired"
  switch (decision) {
    case "approved":
      return "approved"
    case "changes_requested":
      return "changesRequested"
    case "review_required":
      return "reviewRequired"
    default:
      return "none"
  }
}

interface RawPull {
  number?: number
  html_url?: string
  url?: string
  base?: { ref?: string }
  head?: { sha?: string }
}

function toPullRequest(raw: RawPull, fallbackBase: string): ForgePullRequest | null {
  if (typeof raw.number !== "number") return null
  return {
    number: raw.number,
    url: raw.html_url ?? raw.url ?? "",
    baseBranch: raw.base?.ref ?? fallbackBase,
    headSha: raw.head?.sha ?? "",
  }
}

export function createGithubStackAdapter(options: GithubStackAdapterOptions): ForgeStackAdapter {
  const { octokit } = options
  const repositories = new Map<string, ObserveRepo>()
  const repositoryOf = (fullName: string): ObserveRepo => {
    const cached = repositories.get(fullName)
    if (cached) return cached
    const parsed = parseRepoFullName(fullName)
    repositories.set(fullName, parsed)
    return parsed
  }

  const observe =
    options.observe ??
    (async (repository: string, pullRequest: number): Promise<ForgeObservation> => {
      const observation = await fetchPrObservation(
        octokit,
        repository,
        { number: pullRequest },
        undefined,
        (options.now ?? Date.now)()
      )
      return {
        ci: ciStateFrom(observation.fetched, observation.ci.summary),
        review: reviewStateFrom(observation.fetched, observation.review.decision),
        mergeable: observation.fetched && observation.mergeability.mergeable,
        conflict: observation.fetched && observation.mergeability.conflict,
        merged: observation.fetched && observation.pr.merged,
      }
    })

  return {
    id: "github",

    async capabilities(repository) {
      const repo = repositoryOf(repository)
      const response = await octokit.request("GET /repos/{owner}/{repo}", {
        owner: repo.owner,
        repo: repo.name,
      })
      ensureSuccess(response.status, "read repository")
      const data = response.data as {
        permissions?: { push?: boolean }
        allow_squash_merge?: boolean
        allow_merge_commit?: boolean
        allow_rebase_merge?: boolean
      }
      const allowedMergeMethods: ForgeMergeMethod[] = []
      // A repository that reports none of these flags is not one that forbids
      // every merge — the field is absent for tokens without admin scope. The
      // documented defaults are what GitHub itself applies.
      if (data.allow_squash_merge !== false) allowedMergeMethods.push("squash")
      if (data.allow_merge_commit !== false) allowedMergeMethods.push("merge")
      if (data.allow_rebase_merge !== false) allowedMergeMethods.push("rebase")

      // Probed, not assumed: stacks are new, and absent on Enterprise Server
      // until it ships there. Anything other than a 2xx means "no native
      // stacks here", which every path already handles.
      let nativeStacks = false
      try {
        const probe = await octokit.request("GET /repos/{owner}/{repo}/stacks", {
          owner: repo.owner,
          repo: repo.name,
          per_page: 1,
        })
        nativeStacks = probe.status >= 200 && probe.status < 300
      } catch {
        nativeStacks = false
      }

      return {
        nativeStacks,
        canPushToTarget: data.permissions?.push !== false,
        allowedMergeMethods,
      } satisfies ForgeStackCapabilities
    },

    async findByBranch(repository, branch) {
      const repo = repositoryOf(repository)
      try {
        const response = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
          owner: repo.owner,
          repo: repo.name,
          head: `${repo.owner}:${branch}`,
          state: "open",
          per_page: 1,
        })
        if (response.status === 404) return null
        const list = Array.isArray(response.data) ? (response.data as RawPull[]) : []
        const first = list[0]
        return first ? toPullRequest(first, "") : null
      } catch (error) {
        // A missing repository or branch is "no pull request", not a failure
        // that should abort a publish half way through a stack.
        if (statusOf(error) === 404) return null
        throw error
      }
    },

    async createPullRequest(input: CreatePullRequestInput) {
      const repo = repositoryOf(input.repository)
      const response = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
        owner: repo.owner,
        repo: repo.name,
        title: input.title,
        head: input.branch,
        base: input.baseBranch,
        ...(input.body ? { body: input.body } : {}),
      })
      ensureSuccess(response.status, "create pull request")
      const created = toPullRequest(response.data as RawPull, input.baseBranch)
      if (!created) throw new Error("GitHub create pull request returned no number")
      return created
    },

    async retarget(repository, pullRequest, baseBranch) {
      const repo = repositoryOf(repository)
      const response = await octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner: repo.owner,
        repo: repo.name,
        pull_number: pullRequest,
        base: baseBranch,
      })
      ensureSuccess(response.status, "retarget pull request")
    },

    observe,

    async merge(repository, pullRequest, method) {
      const repo = repositoryOf(repository)
      const response = await octokit.request(
        "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge",
        {
          owner: repo.owner,
          repo: repo.name,
          pull_number: pullRequest,
          merge_method: method,
        }
      )
      ensureSuccess(response.status, "merge pull request")
      const data = response.data as { merged?: boolean; message?: string }
      if (data.merged === false) {
        throw new Error(data.message || "GitHub refused to merge the pull request")
      }
    },

    async comment(repository, pullRequest, body) {
      const repo = repositoryOf(repository)
      const response = await octokit.request(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        { owner: repo.owner, repo: repo.name, issue_number: pullRequest, body }
      )
      ensureSuccess(response.status, "comment on pull request")
    },

    async registerStack(repository, pullRequests) {
      if (pullRequests.length < 2) return null
      const repo = repositoryOf(repository)
      try {
        const response = await octokit.request("POST /repos/{owner}/{repo}/stacks", {
          owner: repo.owner,
          repo: repo.name,
          // Bottom to top. GitHub requires each pull request's base ref to
          // equal the previous one's head ref, which is what `publishStack`
          // produced — so a rejection here means the chain drifted, not that
          // the order is wrong.
          pull_requests: pullRequests,
        })
        if (response.status < 200 || response.status >= 300) return null
        const data = response.data as { number?: number; id?: number }
        const identifier = data.number ?? data.id
        return typeof identifier === "number" ? String(identifier) : null
      } catch {
        // Not available on this host, not permitted for this token, or the
        // chain no longer satisfies GitHub's rule. All three mean the same
        // thing to the caller: the base chain is the whole truth.
        return null
      }
    },
  }
}
