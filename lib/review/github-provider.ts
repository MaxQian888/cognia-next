import { GITHUB_DOT_COM, remoteHostname, type GithubHost } from "@/lib/github/host"
import { publishGithubReview } from "@/plugins/github-delivery/src/review"
import { sha256Hex } from "@/lib/share/hash"
import { gitPush } from "@/lib/git/commands"
import { assertSingleRootBundle } from "./bundle"
import type {
  CreatePullRequestInput,
  PullRequestProvider,
  PullRequestCheckoutRequest,
  PullRequestCheckoutResolution,
  PullRequestRef,
  ReviewFeedbackBundle,
} from "@/types/review"

export interface GitHubRequestClient {
  request(
    route: string,
    parameters: Record<string, unknown>
  ): Promise<{
    status: number
    data: unknown
  }>
}

export interface GitHubRepositoryBinding {
  owner: string
  repo: string
  fullName: string
  host?: GithubHost
  remote?: string
  client: GitHubRequestClient
}

export interface GitHubPullRequestProviderOptions {
  authenticationState(
    repositoryRoot?: string
  ): Promise<"authenticated" | "unauthenticated" | "unavailable">
  resolveRepository(repositoryRoot: string): Promise<GitHubRepositoryBinding>
}

export class PullRequestProviderError extends Error {
  constructor(
    message: string,
    readonly operation: "lookup" | "checkout" | "push" | "create" | "feedback",
    readonly recoverable: boolean,
    options?: ErrorOptions & {
      /**
       * HTTP status, when one came back.
       *
       * Absent means no response was ever received, which is the only case
       * where a write's outcome is genuinely unknown. A 4xx/5xx is a definite
       * "this did not happen"; a dropped connection is not, and a retry that
       * cannot tell them apart may double-post a review.
       */
      status?: number
    }
  ) {
    super(message, options)
    this.name = "PullRequestProviderError"
    this.status = options?.status
  }

  readonly status?: number

  /** True when the request never got an answer, so a replay may duplicate. */
  get outcomeUncertain(): boolean {
    return this.status === undefined || this.status === 0
  }
}

function isOffline(error: unknown): boolean {
  const candidate = error as { status?: number; code?: string; message?: string }
  return (
    candidate.status === 0 ||
    ["ENETDOWN", "ENETUNREACH", "ECONNRESET", "ETIMEDOUT"].includes(candidate.code ?? "") ||
    /offline|network|failed to fetch/i.test(candidate.message ?? "")
  )
}

function httpStatus(error: unknown): number | undefined {
  const candidate = error as { status?: number; response?: { status?: number } }
  const status = candidate.status ?? candidate.response?.status
  return typeof status === "number" ? status : undefined
}

function wrapError(
  error: unknown,
  operation: PullRequestProviderError["operation"]
): PullRequestProviderError {
  if (error instanceof PullRequestProviderError) return error
  const message = error instanceof Error ? error.message : String(error)
  const status = httpStatus(error)
  return new PullRequestProviderError(message, operation, isOffline(error), {
    cause: error,
    ...(status !== undefined ? { status } : {}),
  })
}

function mapPullRequest(
  binding: GitHubRepositoryBinding,
  data: Record<string, unknown>,
  fallback: { headRef: string; baseRef: string; title: string }
): PullRequestRef {
  const merged = data.merged === true || Boolean(data.merged_at)
  const state = merged ? "merged" : data.state === "closed" ? "closed" : "open"
  const head = data.head as { ref?: string; sha?: string } | undefined
  const base = data.base as { ref?: string } | undefined
  return {
    provider: "github",
    repository: binding.fullName,
    host: (binding.host ?? GITHUB_DOT_COM).id,
    headSha: head?.sha,
    number: Number(data.number),
    url: String(data.html_url ?? data.url ?? ""),
    headRef: head?.ref ?? fallback.headRef,
    baseRef: base?.ref ?? fallback.baseRef,
    title: String(data.title ?? fallback.title),
    state,
  }
}

export class GitHubPullRequestProvider implements PullRequestProvider {
  readonly id = "github"

  constructor(private readonly options: GitHubPullRequestProviderOptions) {}

  getAuthenticationState(
    repositoryRoot?: string
  ): Promise<"authenticated" | "unauthenticated" | "unavailable"> {
    return this.options.authenticationState(repositoryRoot)
  }

  async findForBranch(repositoryRoot: string, branch: string): Promise<PullRequestRef | null> {
    try {
      const binding = await this.options.resolveRepository(repositoryRoot)
      const response = await binding.client.request("GET /repos/{owner}/{repo}/pulls", {
        owner: binding.owner,
        repo: binding.repo,
        head: `${binding.owner}:${branch}`,
        state: "open",
        per_page: 1,
      })
      const first = Array.isArray(response.data)
        ? (response.data[0] as Record<string, unknown> | undefined)
        : undefined
      return first
        ? mapPullRequest(binding, first, { headRef: branch, baseRef: "", title: "" })
        : null
    } catch (error) {
      throw wrapError(error, "lookup")
    }
  }

  async resolveCheckout(
    repositoryRoot: string,
    request: PullRequestCheckoutRequest
  ): Promise<PullRequestCheckoutResolution> {
    try {
      const binding = await this.options.resolveRepository(repositoryRoot)
      if (binding.fullName.toLowerCase() !== request.repository.toLowerCase()) {
        throw new Error(
          `Pull request repository mismatch: expected ${binding.fullName}, received ${request.repository}`
        )
      }
      const response = await binding.client.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        {
          owner: binding.owner,
          repo: binding.repo,
          pull_number: request.number,
        }
      )
      const data = response.data as { head?: { sha?: unknown } }
      const headSha = typeof data.head?.sha === "string" ? data.head.sha.trim() : ""
      if (!headSha) throw new Error("Pull request response has no immutable head SHA")
      return {
        provider: this.id,
        repository: binding.fullName,
        number: request.number,
        fetchRef: `refs/pull/${request.number}/head`,
        headSha,
      }
    } catch (error) {
      throw wrapError(error, "checkout")
    }
  }

  async push(repositoryRoot: string, branch: string): Promise<void> {
    try {
      const binding = await this.options.resolveRepository(repositoryRoot)
      if (!binding.remote) throw new Error("The selected GitHub remote is unavailable")
      await gitPush(repositoryRoot, { remote: binding.remote, branch, setUpstream: true })
    } catch (error) {
      throw wrapError(error, "push")
    }
  }

  async create(input: CreatePullRequestInput): Promise<PullRequestRef> {
    try {
      const binding = await this.options.resolveRepository(input.repositoryRoot)
      const response = await binding.client.request("POST /repos/{owner}/{repo}/pulls", {
        owner: binding.owner,
        repo: binding.repo,
        head: input.headRef,
        base: input.baseRef,
        title: input.title,
        body: input.body,
        draft: input.draft ?? false,
      })
      return mapPullRequest(binding, response.data as Record<string, unknown>, {
        headRef: input.headRef,
        baseRef: input.baseRef,
        title: input.title,
      })
    } catch (error) {
      throw wrapError(error, "create")
    }
  }

  /**
   * Post one repository's review.
   *
   * The root comes from the bundle and the comment set is validated against it
   * (`assertSingleRootBundle`) before a single request goes out. The previous
   * implementation took `repositoryRoots[0]` and posted every comment there,
   * so in a two-root review the second repository's comments were filed against
   * the first repository's pull request, at whatever path matched. Refusing is
   * the only safe answer to an ambiguous bundle: there is no way to post a
   * comment "partly" to the wrong repo and undo it.
   */
  async publishFeedback(pullRequest: PullRequestRef, bundle: ReviewFeedbackBundle): Promise<void> {
    try {
      const root = bundle.repositoryRoots[0]
      if (!root) throw new Error("Review feedback has no repository root")
      const live = assertSingleRootBundle(bundle, root)
      const binding = await this.options.resolveRepository(root)
      const host = pullRequest.host ?? remoteHostname(pullRequest.url)
      if (
        pullRequest.provider !== this.id ||
        binding.fullName.toLowerCase() !== pullRequest.repository.toLowerCase() ||
        host !== (binding.host ?? GITHUB_DOT_COM).id
      ) {
        throw new Error("Pull request repository or host changed; refresh the pull request")
      }
      const commitId = pullRequest.headSha
      if (!commitId) throw new Error("Review publication requires an immutable head SHA")
      if (
        live.some((comment) => comment.anchor.commitSha && comment.anchor.commitSha !== commitId)
      ) {
        throw new Error("Review comment SHA differs from the pull request head")
      }
      const comments = live.map((comment) => ({
        path: comment.anchor.path,
        line: comment.anchor.line,
        side: comment.anchor.side === "before" ? "LEFT" : "RIGHT",
        body: comment.body,
      }))
      // Bundle identity survives a retry; ordinary reviews by other users
      // cannot accidentally satisfy this publication's reconciliation check.
      const marker = `<!-- cognia-review:${await sha256Hex(bundle.id)} -->`
      const body = bundle.summary.trim() ? `${bundle.summary}\n\n${marker}` : marker
      const targetPath = `/repos/${binding.fullName}/pulls/${pullRequest.number}`
      await publishGithubReview(
        {
          repoFullName: binding.fullName,
          prNumber: pullRequest.number,
          commitId,
          event: "COMMENT",
          body,
          comments,
        },
        async <T>(path: string, method = "GET", body?: unknown) => {
          const [pathname, query] = path.split("?")
          const route = pathname.replace(targetPath, "/repos/{owner}/{repo}/pulls/{pull_number}")
          const response = await binding.client.request(`${method} ${route}`, {
            owner: binding.owner,
            repo: binding.repo,
            pull_number: pullRequest.number,
            ...Object.fromEntries(new URLSearchParams(query)),
            ...(body as Record<string, unknown> | undefined),
          })
          return { data: response.data as T }
        },
        { allowDraftComment: true }
      )
    } catch (error) {
      throw wrapError(error, "feedback")
    }
  }
}
