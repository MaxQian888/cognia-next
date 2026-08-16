import {
  fetchRepoIssues,
  hasNextPage,
  ISSUES_PER_PAGE,
  MAX_ISSUE_PAGES,
  toMirrorRow,
  type OctokitLike,
} from "./issues"

const NOW = 1_700_000_000_000

function rawIssue(over: Record<string, unknown> = {}) {
  return {
    number: 7,
    title: "Something broke",
    body: "steps to reproduce",
    state: "open",
    html_url: "https://github.test/o/r/issues/7",
    comments: 3,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    user: { login: "alice" },
    assignees: [{ login: "bob" }],
    labels: [{ name: "bug", color: "ff0000" }],
    ...over,
  }
}

function octokit(
  responses: Array<{ status?: number; headers?: Record<string, string>; data?: unknown }>
): { client: OctokitLike; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = []
  let index = 0
  return {
    calls,
    client: {
      async request(_route, params) {
        calls.push(params ?? {})
        const response = responses[Math.min(index, responses.length - 1)]
        index += 1
        return {
          status: response.status ?? 200,
          headers: response.headers ?? {},
          data: response.data ?? [],
        }
      },
    },
  }
}

describe("hasNextPage", () => {
  it("detects a next link", () => {
    expect(hasNextPage('<https://api.github.com/x?page=2>; rel="next"')).toBe(true)
  })

  it("is false for a last-only link, or none at all", () => {
    expect(hasNextPage('<https://api.github.com/x?page=9>; rel="last"')).toBe(false)
    expect(hasNextPage(undefined)).toBe(false)
  })
})

describe("toMirrorRow", () => {
  const context = { repoFullName: "o/r", syncedAt: NOW }

  it("builds a stable, human-legible id", () => {
    expect(toMirrorRow(rawIssue(), context).id).toBe("o/r#7")
  })

  it("carries authorship, assignees and labels across", () => {
    expect(toMirrorRow(rawIssue(), context)).toMatchObject({
      authorLogin: "alice",
      assigneeLogins: ["bob"],
      labels: [{ name: "bug", color: "ff0000" }],
      commentCount: 3,
    })
  })

  it("converts GitHub timestamps to epoch ms", () => {
    const row = toMirrorRow(rawIssue(), context)
    expect(row.createdAt).toBe(Date.parse("2026-01-01T00:00:00Z"))
    expect(row.updatedAt).toBe(Date.parse("2026-01-02T00:00:00Z"))
  })

  it("falls back to the sync time for an unparseable timestamp", () => {
    const row = toMirrorRow(rawIssue({ created_at: "not-a-date" }), context)
    expect(row.createdAt).toBe(NOW)
  })

  it("tolerates string labels, which older payloads still use", () => {
    expect(toMirrorRow(rawIssue({ labels: ["bug", null] }), context).labels).toEqual([
      { name: "bug" },
    ])
  })

  it("tolerates a missing author, assignees and labels", () => {
    const row = toMirrorRow(
      rawIssue({ user: null, assignees: null, labels: null, body: null }),
      context
    )
    expect(row.assigneeLogins).toEqual([])
    expect(row.labels).toEqual([])
    expect(row).not.toHaveProperty("authorLogin")
    expect(row).not.toHaveProperty("body")
  })

  it("keeps `not_planned` distinct from a normal closure", () => {
    expect(
      toMirrorRow(rawIssue({ state: "closed", state_reason: "not_planned" }), context)
    ).toMatchObject({ state: "closed", stateReason: "not_planned" })
  })

  it("drops an unrecognised state_reason rather than storing it raw", () => {
    expect(
      toMirrorRow(rawIssue({ state: "closed", state_reason: "duplicate" }), context)
    ).not.toHaveProperty("stateReason")
  })

  it("stamps the delivery container and ETag when given", () => {
    expect(
      toMirrorRow(rawIssue(), { ...context, issueProjectId: "p1", etag: 'W/"abc"' })
    ).toMatchObject({ issueProjectId: "p1", etag: 'W/"abc"' })
  })
})

describe("fetchRepoIssues", () => {
  it("rejects a malformed repository name", async () => {
    const { client } = octokit([{}])
    await expect(fetchRepoIssues(client, { repoFullName: "nope" })).rejects.toThrow(
      /Invalid repository/
    )
  })

  it("requests every state, at the max page size", async () => {
    const { client, calls } = octokit([{ data: [] }])
    await fetchRepoIssues(client, { repoFullName: "o/r", now: NOW })
    expect(calls[0]).toMatchObject({
      owner: "o",
      repo: "r",
      state: "all",
      per_page: ISSUES_PER_PAGE,
      page: 1,
    })
  })

  it("passes `since` when the caller has a watermark", async () => {
    const { client, calls } = octokit([{ data: [] }])
    await fetchRepoIssues(client, { repoFullName: "o/r", since: "2026-01-01T00:00:00Z" })
    expect(calls[0]).toMatchObject({ since: "2026-01-01T00:00:00Z" })
  })

  it("sends the ETag only on the first page", async () => {
    const { client, calls } = octokit([
      { data: [rawIssue()], headers: { link: '<x>; rel="next"' } },
      { data: [rawIssue({ number: 8 })] },
    ])
    await fetchRepoIssues(client, { repoFullName: "o/r", etag: 'W/"abc"', now: NOW })
    expect(calls[0].headers).toMatchObject({ "if-none-match": 'W/"abc"' })
    expect(calls[1].headers).toEqual({})
  })

  it("short-circuits on 304 without touching the cache", async () => {
    const { client, calls } = octokit([{ status: 304, headers: { etag: 'W/"abc"' } }])
    const result = await fetchRepoIssues(client, { repoFullName: "o/r", etag: 'W/"abc"' })
    expect(result).toMatchObject({ notModified: true, rows: [], etag: 'W/"abc"' })
    expect(calls).toHaveLength(1)
  })

  it("treats a thrown 304 the same as a resolved one", async () => {
    const client: OctokitLike = {
      async request() {
        throw Object.assign(new Error("Not modified"), {
          status: 304,
          response: { headers: { etag: 'W/"abc"' } },
        })
      },
    }
    expect(await fetchRepoIssues(client, { repoFullName: "o/r", etag: 'W/"abc"' })).toMatchObject({
      notModified: true,
    })
  })

  it("propagates a real failure instead of swallowing it", async () => {
    const client: OctokitLike = {
      async request() {
        throw Object.assign(new Error("Bad credentials"), { status: 401 })
      },
    }
    await expect(fetchRepoIssues(client, { repoFullName: "o/r" })).rejects.toThrow(
      /Bad credentials/
    )
  })

  it("excludes pull requests, which the issues endpoint also returns", async () => {
    const { client } = octokit([
      { data: [rawIssue(), rawIssue({ number: 8, pull_request: { url: "x" } })] },
    ])
    const result = await fetchRepoIssues(client, { repoFullName: "o/r", now: NOW })
    expect(result.rows.map((row) => row.number)).toEqual([7])
  })

  it("walks pages until the Link header stops advertising a next one", async () => {
    const { client, calls } = octokit([
      { data: [rawIssue()], headers: { link: '<x>; rel="next"', etag: 'W/"p1"' } },
      { data: [rawIssue({ number: 8 })] },
    ])
    const result = await fetchRepoIssues(client, { repoFullName: "o/r", now: NOW })
    expect(calls).toHaveLength(2)
    expect(result.rows.map((row) => row.number)).toEqual([7, 8])
    expect(result.truncated).toBe(false)
  })

  it("keeps the FIRST page's ETag, which is what a conditional request revalidates", async () => {
    const { client } = octokit([
      { data: [rawIssue()], headers: { link: '<x>; rel="next"', etag: 'W/"p1"' } },
      { data: [], headers: { etag: 'W/"p2"' } },
    ])
    expect((await fetchRepoIssues(client, { repoFullName: "o/r" })).etag).toBe('W/"p1"')
  })

  it("stops at the page cap and says so rather than pretending it finished", async () => {
    const { client, calls } = octokit([
      { data: [rawIssue()], headers: { link: '<x>; rel="next"' } },
    ])
    const result = await fetchRepoIssues(client, { repoFullName: "o/r", now: NOW })
    expect(calls).toHaveLength(MAX_ISSUE_PAGES)
    expect(result.truncated).toBe(true)
  })

  it("surfaces the remaining rate-limit budget", async () => {
    const { client } = octokit([{ data: [], headers: { "x-ratelimit-remaining": "42" } }])
    expect((await fetchRepoIssues(client, { repoFullName: "o/r" })).rateLimitRemaining).toBe(42)
  })

  it("stamps the delivery container on every mirrored row", async () => {
    const { client } = octokit([{ data: [rawIssue()] }])
    const result = await fetchRepoIssues(client, {
      repoFullName: "o/r",
      issueProjectId: "p1",
      now: NOW,
    })
    expect(result.rows[0].issueProjectId).toBe("p1")
  })
})
