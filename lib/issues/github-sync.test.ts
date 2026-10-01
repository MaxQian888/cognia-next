import type { GithubIssueMirrorRow } from "@/lib/db/github-issue-mirror-types"
import type { OctokitLike } from "@/lib/github/issues"
import { syncRepoIssues, syncWorkspaceRepos, type SyncRepoIssuesDeps } from "./github-sync"

const NOW = 1_700_000_000_000

function rawIssue(number = 1, over: Record<string, unknown> = {}) {
  return {
    number,
    title: `Issue ${number}`,
    state: "open",
    html_url: `https://github.test/o/r/issues/${number}`,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    ...over,
  }
}

function octokit(
  responses: Array<{ status?: number; headers?: Record<string, string>; data?: unknown }>
) {
  const calls: Array<Record<string, unknown>> = []
  let index = 0
  const client: OctokitLike = {
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
  }
  return { client, calls }
}

function deps(
  client: OctokitLike,
  over: Partial<SyncRepoIssuesDeps> = {}
): SyncRepoIssuesDeps & {
  written: GithubIssueMirrorRow[][]
  pruned: Array<[string, number[]]>
} {
  const written: GithubIssueMirrorRow[][] = []
  const pruned: Array<[string, number[]]> = []
  return {
    written,
    pruned,
    pruneRepoMirror: async (repo, keep) => {
      pruned.push([repo, [...keep].sort((a, b) => a - b)])
      return 0
    },
    resolveOctokit: async () => client,
    latestMirroredUpdate: async () => undefined,
    repoMirrorEtag: async () => undefined,
    upsertGithubIssues: async (rows) => {
      written.push([...rows])
    },
    now: () => NOW,
    ...over,
  }
}

const INPUT = { repoFullName: "o/r", issueProjectId: "p1" }

describe("syncRepoIssues", () => {
  it("stores what it fetched and binds it to the container", async () => {
    const { client } = octokit([{ data: [rawIssue(1)] }])
    const d = deps(client)
    const result = await syncRepoIssues(INPUT, d)

    expect(result).toMatchObject({ repoFullName: "o/r", written: 1, notModified: false })
    expect(d.written[0][0]).toMatchObject({ id: "o/r#1", issueProjectId: "p1" })
  })

  it("overlaps the stored watermark without reusing unscoped legacy row ETags", async () => {
    const { client, calls } = octokit([{ data: [] }])
    await syncRepoIssues(INPUT, {
      ...deps(client),
      latestMirroredUpdate: async () => Date.parse("2026-01-05T00:00:00Z"),
      repoMirrorEtag: async () => 'W/"abc"',
    })
    expect(calls[0]).toMatchObject({ since: "2026-01-04T23:59:59.000Z" })
    expect(calls[0].headers).toEqual({})
  })

  it("rejects an unexpected 304 instead of reusing an unvalidated legacy cache", async () => {
    const { client } = octokit([{ status: 304, headers: { etag: 'W/"abc"' } }])
    const d = deps(client, { repoMirrorEtag: async () => 'W/"abc"' })
    await expect(syncRepoIssues(INPUT, d)).rejects.toMatchObject({ status: 304 })
    expect(d.written).toEqual([])
  })

  it("writes nothing when the window is genuinely quiet", async () => {
    const { client } = octokit([{ data: [] }])
    const d = deps(client)
    expect(await syncRepoIssues(INPUT, d)).toMatchObject({ written: 0, notModified: false })
    expect(d.written).toEqual([])
  })

  it("drops the watermark and ETag for a full re-read", async () => {
    const { client, calls } = octokit([{ data: [] }])
    await syncRepoIssues(
      { ...INPUT, full: true },
      {
        ...deps(client),
        latestMirroredUpdate: async () => 999,
        repoMirrorEtag: async () => 'W/"abc"',
      }
    )
    expect(calls[0]).not.toHaveProperty("since")
    expect(calls[0].headers).toEqual({})
  })

  it("prunes issues a full read no longer lists (transferred or deleted)", async () => {
    const { client } = octokit([{ data: [rawIssue(1), rawIssue(3)] }])
    const d = deps(client, { pruneRepoMirror: jest.fn(async () => 2) })
    const result = await syncRepoIssues({ ...INPUT, full: true }, d)
    expect(d.pruneRepoMirror).toHaveBeenCalledWith("o/r", new Set([1, 3]))
    expect(result.removed).toBe(2)
  })

  it("never prunes on an incremental read — unchanged issues are simply not listed", async () => {
    const { client } = octokit([{ data: [rawIssue(1)] }])
    const d = deps(client)
    expect((await syncRepoIssues(INPUT, d)).removed).toBe(0)
    expect(d.pruned).toEqual([])
  })

  it("never writes or prunes when the pagination safety ceiling is reached", async () => {
    // A cap-truncated read omits whatever did not fit; pruning then would
    // delete live issues.
    const pages = Array.from({ length: 40 }, () => ({
      data: [rawIssue(1)],
      headers: { link: '<x>; rel="next"' },
    }))
    const { client } = octokit(pages)
    const d = deps(client)
    await expect(syncRepoIssues({ ...INPUT, full: true }, d)).rejects.toThrow(/incomplete/i)
    expect(d.written).toEqual([])
    expect(d.pruned).toEqual([])
  })

  it.each([401, 403, 404, 429])("preserves the mirror after a thrown HTTP %s", async (status) => {
    const d = deps({
      request: async () => {
        throw Object.assign(new Error("Unavailable"), { status })
      },
    })
    await expect(syncRepoIssues({ ...INPUT, full: true }, d)).rejects.toMatchObject({ status })
    expect(d.written).toEqual([])
    expect(d.pruned).toEqual([])
  })

  it("preserves the mirror when a later page fails", async () => {
    const { client } = octokit([
      { data: [rawIssue(1)], headers: { link: '<x>; rel="next"' } },
      { status: 404 },
    ])
    const d = deps(client)
    await expect(syncRepoIssues({ ...INPUT, full: true }, d)).rejects.toMatchObject({ status: 404 })
    expect(d.written).toEqual([])
    expect(d.pruned).toEqual([])
  })

  it("imports beyond 1,000 API records including PR-only pages and identical update timestamps", async () => {
    const records = Array.from({ length: 1201 }, (_, index) =>
      rawIssue(index + 1, {
        ...(index < 200 ? { pull_request: { url: "pr" } } : {}),
      })
    )
    const cache = new Map<number, GithubIssueMirrorRow>()
    const calls: Array<Record<string, unknown>> = []
    const client: OctokitLike = {
      request: async (_route, params = {}) => {
        calls.push(params)
        const eligible = records.filter(
          (row) => !params.since || Date.parse(row.updated_at) > Date.parse(String(params.since))
        )
        const offset = (Number(params.page) - 1) * Number(params.per_page)
        return {
          status: 200,
          headers: offset + 100 < eligible.length ? { link: '<x>; rel="next"' } : {},
          data: eligible.slice(offset, offset + 100),
        }
      },
    }
    const d = deps(client, {
      upsertGithubIssues: async (rows) => {
        rows.forEach((row) => cache.set(row.number, row))
      },
      latestMirroredUpdate: async () =>
        cache.size ? Math.max(...[...cache.values()].map((row) => row.updatedAt)) : undefined,
    })
    expect(await syncRepoIssues({ ...INPUT, full: true }, d)).toMatchObject({
      written: 1001,
      truncated: false,
    })
    expect(cache.size).toBe(1001)
    expect(cache.has(1201)).toBe(true)
    expect(calls).toHaveLength(13)
    records.push(rawIssue(1202))
    await syncRepoIssues(INPUT, d)
    expect(cache.size).toBe(1002)
    expect(cache.has(1202)).toBe(true)
  })

  it("surfaces the remaining rate-limit budget", async () => {
    const { client } = octokit([{ data: [], headers: { "x-ratelimit-remaining": "17" } }])
    expect((await syncRepoIssues(INPUT, deps(client))).rateLimitRemaining).toBe(17)
  })

  it("propagates an auth failure instead of reporting a clean sync", async () => {
    const client: OctokitLike = {
      async request() {
        throw Object.assign(new Error("Bad credentials"), { status: 401 })
      },
    }
    await expect(syncRepoIssues(INPUT, deps(client))).rejects.toThrow(/Bad credentials/)
  })
})

describe("syncWorkspaceRepos", () => {
  const BINDINGS = [
    { repoFullName: "o/a", issueProjectId: "p1" },
    { repoFullName: "o/b", issueProjectId: "p2" },
  ]

  it("syncs every bound repo", async () => {
    const { client } = octokit([{ data: [rawIssue(1)] }])
    const result = await syncWorkspaceRepos({ bindings: BINDINGS }, deps(client))
    expect(result.results.map((r) => r.repoFullName)).toEqual(["o/a", "o/b"])
    expect(result.failures).toEqual([])
  })

  it("keeps going when one repo fails, and names the one that did", async () => {
    // A single revoked installation must not leave the whole board stale.
    let call = 0
    const client: OctokitLike = {
      async request() {
        call += 1
        if (call === 1) throw Object.assign(new Error("Not found"), { status: 500 })
        return { status: 200, headers: {}, data: [] }
      },
    }
    const result = await syncWorkspaceRepos({ bindings: BINDINGS }, deps(client))
    expect(result.failures.map((f) => f.repoFullName)).toEqual(["o/a"])
    expect(result.results.map((r) => r.repoFullName)).toEqual(["o/b"])
  })

  it("does nothing when no repo is bound", async () => {
    const { client } = octokit([{ data: [] }])
    expect(await syncWorkspaceRepos({ bindings: [] }, deps(client))).toEqual({
      results: [],
      failures: [],
    })
  })

  it("propagates the full flag to every repo", async () => {
    const { client, calls } = octokit([{ data: [] }])
    await syncWorkspaceRepos(
      { bindings: BINDINGS, full: true },
      { ...deps(client), latestMirroredUpdate: async () => 999 }
    )
    expect(calls.every((call) => !("since" in call))).toBe(true)
  })
})
