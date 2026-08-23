import { gitPush } from "@/lib/git/commands"
import { assertSingleRootBundle } from "./bundle"
import type {
  CreatePullRequestInput,
  PullRequestProvider,
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
  client: GitHubRequestClient
}

export interface GitHubPullRequestProviderOptions {
  authenticationState(): Promise<"authenticated" | "unauthenticated" | "unavailable">
  resolveRepository(repositoryRoot: string): Promise<GitHubRepositoryBinding>
}

export class PullRequestProviderError extends Error {
  constructor(
    message: string,
    readonly operation: "lookup" | "push" | "create" | "feedback",
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
  repository: string,
  data: Record<string, unknown>,
  fallback: { headRef: string; baseRef: string; title: string }
): PullRequestRef {
  const merged = data.merged === true || Boolean(data.merged_at)
  const state = merged ? "merged" : data.state === "closed" ? "closed" : "open"
  const head = data.head as { ref?: string } | undefined
  const base = data.base as { ref?: string } | undefined
  return {
    provider: "github",
    repository,
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

  getAuthenticationState(): Promise<"authenticated" | "unauthenticated" | "unavailable"> {
    return this.options.authenticationState()
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
        ? mapPullRequest(binding.fullName, first, { headRef: branch, baseRef: "", title: "" })
        : null
    } catch (error) {
      throw wrapError(error, "lookup")
    }
  }

  async push(repositoryRoot: string, branch: string): Promise<void> {
    try {
      await gitPush(repositoryRoot, { remote: "origin", branch, setUpstream: true })
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
      return mapPullRequest(binding.fullName, response.data as Record<string, unknown>, {
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
      const comments = live.map((comment) => ({
        path: comment.anchor.path,
        line: comment.anchor.line,
        side: comment.anchor.side === "before" ? "LEFT" : "RIGHT",
        body: comment.body,
        ...(comment.anchor.commitSha ? { commit_id: comment.anchor.commitSha } : {}),
      }))
      await binding.client.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
        owner: binding.owner,
        repo: binding.repo,
        pull_number: pullRequest.number,
        event: "COMMENT",
        body: bundle.summary,
        comments,
      })
    } catch (error) {
      throw wrapError(error, "feedback")
    }
  }
}
