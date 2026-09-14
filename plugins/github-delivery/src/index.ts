import type { PluginDefinition, PluginManifest } from "@cognia/plugin-sdk"
import type {
  IntegrationAccountStatusProvider,
  IntegrationActionHandler,
  IntegrationActionHandlerContext,
  IntegrationProviderContext,
  IntegrationResourceProvider,
  IntegrationVerifiedDelivery,
  PluginIntegrationDef,
} from "@cognia/plugin-sdk"
const API_ORIGIN = "https://api.github.com"
const API_VERSION = "2022-11-28"
const REQUIRED_APP_PERMISSIONS = [
  "checks:read",
  "actions:read",
  "contents:write",
  "issues:write",
  "metadata:read",
  "pull_requests:write",
] as const

export type GithubErrorCategory =
  | "authentication"
  | "permission"
  | "rate_limit"
  | "validation"
  | "conflict"
  | "transient"
  | "permanent"

export class GithubIntegrationError extends Error {
  readonly name = "GithubIntegrationError"

  constructor(
    message: string,
    readonly category: GithubErrorCategory,
    readonly status: number,
    readonly requestId?: string,
    readonly retryAfter?: string,
    readonly rateLimitReset?: string
  ) {
    super(message)
  }
}

type GithubRequestContext = Pick<
  IntegrationProviderContext | IntegrationActionHandlerContext,
  "authenticatedRequest" | "apiBaseUrl"
>

function errorCategory(status: number, headers: Record<string, string>): GithubErrorCategory {
  if (status === 401) return "authentication"
  if (status === 403 && headers["x-ratelimit-remaining"] !== "0") return "permission"
  if (status === 429 || headers["x-ratelimit-remaining"] === "0") return "rate_limit"
  if (status === 409) return "conflict"
  if (status === 400 || status === 422) return "validation"
  if (status >= 500) return "transient"
  return "permanent"
}

function messageFromData(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined
  const message = (data as { message?: unknown }).message
  return typeof message === "string" ? message : undefined
}

/**
 * The REST root for this account, falling back to the public host.
 *
 * The fallback is not a guess: `apiBaseUrl` is absent exactly when the
 * credential names no deployment, which is what every github.com account looks
 * like. A trailing slash is trimmed because every path below starts with one.
 */
function apiOrigin(context: GithubRequestContext): string {
  const configured = context.apiBaseUrl?.trim()
  return configured ? configured.replace(/\/+$/, "") : API_ORIGIN
}

async function githubRequest<T>(
  context: GithubRequestContext,
  path: string,
  method = "GET",
  body?: unknown
): Promise<{ data: T; headers: Record<string, string> }> {
  // ADR-0176. The account names its own deployment: a GitHub Enterprise
  // installation is not on api.github.com, and sending its requests there
  // fails as "not found" against a server that has never heard of it.
  const response = await context.authenticatedRequest<T>(`${apiOrigin(context)}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": API_VERSION,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (response.status < 200 || response.status >= 300) {
    const category = errorCategory(response.status, response.headers)
    const detail = messageFromData(response.data)
    throw new GithubIntegrationError(
      detail
        ? `GitHub API ${category}: ${detail}`
        : `GitHub API ${category} failure with status ${response.status}`,
      category,
      response.status,
      response.headers["x-github-request-id"],
      response.headers["retry-after"],
      response.headers["x-ratelimit-reset"]
    )
  }
  return response
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`github-delivery requires ${key}`)
  }
  return value.trim()
}

function positiveInteger(input: Record<string, unknown>, key: string): number {
  const value = input[key]
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`github-delivery requires positive integer ${key}`)
  }
  return value
}

function repo(input: Record<string, unknown>): string {
  return requiredString(input, "repoFullName")
}

function rateLimit(headers: Record<string, string>) {
  const numberHeader = (name: string) => {
    const value = Number(headers[name])
    return Number.isFinite(value) ? value : undefined
  }
  const reset = numberHeader("x-ratelimit-reset")
  return {
    limit: numberHeader("x-ratelimit-limit"),
    remaining: numberHeader("x-ratelimit-remaining"),
    resetAt: reset === undefined ? undefined : new Date(reset * 1000).toISOString(),
    retryAt: headers["retry-after"],
  }
}

function nextCursor(link?: string): string | undefined {
  if (!link) return undefined
  const next = link.split(",").find((entry) => entry.includes('rel="next"'))
  const match = next?.match(/[?&]page=([^&>]+)/u)
  return match?.[1] ? decodeURIComponent(match[1]) : undefined
}

interface GithubRepository {
  full_name?: string
  html_url?: string
  owner?: { login?: string }
}

export const listGithubResources: IntegrationResourceProvider = async (query, context) => {
  if (query.kind !== "repository") throw new Error(`Unsupported GitHub resource kind ${query.kind}`)
  const page = Math.max(Number(query.cursor ?? "1") || 1, 1)
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 100)
  let response = await context.authenticatedRequest<{
    repositories?: GithubRepository[]
  }>(`${apiOrigin(context)}/installation/repositories?per_page=${limit}&page=${page}`, {
    headers: { accept: "application/vnd.github+json", "x-github-api-version": API_VERSION },
  })
  let repositories: GithubRepository[]
  if (response.status === 403 || response.status === 404) {
    const patResponse = await context.authenticatedRequest<GithubRepository[]>(
      `${apiOrigin(context)}/user/repos?per_page=${limit}&page=${page}&affiliation=owner,collaborator,organization_member`,
      { headers: { accept: "application/vnd.github+json", "x-github-api-version": API_VERSION } }
    )
    if (patResponse.status < 200 || patResponse.status >= 300) {
      await githubRequest(context, "/user")
    }
    response = { ...patResponse, data: { repositories: patResponse.data } }
    repositories = patResponse.data
  } else {
    if (response.status < 200 || response.status >= 300) {
      await githubRequest(context, "/installation/repositories")
    }
    repositories = response.data.repositories ?? []
  }
  const normalizedQuery = query.query?.trim().toLowerCase()
  const items = repositories
    .filter((repository) => repository.full_name)
    .filter(
      (repository) =>
        !normalizedQuery || repository.full_name!.toLowerCase().includes(normalizedQuery)
    )
    .map((repository) => ({
      kind: "repository",
      id: repository.full_name!,
      name: repository.full_name!,
      url: repository.html_url,
      parent: repository.owner?.login
        ? { kind: "installation", id: repository.owner.login }
        : undefined,
    }))
  return {
    items,
    nextCursor: nextCursor(response.headers.link),
    syncedAt: new Date().toISOString(),
    rateLimit: rateLimit(response.headers),
  }
}

function permissionList(permissions: Record<string, unknown>): string[] {
  return Object.entries(permissions)
    .filter(([, value]) => typeof value === "string")
    .map(([name, value]) => `${name}:${value}`)
    .sort()
}

export const checkGithubHealth: IntegrationAccountStatusProvider = async (context) => {
  const response = await context.authenticatedRequest<{
    suspended_at?: string | null
    permissions?: Record<string, unknown>
  }>(`${apiOrigin(context)}/installation`, {
    headers: { accept: "application/vnd.github+json", "x-github-api-version": API_VERSION },
  })
  if (response.status === 403 || response.status === 404) {
    const pat = await githubRequest<{ login?: string }>(context, "/user")
    return {
      health: "healthy",
      checkedAt: new Date().toISOString(),
      lastHealthyAt: new Date().toISOString(),
      requiredPermissions: ["repo"],
      grantedPermissions: (pat.headers["x-oauth-scopes"] ?? "")
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean),
      rateLimit: rateLimit(pat.headers),
    }
  }
  if (response.status < 200 || response.status >= 300) {
    const category = errorCategory(response.status, response.headers)
    throw new GithubIntegrationError(
      messageFromData(response.data) ?? `GitHub health check failed with status ${response.status}`,
      category,
      response.status,
      response.headers["x-github-request-id"],
      response.headers["retry-after"],
      response.headers["x-ratelimit-reset"]
    )
  }
  const grantedPermissions = permissionList(response.data.permissions ?? {})
  const missing = REQUIRED_APP_PERMISSIONS.filter(
    (required) => !grantedPermissions.includes(required)
  )
  const suspended = Boolean(response.data.suspended_at)
  const healthy = !suspended && missing.length === 0
  const checkedAt = new Date().toISOString()
  return {
    health: healthy ? "healthy" : "degraded",
    code: suspended ? "installation_suspended" : missing.length ? "permissions_missing" : undefined,
    message: suspended
      ? "GitHub App installation is suspended"
      : missing.length
        ? `Missing permissions: ${missing.join(", ")}`
        : undefined,
    checkedAt,
    lastHealthyAt: healthy ? checkedAt : undefined,
    recoveryAction: suspended ? "reconnect" : missing.length ? "review-permissions" : undefined,
    requiredPermissions: [...REQUIRED_APP_PERMISSIONS],
    grantedPermissions,
    rateLimit: rateLimit(response.headers),
  }
}

async function actionRequest(
  context: IntegrationActionHandlerContext,
  input: Record<string, unknown>,
  path: string,
  method: string,
  body?: unknown
) {
  return (await githubRequest(context, `/repos/${repo(input)}${path}`, method, body)).data
}

export const openPr: IntegrationActionHandler = async (input, context) => {
  const repository = repo(input)
  const base = requiredString(input, "base")
  const head = requiredString(input, "head")
  const title = requiredString(input, "title")
  const assertApprovedHead = async () => {
    // The bound action broker injects this from its host publication checkpoint.
    if (typeof input.expectedHeadSha !== "string") return
    const current = await githubRequest<{ sha: string }>(
      context,
      `/repos/${repository}/commits/${encodeURIComponent(head)}`
    )
    if (current.data.sha !== input.expectedHeadSha)
      throw new Error("Approved pull request head SHA changed")
  }
  if (typeof input.expectedBaseSha === "string") {
    const current = await githubRequest<{ sha: string }>(
      context,
      `/repos/${repository}/commits/${encodeURIComponent(base)}`
    )
    if (current.data.sha !== input.expectedBaseSha)
      throw new Error("Approved pull request base SHA changed")
    // A crash after POST must recover the same remote PR instead of creating another.
    const qualifiedHead = head.includes(":") ? head : `${repository.split("/")[0]}:${head}`
    const existing = await githubRequest<
      Array<{ title: string; body?: string; base?: { ref?: string }; head?: { sha?: string } }>
    >(
      context,
      `/repos/${repository}/pulls?state=all&head=${encodeURIComponent(qualifiedHead)}&base=${encodeURIComponent(base)}&per_page=100`
    )
    if (existing.data.length) {
      const match = existing.data.find(
        (pr) =>
          pr.title === title && (pr.body ?? "") === (input.body ?? "") && pr.base?.ref === base
      )
      if (!match) throw new Error("Existing pull request does not match approved content")
      if (typeof input.expectedHeadSha === "string" && match.head?.sha !== input.expectedHeadSha)
        throw new Error("Existing pull request head does not match approved publication")
      await assertApprovedHead()
      return match
    }
  }
  await assertApprovedHead()
  return actionRequest(context, input, "/pulls", "POST", {
    title,
    head,
    base,
    body: input.body,
    draft: input.draft === true,
  })
}

export const closePr: IntegrationActionHandler = (input, context) =>
  actionRequest(context, input, `/pulls/${positiveInteger(input, "prNumber")}`, "PATCH", {
    state: "closed",
  })

export const mergePr: IntegrationActionHandler = (input, context) =>
  actionRequest(context, input, `/pulls/${positiveInteger(input, "prNumber")}/merge`, "PUT", {
    merge_method: input.mergeMethod ?? "squash",
    commit_title: input.commitTitle,
    commit_message: input.commitMessage,
  })

export const reviewPr: IntegrationActionHandler = async (input, context) => {
  const number = positiveInteger(input, "prNumber")
  const comments = input.comments as
    Array<{ path: string; line: number; side: string; body: string }> | undefined
  if (
    comments !== undefined &&
    (!Array.isArray(comments) ||
      comments.length > 50 ||
      comments.some(
        (comment) =>
          !comment ||
          typeof comment.path !== "string" ||
          !comment.path ||
          comment.path.startsWith("/") ||
          comment.path.includes("\\") ||
          comment.path.split("/").includes("..") ||
          !Number.isSafeInteger(comment.line) ||
          comment.line < 1 ||
          !["LEFT", "RIGHT"].includes(comment.side) ||
          typeof comment.body !== "string" ||
          !comment.body.trim()
      ))
  )
    throw new Error("Invalid inline review comments")
  if (!(comments?.length && input.body === undefined)) requiredString(input, "body")
  const body = typeof input.body === "string" ? input.body : ""
  const event = input.event ?? "COMMENT"
  if (!["COMMENT", "REQUEST_CHANGES", "APPROVE"].includes(event as string))
    throw new Error("Invalid review event")
  if (event === "APPROVE" && comments?.length)
    throw new Error("Approval cannot include unresolved findings")
  if ((event !== "COMMENT" || comments?.length) && typeof input.commitId !== "string")
    throw new Error("A verdict or inline review requires an exact commitId")
  if (typeof input.commitId === "string") {
    const path = `/repos/${repo(input)}/pulls/${number}`
    const current = await githubRequest<{
      head: { sha: string }
      state: string
      draft?: boolean
      body?: string
      user?: { id: number }
    }>(context, path)
    if (
      current.data.state !== "open" ||
      current.data.draft ||
      current.data.head.sha !== input.commitId
    )
      throw new Error("Approved review target SHA changed or PR closed")
    if (event === "APPROVE") {
      if (current.data.body?.includes("<!-- cognia-github-devin:"))
        throw new Error("Cannot approve a Bot-produced pull request")
      // Identity is resolved by the provider, never supplied by the calling Bot.
      // If the credential cannot identify its actor, approval fails closed.
      const viewer = await githubRequest<{ id?: number }>(context, "/user")
      if (!viewer.data.id || !current.data.user?.id)
        throw new Error("Cannot verify review actor identity")
      if (viewer.data.id === current.data.user.id)
        throw new Error("Cannot approve your own pull request")
    }
    // Review markers are stable per run. Search every page before retrying a POST.
    for (let page = 1; ; page += 1) {
      const reviews = await githubRequest<
        Array<{ id?: number; body?: string; commit_id?: string; state?: string }>
      >(context, `${path}/reviews?per_page=100&page=${page}`)
      const match = reviews.data.find(
        (review) =>
          review.body === body &&
          review.commit_id === input.commitId &&
          review.state ===
            (
              {
                COMMENT: "COMMENTED",
                REQUEST_CHANGES: "CHANGES_REQUESTED",
                APPROVE: "APPROVED",
              } as Record<string, string>
            )[event as string]
      )
      if (match) {
        if (comments?.length) {
          if (!match.id) throw new Error("Cannot verify existing inline review")
          const existingComments: typeof comments = []
          for (let commentPage = 1; ; commentPage++) {
            const page = await githubRequest<typeof comments>(
              context,
              `${path}/reviews/${match.id}/comments?per_page=100&page=${commentPage}`
            )
            existingComments.push(...page.data)
            if (page.data.length < 100) break
          }
          const canonical = (items: typeof comments) =>
            JSON.stringify(
              items
                .map((comment) => ({
                  path: comment.path,
                  line: comment.line,
                  side: comment.side,
                  body: comment.body,
                }))
                .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
            )
          if (canonical(existingComments) !== canonical(comments))
            throw new Error("Existing inline review content differs from approved content")
        }
        return match
      }
      if (reviews.data.length < 100) break
    }
  }
  return actionRequest(context, input, `/pulls/${number}/reviews`, "POST", {
    event,
    body,
    ...(comments?.length ? { comments } : {}),
    ...(typeof input.commitId === "string" ? { commit_id: input.commitId } : {}),
  })
}

export const reviewPrInline: IntegrationActionHandler = (input, context) => reviewPr(input, context)

export const commentPr: IntegrationActionHandler = (input, context) =>
  actionRequest(context, input, `/issues/${positiveInteger(input, "prNumber")}/comments`, "POST", {
    body: requiredString(input, "body"),
  })

export const commentIssue: IntegrationActionHandler = (input, context) =>
  actionRequest(
    context,
    input,
    `/issues/${positiveInteger(input, "issueNumber")}/comments`,
    "POST",
    { body: requiredString(input, "body") }
  )

export const labelIssue: IntegrationActionHandler = (input, context) =>
  actionRequest(context, input, `/issues/${positiveInteger(input, "issueNumber")}/labels`, "POST", {
    labels: input.labels,
  })

export const closeIssue: IntegrationActionHandler = (input, context) =>
  actionRequest(context, input, `/issues/${positiveInteger(input, "issueNumber")}`, "PATCH", {
    state: "closed",
    state_reason: input.reason ?? "completed",
  })

/**
 * Field-level edit of an issue: the write half of the issue tracker's
 * bidirectional sync. Only the keys present in the input are sent, so a
 * patch that carries one field never resets the others. `milestone: null`
 * clears the milestone, which is how GitHub spells it.
 */
export const updateIssue: IntegrationActionHandler = (input, context) => {
  const body: Record<string, unknown> = {}
  if (typeof input.title === "string") body.title = input.title
  if (typeof input.body === "string") body.body = input.body
  if (input.state === "open" || input.state === "closed") body.state = input.state
  if (input.stateReason === "completed" || input.stateReason === "not_planned") {
    body.state_reason = input.stateReason
  }
  if (Array.isArray(input.labels)) body.labels = input.labels
  if (input.milestone === null || typeof input.milestone === "number") {
    body.milestone = input.milestone
  }
  if (Array.isArray(input.assignees)) body.assignees = input.assignees
  return actionRequest(
    context,
    input,
    `/issues/${positiveInteger(input, "issueNumber")}`,
    "PATCH",
    body
  )
}

export const createRelease: IntegrationActionHandler = (input, context) =>
  actionRequest(context, input, "/releases", "POST", {
    tag_name: requiredString(input, "tag"),
    name: input.name,
    body: input.body,
    target_commitish: input.target,
    draft: input.draft === true,
    prerelease: input.prerelease === true,
  })

export const pushTag: IntegrationActionHandler = (input, context) =>
  actionRequest(context, input, "/git/refs", "POST", {
    ref: `refs/tags/${requiredString(input, "tag")}`,
    sha: requiredString(input, "sha"),
  })

export const generateChangelog: IntegrationActionHandler = async (input, context) => {
  const result = (await actionRequest(
    context,
    input,
    `/compare/${encodeURIComponent(requiredString(input, "base"))}...${encodeURIComponent(requiredString(input, "head"))}`,
    "GET"
  )) as { commits?: Array<{ sha: string; commit?: { message?: string } }> }
  const commits = result.commits ?? []
  return {
    markdown: commits
      .map(
        (commit) =>
          `- ${(commit.commit?.message ?? commit.sha).split("\n")[0]} (${commit.sha.slice(0, 7)})`
      )
      .join("\n"),
    commits,
  }
}

/** The host replaces this export with its allowlisted first-party Issue Loop executor. */
export const runIssueLoop: IntegrationActionHandler = async () => {
  throw new Error("GitHub Issue Loop host executor is unavailable")
}

function objectSchema(required: string[], properties: Record<string, unknown>) {
  return { type: "object", required, properties, additionalProperties: false }
}

const repoProperty = { repoFullName: { type: "string", minLength: 3 } }
const prProperty = { ...repoProperty, prNumber: { type: "integer", minimum: 1 } }
const issueProperty = { ...repoProperty, issueNumber: { type: "integer", minimum: 1 } }
const reviewEvent = { type: "string", enum: ["APPROVE", "REQUEST_CHANGES", "COMMENT"] }
const reviewComments = {
  type: "array",
  maxItems: 50,
  items: {
    type: "object",
    required: ["path", "line", "side", "body"],
    properties: {
      path: { type: "string" },
      line: { type: "integer", minimum: 1 },
      side: { type: "string", enum: ["LEFT", "RIGHT"] },
      body: { type: "string" },
    },
  },
}

const actionDefinitions = [
  {
    id: "openPr",
    handler: "openPr",
    risk: "write",
    required: ["repoFullName", "title", "head", "base"],
    properties: {
      ...repoProperty,
      title: { type: "string" },
      head: { type: "string" },
      base: { type: "string" },
      body: { type: "string" },
      draft: { type: "boolean" },
      expectedBaseSha: { type: "string", pattern: "^[a-fA-F0-9]{40}$" },
    },
  },
  {
    id: "closePr",
    handler: "closePr",
    risk: "destructive",
    required: ["repoFullName", "prNumber"],
    properties: prProperty,
  },
  {
    id: "mergePr",
    handler: "mergePr",
    risk: "destructive",
    required: ["repoFullName", "prNumber"],
    properties: {
      ...prProperty,
      mergeMethod: { type: "string", enum: ["merge", "squash", "rebase"] },
      commitTitle: { type: "string" },
      commitMessage: { type: "string" },
    },
  },
  {
    id: "reviewPr",
    handler: "reviewPr",
    risk: "write",
    required: ["repoFullName", "prNumber", "body"],
    properties: {
      ...prProperty,
      body: { type: "string" },
      event: reviewEvent,
      comments: reviewComments,
      commitId: { type: "string", pattern: "^[a-fA-F0-9]{40}$" },
    },
  },
  {
    id: "reviewPrInline",
    handler: "reviewPrInline",
    risk: "write",
    required: ["repoFullName", "prNumber", "comments"],
    properties: {
      ...prProperty,
      body: { type: "string" },
      event: reviewEvent,
      comments: reviewComments,
      commitId: { type: "string", pattern: "^[a-fA-F0-9]{40}$" },
    },
  },
  {
    id: "commentPr",
    handler: "commentPr",
    risk: "write",
    required: ["repoFullName", "prNumber", "body"],
    properties: { ...prProperty, body: { type: "string" } },
  },
  {
    id: "commentIssue",
    handler: "commentIssue",
    risk: "write",
    required: ["repoFullName", "issueNumber", "body"],
    properties: { ...issueProperty, body: { type: "string" } },
  },
  {
    id: "labelIssue",
    handler: "labelIssue",
    risk: "write",
    required: ["repoFullName", "issueNumber", "labels"],
    properties: { ...issueProperty, labels: { type: "array", items: { type: "string" } } },
  },
  {
    id: "closeIssue",
    handler: "closeIssue",
    risk: "destructive",
    required: ["repoFullName", "issueNumber"],
    properties: {
      ...issueProperty,
      reason: { type: "string", enum: ["completed", "not_planned"] },
    },
  },
  {
    id: "updateIssue",
    handler: "updateIssue",
    risk: "write",
    required: ["repoFullName", "issueNumber"],
    properties: {
      ...issueProperty,
      title: { type: "string" },
      body: { type: "string" },
      state: { type: "string", enum: ["open", "closed"] },
      stateReason: { type: "string", enum: ["completed", "not_planned"] },
      labels: { type: "array", items: { type: "string" } },
      milestone: { type: ["integer", "null"] },
      assignees: { type: "array", items: { type: "string" } },
    },
  },
  {
    id: "createRelease",
    handler: "createRelease",
    risk: "destructive",
    required: ["repoFullName", "tag"],
    properties: {
      ...repoProperty,
      tag: { type: "string" },
      name: { type: "string" },
      body: { type: "string" },
      target: { type: "string" },
      draft: { type: "boolean" },
      prerelease: { type: "boolean" },
    },
  },
  {
    id: "generateChangelog",
    handler: "generateChangelog",
    risk: "read",
    required: ["repoFullName", "base", "head"],
    properties: { ...repoProperty, base: { type: "string" }, head: { type: "string" } },
  },
  {
    id: "pushTag",
    handler: "pushTag",
    risk: "destructive",
    required: ["repoFullName", "tag", "sha"],
    properties: { ...repoProperty, tag: { type: "string" }, sha: { type: "string" } },
  },
  {
    id: "runIssueLoop",
    handler: "runIssueLoop",
    risk: "write",
    required: ["repoFullName", "issueNumber", "head", "base"],
    properties: {
      ...issueProperty,
      head: { type: "string" },
      base: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
    },
  },
] as const

const repositoryEvents = [
  "pull_request.opened",
  "pull_request.synchronize",
  "pull_request.closed",
  "pull_request.reopened",
  "pull_request.edited",
  "pull_request.ready_for_review",
  "pull_request.converted_to_draft",
  "pull_request.labeled",
  "pull_request.unlabeled",
  "pull_request.review_requested",
  "issues.opened",
  "issues.closed",
  "issues.reopened",
  "issues.edited",
  "issues.unlabeled",
  "issues.assigned",
  "issues.labeled",
  "issue_comment.created",
  "check_run.completed",
  "check_suite.completed",
  "workflow_run.completed",
  "workflow_job.completed",
  "pull_request_review.submitted",
  "release.published",
  "push.received",
] as const
const lifecycleEvents = [
  "installation.created",
  "installation.deleted",
  "installation.suspend",
  "installation.unsuspend",
  "installation.new_permissions_accepted",
  "installation_repositories.added",
  "installation_repositories.removed",
  "github_app_authorization.revoked",
] as const

export function normalizeGithub(
  delivery: IntegrationVerifiedDelivery,
  context: { pluginId: string; integrationId: string; accountId: string }
) {
  const payload = JSON.parse(delivery.body) as Record<string, unknown>
  const repository = payload.repository as GithubRepository | undefined
  const installation = payload.installation as
    { id?: number; account?: { login?: string } } | undefined
  const action = typeof payload.action === "string" ? payload.action : "received"
  const eventType = `${delivery.eventType ?? "webhook"}.${action}`
  return {
    schemaVersion: 1 as const,
    id: `${delivery.deliveryId}:${eventType}`,
    ...context,
    deliveryId: delivery.deliveryId,
    eventType,
    resource: repository?.full_name
      ? { kind: "repository", id: repository.full_name, name: repository.full_name }
      : installation?.id
        ? {
            kind: "installation",
            id: String(installation.id),
            name: installation.account?.login,
          }
        : undefined,
    actor:
      payload.sender && typeof payload.sender === "object"
        ? {
            id: String((payload.sender as { id?: unknown }).id ?? ""),
            label: (payload.sender as { login?: string }).login,
          }
        : undefined,
    occurredAt: delivery.receivedAt,
    receivedAt: delivery.receivedAt,
    payload,
  }
}

export const githubIntegration: PluginIntegrationDef = {
  id: "github",
  label: "GitHub",
  description: "Pull requests, issues, reviews, releases, tags, and Issue→PR delivery.",
  authStrategies: [
    {
      id: "github-app",
      type: "app",
      label: "GitHub App",
      providerId: "github-app",
      scopes: [...REQUIRED_APP_PERMISSIONS],
      configSchema: {
        type: "object",
        required: ["appId", "installationId", "privateKey"],
        properties: {
          appId: { type: "integer", minimum: 1 },
          installationId: { type: "integer", minimum: 1 },
          privateKey: { type: "string", format: "secret", minLength: 1 },
          accountLabel: { type: "string" },
          // ADR-0176. Empty means github.com, which is what every account
          // created before this field existed means.
          hostUrl: { type: "string", title: "Enterprise server URL" },
        },
      },
      requestAuth: { type: "bearer" },
    },
    {
      id: "pat",
      type: "personal-access-token",
      label: "Personal access token (advanced)",
      providerId: "github-pat",
      scopes: ["repo"],
      configSchema: {
        type: "object",
        required: ["token", "accountLabel"],
        properties: {
          token: { type: "string", format: "secret", minLength: 1 },
          accountLabel: { type: "string", minLength: 1 },
          /** See the App strategy's `hostUrl`. */
          hostUrl: { type: "string", title: "Enterprise server URL" },
        },
      },
      requestAuth: { type: "bearer" },
    },
  ],
  resourceKinds: ["repository", "installation"],
  resourceProvider: { handler: "listGithubResources", kinds: ["repository"] },
  healthProvider: { handler: "checkGithubHealth" },
  eventTypes: [...repositoryEvents, ...lifecycleEvents].map((id) => ({
    id,
    label: id,
    resourceKinds: [id.startsWith("installation") ? "installation" : "repository"],
  })),
  inboxProjections: [
    {
      id: "pull-request-thread",
      label: "Pull request thread",
      eventTypes: repositoryEvents.filter((id) => id.startsWith("pull_request")),
      threadKeyPointer: "/pull_request/number",
      titlePointer: "/pull_request/title",
      bodyPointer: "/pull_request/body",
      urlPointer: "/pull_request/html_url",
    },
    {
      id: "issue-thread",
      label: "Issue thread",
      eventTypes: repositoryEvents.filter((id) => id.startsWith("issues.")),
      threadKeyPointer: "/issue/number",
      titlePointer: "/issue/title",
      bodyPointer: "/issue/body",
      urlPointer: "/issue/html_url",
    },
    {
      id: "issue-comment-thread",
      label: "Issue comment thread",
      eventTypes: ["issue_comment.created"],
      threadKeyPointer: "/issue/number",
      titlePointer: "/issue/title",
      bodyPointer: "/comment/body",
      urlPointer: "/comment/html_url",
    },
  ],
  actions: actionDefinitions.map((action) => ({
    id: action.id,
    operationId: `github.${action.id}`,
    label: action.id,
    handler: action.handler,
    risk: action.risk,
    idempotency: action.risk === "read" ? "supported" : "required",
    inputSchema: objectSchema([...action.required], action.properties),
    timeoutMs: action.id === "runIssueLoop" ? 30 * 60_000 : 30_000,
  })),
  ingress: {
    normalizer: "normalizeGithub",
    verification: {
      type: "hmac-sha256",
      signatureHeader: "x-hub-signature-256",
      encoding: "hex",
      prefix: "sha256=",
      signedPayload: [{ source: "body" }],
    },
    deliveryIdHeader: "x-github-delivery",
    eventTypeHeader: "x-github-event",
  },
  allowedOrigins: [API_ORIGIN],
}

export const workflowKindAliases = {
  "trigger.github.webhook": "trigger.integration.event",
  ...Object.fromEntries(
    actionDefinitions.map((action) => [
      `action.github.${action.id}`,
      `github-delivery.action.${action.id}`,
    ])
  ),
}

export const manifest: PluginManifest = {
  id: "github-delivery",
  name: "GitHub Delivery",
  description: "GitHub pull request, issue, review, release, tag, and Issue→PR delivery.",
  author: { name: "Cognia Official", publicKey: "HywtZKOopAEuRqZGzXIfdqo9ID/FfBgXFvKIj9TF4N0=" },
  version: "3.0.0",
  engines: { cognia: ">=0.1.0" },
  type: "frontend",
  capabilities: ["integrations"],
  permissions: [
    "integrations:read",
    "integrations:events",
    "integrations:execute",
    "integrations:manage",
  ],
  main: "dist/index.js",
  runtimeCompatibility: {
    tauri: { availability: "supported", entrypoint: "src/index.ts" },
    browser: {
      availability: "degraded",
      reason:
        "HTTP and event actions remain available, but runIssueLoop requires the desktop host.",
    },
    mobile: {
      availability: "degraded",
      reason:
        "HTTP and event actions remain available, but runIssueLoop requires the desktop host.",
    },
    headless: {
      availability: "degraded",
      reason:
        "HTTP and event actions remain available, but runIssueLoop requires the desktop host.",
    },
  },
  integrations: [githubIntegration],
  browserSiteProviders: [
    {
      id: "github-web",
      label: "GitHub Web",
      description: "Explicit-confirmation fallback through an isolated github.com browser profile.",
      allowedDomains: ["github.com"],
      loginStartUrl: "https://github.com/login",
      persistentProfile: true,
      allowUploads: true,
      allowDownloads: true,
      operations: actionDefinitions.map((action) => ({
        id: `web-${action.id}`,
        operationId: `github.${action.id}`,
        label: action.id,
        risk: action.risk,
      })),
    },
  ],
  services: [
    {
      id: "github",
      label: "GitHub",
      description: "GitHub API, verified webhooks, Inbox events, and an explicit Browser fallback.",
      fallbackPolicy: "confirm",
      providers: [
        {
          id: "api",
          kind: "integration",
          contributionId: "github",
          priority: 100,
          surfaces: ["chat", "workflow", "inbox"],
        },
        {
          id: "web",
          kind: "browser",
          contributionId: "github-web",
          priority: 10,
          surfaces: ["chat", "workflow"],
        },
      ],
    },
  ],
  workflowKindAliases,
  dexie: {
    tables: [
      { name: "repos", schema: "&fullName, credentialMode, createdAt" },
      {
        name: "workOrders",
        schema: "++id, [status+repoFullName], issueNumber, prNumber, createdAt, updatedAt",
      },
      { name: "events", schema: "&deliveryId, [repoFullName+seenAt], kind, source" },
      { name: "audit", schema: "++id, [repoFullName+at], runId, &[runId+stepId+at]" },
    ],
  },
}

const definition: PluginDefinition = {
  manifest,
  activate: async (context) => {
    context.logger?.info("GitHub Delivery v3 activated with host-owned credentials")
  },
}

export default definition
