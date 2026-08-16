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
): SyncRepoIssuesDeps & { written: GithubIssueMirrorRow[][] } {
  const written: GithubIssueMirrorRow[][] = []
  return {
    written,
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

  it("sends the stored watermark and ETag on a routine sync", async () => {
    const { client, calls } = octokit([{ data: [] }])
    await syncRepoIssues(INPUT, {
      ...deps(client),
      latestMirroredUpdate: async () => Date.parse("2026-01-05T00:00:00Z"),
      repoMirrorEtag: async () => 'W/"abc"',
    })
    expect(calls[0]).toMatchObject({ since: "2026-01-05T00:00:00.000Z" })
    expect(calls[0].headers).toMatchObject({ "if-none-match": 'W/"abc"' })
  })

  it("writes nothing on a 304 and says the cache is current", async () => {
    const { client } = octokit([{ status: 304, headers: { etag: 'W/"abc"' } }])
    const d = deps(client, { repoMirrorEtag: async () => 'W/"abc"' })
    const result = await syncRepoIssues(INPUT, d)

    expect(result).toMatchObject({ notModified: true, written: 0 })
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

  it("reports truncation rather than pretending the repo was fully read", async () => {
    const { client } = octokit([{ data: [rawIssue(1)], headers: { link: '<x>; rel="next"' } }])
    expect((await syncRepoIssues(INPUT, deps(client))).truncated).toBe(true)
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
