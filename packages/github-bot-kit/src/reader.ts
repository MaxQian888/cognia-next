import type { GithubUser, Item } from "./types"

export class GithubRequestError extends Error {
  constructor(
    public status: number,
    public retryAt?: number,
    /**
     * GitHub refused for quota, not for permission: a 429, or a 403 that
     * carries `Retry-After` or an exhausted `X-RateLimit-Remaining`. A 403
     * without either is a real refusal and must not be retried as if it were
     * a rate limit.
     */
    public rateLimited = false
  ) {
    super(
      `GitHub request failed (${status})${retryAt ? `; retry after ${new Date(retryAt).toISOString()}` : ""}`
    )
    this.name = "GithubRequestError"
  }
}

/** The Bot binding a read goes through: the run it belongs to and the integration slot. */
export interface GithubReadBinding {
  runId: string
  slotId: string
}

/**
 * The slice of `ctx.integrations` the reader uses. Declared here rather than
 * imported, so the kit depends on nothing; a plugin context satisfies it as is.
 */
export interface GithubReadTransport {
  integrations: {
    authenticatedRequest<T = unknown>(
      binding: GithubReadBinding,
      input: string,
      init?: { method?: string; headers?: Record<string, string> }
    ): Promise<{ status: number; headers: Record<string, string>; data: T }>
  }
}

export interface GithubPageWindow<T> {
  items: T[]
  /** More pages existed beyond `maxPages`. */
  truncated: boolean
}

/**
 * Reads only; the host owns authentication, repository scope, and HTTP origin checks.
 *
 * Paths are relative to the API root: the host resolves them against the bound
 * account's own deployment, so the same bot reads github.com and GitHub
 * Enterprise repositories (ADR-0176).
 */
export function githubReader(
  ctx: GithubReadTransport,
  binding: GithubReadBinding,
  repository: string,
  now = Date.now
) {
  const prefix = `/repos/${repository}`
  async function read<T>(url: string, etag?: string) {
    const response = await ctx.integrations.authenticatedRequest<T>(
      { runId: binding.runId, slotId: binding.slotId },
      url,
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
      const rateLimited =
        response.status === 429 ||
        (response.status === 403 && (delay > 0 || headers["x-ratelimit-remaining"] === "0"))
      throw new GithubRequestError(response.status, retryAt, rateLimited)
    }
    return { ...response, headers }
  }
  async function request<T>(path: string, etag?: string) {
    if (path && !path.startsWith("/")) throw new Error("Expected a repository-relative GitHub path")
    return read<T>(`${prefix}${path}`, etag)
  }
  async function pageWindow<T>(
    path: string,
    options: { field?: string; maxPages?: number } = {}
  ): Promise<GithubPageWindow<T>> {
    const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY
    const items: T[] = []
    for (let page = 1; ; page++) {
      const separator = path.includes("?") ? "&" : "?"
      const response = await request<T[] | Record<string, T[]>>(
        `${path}${separator}per_page=100&page=${page}`
      )
      const data = options.field
        ? (response.data as Record<string, T[]>)[options.field]
        : response.data
      if (!Array.isArray(data)) throw new Error(`Invalid GitHub collection: ${path}`)
      items.push(...data)
      // Link is authoritative; a full last page can legitimately have exactly 100 items.
      if (!/rel="next"/.test(response.headers.link ?? "")) return { items, truncated: false }
      if (page >= maxPages) return { items, truncated: true }
    }
  }
  async function pages<T>(path: string, field?: string): Promise<T[]> {
    return (await pageWindow<T>(path, { field })).items
  }
  return {
    request,
    pages,
    pageWindow,
    viewer: async () => (await read<GithubUser>("/user")).data,
    item: async (number: number, kind: "issue" | "pr") =>
      (await request<Item>(`/${kind === "pr" ? "pulls" : "issues"}/${number}`)).data,
  }
}

export type GithubReader = ReturnType<typeof githubReader>
