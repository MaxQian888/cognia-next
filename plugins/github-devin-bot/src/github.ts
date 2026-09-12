import type { PluginContext } from "@cognia/plugin-sdk"

export interface Item {
  number: number
  title: string
  body: string | null
  state: string
  created_at: string
  updated_at: string
  html_url?: string
  draft?: boolean
  pull_request?: { url: string }
  head?: { sha: string; ref: string; repo: { full_name: string } | null }
  base?: { sha: string; ref: string; repo: { full_name: string } }
}

export interface WorkflowRun {
  id: number
  head_sha: string
  status: string
  conclusion: string | null
  run_attempt?: number
  created_at?: string
  updated_at?: string
  html_url?: string
  pull_requests?: Array<{ number: number }>
}

export interface CheckRun {
  id: number
  name: string
  head_sha: string
  status: string
  conclusion: string | null
  details_url?: string
  output?: { title?: string; summary?: string; text?: string }
}

export class GithubRequestError extends Error {
  constructor(
    public status: number,
    public retryAt?: number
  ) {
    super(
      `GitHub request failed (${status})${retryAt ? `; retry after ${new Date(retryAt).toISOString()}` : ""}`
    )
    this.name = "GithubRequestError"
  }
}

/** Reads only; the host owns authentication, repository scope, and HTTP origin checks. */
export function githubReader(
  ctx: PluginContext,
  runId: string,
  repository: string,
  now = Date.now
) {
  const prefix = `https://api.github.com/repos/${repository}`
  async function request<T>(path: string, etag?: string) {
    if (path && !path.startsWith("/")) throw new Error("Expected a repository-relative GitHub path")
    const response = await ctx.integrations.authenticatedRequest<T>(
      { runId, slotId: "github" },
      `${prefix}${path}`,
      {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          ...(etag ? { "If-None-Match": etag } : {}),
        },
      }
    )
    const headers = Object.fromEntries(
      Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), value])
    )
    if (response.status !== 304 && (response.status < 200 || response.status >= 300)) {
      const delay = Number(headers["retry-after"])
      const reset = Number(headers["x-ratelimit-reset"])
      const retryAt =
        response.status === 429 || response.status === 403
          ? delay > 0
            ? now() + delay * 1000
            : reset > 0
              ? reset * 1000
              : now() + 60_000
          : undefined
      throw new GithubRequestError(response.status, retryAt)
    }
    return { ...response, headers }
  }
  async function pages<T>(path: string, field?: string): Promise<T[]> {
    const items: T[] = []
    for (let page = 1; ; page++) {
      const separator = path.includes("?") ? "&" : "?"
      const response = await request<T[] | Record<string, T[]>>(
        `${path}${separator}per_page=100&page=${page}`
      )
      const data = field ? (response.data as Record<string, T[]>)[field] : response.data
      if (!Array.isArray(data)) throw new Error(`Invalid GitHub collection: ${path}`)
      items.push(...data)
      // Link is authoritative; a full last page can legitimately have exactly 100 items.
      if (!/rel="next"/.test(response.headers.link ?? "")) break
    }
    return items
  }
  return {
    request,
    pages,
    item: async (number: number, kind: "issue" | "pr") =>
      (await request<Item>(`/${kind === "pr" ? "pulls" : "issues"}/${number}`)).data,
  }
}

export interface Work {
  repository: string
  number: number
  kind: "issue" | "pr"
  mode: "implement" | "review" | "repair"
  revision: string
  workflowRunId?: number
  workflowAttempt?: number
}

export function workId(work: Work): string {
  // CI deliveries share one repair identity for a commit, even when several jobs fail.
  return `${work.repository.toLowerCase()}/${work.kind}/${work.number}/${work.mode}/${work.revision}`
}

export const resourceId = (repository: string, number: number) =>
  `${repository.toLowerCase()}#${number}`
export const failedConclusion = (value: string | null) =>
  ["failure", "timed_out", "action_required", "startup_failure"].includes(value ?? "")

export function parseWork(value: unknown, repository: string): Work {
  if (!value || typeof value !== "object") throw new Error("Invalid work event")
  const work = value as Work
  if (
    work.repository?.toLowerCase() !== repository.toLowerCase() ||
    !Number.isSafeInteger(work.number) ||
    work.number < 1 ||
    !["issue", "pr"].includes(work.kind) ||
    !["implement", "review", "repair"].includes(work.mode) ||
    typeof work.revision !== "string" ||
    !work.revision ||
    (work.kind === "issue" && work.mode !== "implement") ||
    (work.kind === "pr" && work.mode === "implement")
  ) {
    throw new Error("Invalid or out-of-scope work event")
  }
  return work
}
