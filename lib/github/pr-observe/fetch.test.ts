import {
  deriveReviewDecision,
  extractJobId,
  fetchPrObservation,
  groupReviewThreads,
  mapMergeability,
  summarizeCi,
} from "./fetch"
import type { OctokitLike, PrObservation } from "./types"

// ── route-dispatching mock octokit ───────────────────────────────────────────

type RouteResult = { status?: number; headers?: Record<string, string | undefined>; data?: unknown }
type RouteHandler = RouteResult | ((params: Record<string, unknown>) => RouteResult | Error)

function makeOctokit(routes: Record<string, RouteHandler>): OctokitLike & { request: jest.Mock } {
  const request = jest.fn(async (route: string, params: Record<string, unknown> = {}) => {
    const h = routes[route]
    if (h === undefined) throw { status: 404 }
    const res = typeof h === "function" ? h(params) : h
    if (res instanceof Error) throw res
    return { status: res.status ?? 200, headers: res.headers ?? {}, data: res.data }
  })
  return { request } as OctokitLike & { request: jest.Mock }
}

// ── pure helpers ──────────────────────────────────────────────────────────────

describe("extractJobId", () => {
  it("parses a job id from a details url", () => {
    expect(extractJobId("https://github.com/a/b/actions/runs/1/job/42")).toBe(42)
  })
  it("returns null when absent", () => {
    expect(extractJobId("https://github.com/a/b/checks")).toBeNull()
    expect(extractJobId(undefined)).toBeNull()
  })
})

describe("mapMergeability", () => {
  it("dirty state is a conflict", () => {
    expect(mapMergeability(false, "dirty")).toMatchObject({ state: "conflicting", conflict: true })
  })
  it("mergeable=false is a conflict even without dirty state", () => {
    expect(mapMergeability(false, undefined)).toMatchObject({
      state: "conflicting",
      conflict: true,
    })
  })
  it("behind state", () => {
    expect(mapMergeability(false, "behind")).toMatchObject({ state: "behind", behindBase: true })
  })
  it("blocked state", () => {
    expect(mapMergeability(true, "blocked")).toMatchObject({ state: "blocked", mergeable: true })
  })
  it("clean / unstable / has_hooks are mergeable", () => {
    for (const s of ["clean", "unstable", "has_hooks"]) {
      expect(mapMergeability(true, s)).toMatchObject({ state: "mergeable", mergeable: true })
    }
  })
  it("mergeable=true with unknown state is mergeable", () => {
    expect(mapMergeability(true, undefined)).toMatchObject({ state: "mergeable", mergeable: true })
  })
  it("blocked with mergeable=false stays blocked, not mergeable", () => {
    expect(mapMergeability(false, "blocked")).toMatchObject({ state: "blocked", mergeable: false })
  })
  it("null mergeable is unknown", () => {
    expect(mapMergeability(null, undefined)).toMatchObject({ state: "unknown" })
  })
})

describe("summarizeCi", () => {
  it("is failing when a check-run concluded failure", () => {
    const ci = summarizeCi(
      "sha1",
      [
        {
          name: "build",
          status: "completed",
          conclusion: "failure",
          details_url: "u/job/9",
          id: 9,
        },
      ],
      null
    )
    expect(ci.summary).toBe("failing")
    expect(ci.failedChecks).toHaveLength(1)
    expect(ci.failedChecks[0]).toMatchObject({ name: "build", commitHash: "sha1", providerId: "9" })
  })
  it("is pending when a check-run is in progress", () => {
    expect(summarizeCi("s", [{ name: "t", status: "in_progress" }], null).summary).toBe("pending")
  })
  it("is passing when all checks succeed", () => {
    expect(
      summarizeCi("s", [{ name: "t", status: "completed", conclusion: "success" }], null).summary
    ).toBe("passing")
  })
  it("is unknown when there are no checks", () => {
    expect(summarizeCi("s", [], null).summary).toBe("unknown")
  })
  it("treats action_required as failing but neutral/skipped as non-failing", () => {
    expect(
      summarizeCi("s", [{ name: "a", status: "completed", conclusion: "action_required" }], null)
        .summary
    ).toBe("failing")
    expect(
      summarizeCi("s", [{ name: "b", status: "completed", conclusion: "skipped" }], null).summary
    ).toBe("passing")
  })
  it("combined status error also counts as failing", () => {
    const ci = summarizeCi("s", [], {
      state: "failure",
      statuses: [{ context: "c", state: "error" }],
    })
    expect(ci.failedChecks).toHaveLength(1)
  })
  it("folds legacy combined-status failures into failing", () => {
    const ci = summarizeCi("s", [], {
      state: "failure",
      statuses: [{ context: "ci/legacy", state: "failure" }],
    })
    expect(ci.summary).toBe("failing")
    expect(ci.failedChecks[0].name).toBe("ci/legacy")
  })
  it("combined status pending yields pending", () => {
    expect(
      summarizeCi("s", [], { state: "pending", statuses: [{ context: "x", state: "pending" }] })
        .summary
    ).toBe("pending")
  })
})

describe("deriveReviewDecision", () => {
  it("changes_requested wins over approval", () => {
    expect(
      deriveReviewDecision([
        { state: "APPROVED", user: { login: "a" } },
        { state: "CHANGES_REQUESTED", user: { login: "b" } },
      ])
    ).toBe("changes_requested")
  })
  it("approved when only approvals", () => {
    expect(deriveReviewDecision([{ state: "APPROVED", user: { login: "a" } }])).toBe("approved")
  })
  it("uses the latest review per author (approval supersedes earlier change request)", () => {
    expect(
      deriveReviewDecision([
        { state: "CHANGES_REQUESTED", user: { login: "a" } },
        { state: "APPROVED", user: { login: "a" } },
      ])
    ).toBe("approved")
  })
  it("ignores bots, COMMENTED, and DISMISSED", () => {
    expect(
      deriveReviewDecision([
        { state: "CHANGES_REQUESTED", user: { login: "bot", type: "Bot" } },
        { state: "COMMENTED", user: { login: "a" } },
        { state: "DISMISSED", user: { login: "b" } },
      ])
    ).toBe("none")
  })
})

describe("groupReviewThreads", () => {
  it("groups replies under their root and flags bot-only threads", () => {
    const threads = groupReviewThreads([
      { id: 1, path: "a.ts", line: 3, body: "root", user: { login: "human" } },
      { id: 2, in_reply_to_id: 1, body: "reply", user: { login: "human" } },
      { id: 5, path: "b.ts", original_line: 9, body: "bot note", user: { login: "cov[bot]" } },
    ])
    expect(threads).toHaveLength(2)
    expect(threads[0]).toMatchObject({
      id: "1",
      path: "a.ts",
      line: 3,
      isBot: false,
      resolved: false,
    })
    expect(threads[0].comments).toHaveLength(2)
    expect(threads[1]).toMatchObject({ id: "5", path: "b.ts", line: 9, isBot: true })
  })

  it("treats a reply to a missing root as its own thread and survives a reply cycle", () => {
    const threads = groupReviewThreads([
      { id: 10, in_reply_to_id: 999, body: "orphan", user: { login: "h" } },
      { id: 20, in_reply_to_id: 21, body: "cyclic-a", user: { login: "h" } },
      { id: 21, in_reply_to_id: 20, body: "cyclic-b", user: { login: "h" } },
    ])
    // Orphan is its own root; the cycle resolves without hanging.
    expect(threads.map((t) => t.id)).toContain("10")
    expect(threads.length).toBeGreaterThanOrEqual(2)
  })

  it("skips comments without an id", () => {
    expect(groupReviewThreads([{ body: "no id", user: { login: "h" } }])).toHaveLength(0)
  })
})

describe("defensive defaults on sparse payloads", () => {
  it("summarizeCi tolerates missing check/status fields", () => {
    const ci = summarizeCi(
      "s",
      [{}], // no name/status/conclusion/id
      { statuses: [{}] } // no state/context, no top-level state
    )
    expect(ci.summary).toBe("passing") // an unnamed completed check with no failing conclusion
    // a status with no state is not failing
    expect(ci.failedChecks).toHaveLength(0)
  })

  it("summarizeCi is unknown for a combined status with no individual statuses", () => {
    // A bare combined state with no check-runs and no status contexts means no
    // CI is configured — unknown, not passing.
    expect(summarizeCi("s", [], { state: "success" }).summary).toBe("unknown")
  })

  it("deriveReviewDecision tolerates a review with no state or user", () => {
    expect(deriveReviewDecision([{}])).toBe("none")
  })

  it("groupReviewThreads tolerates a comment with no path/line/body/user", () => {
    const threads = groupReviewThreads([{ id: 1 }])
    expect(threads[0]).toMatchObject({ path: "", line: 0, isBot: false })
    expect(threads[0].comments[0]).toMatchObject({ author: "", body: "" })
  })
})

// ── orchestration ─────────────────────────────────────────────────────────────

function openPrRoutes(
  over: Partial<Record<string, RouteHandler>> = {}
): Record<string, RouteHandler> {
  return {
    "GET /repos/{owner}/{repo}/pulls/{pull_number}": {
      status: 200,
      headers: { etag: "pr-etag" },
      data: {
        number: 12,
        state: "open",
        draft: false,
        merged: false,
        mergeable: true,
        mergeable_state: "unstable",
        title: "Add feature",
        additions: 10,
        deletions: 2,
        html_url: "https://gh/acme/app/pull/12",
        user: { login: "dev" },
        head: { sha: "deadbeef", ref: "agent/run1/dev/task1" },
        base: { ref: "main" },
      },
    },
    "GET /repos/{owner}/{repo}/commits/{ref}/check-runs": {
      status: 200,
      headers: { etag: "checks-etag" },
      data: {
        check_runs: [
          {
            name: "build",
            status: "completed",
            conclusion: "failure",
            details_url: "u/job/77",
            id: 77,
          },
        ],
      },
    },
    "GET /repos/{owner}/{repo}/commits/{ref}/status": {
      status: 200,
      data: { state: "failure", statuses: [] },
    },
    "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews": {
      status: 200,
      headers: { etag: "rev-etag" },
      data: [{ state: "CHANGES_REQUESTED", user: { login: "reviewer" } }],
    },
    "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments": {
      status: 200,
      headers: { etag: "com-etag" },
      data: [{ id: 1, path: "x.ts", line: 5, body: "fix this", user: { login: "reviewer" } }],
    },
    "GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs": {
      status: 200,
      data: Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"),
    },
    ...over,
  }
}

describe("fetchPrObservation", () => {
  it("fetches a full observation by PR number (failing CI + changes requested + log tail)", async () => {
    const o = makeOctokit(openPrRoutes())
    const obs = await fetchPrObservation(o, "acme/app", { number: 12 }, undefined, 1000)
    expect(obs.fetched).toBe(true)
    expect(obs.pr).toMatchObject({
      number: 12,
      state: "open",
      sourceBranch: "agent/run1/dev/task1",
      targetBranch: "main",
    })
    expect(obs.ci.summary).toBe("failing")
    expect(obs.ci.failedChecks[0].logTail).toBe(
      Array.from({ length: 20 }, (_, i) => `line ${i + 10}`).join("\n")
    )
    expect(obs.review.decision).toBe("changes_requested")
    expect(obs.review.threads).toHaveLength(1)
    expect(obs.mergeability.state).toBe("mergeable")
    expect(obs.changed).toEqual({ metadata: true, ci: true, review: true })
    expect(obs.etags).toMatchObject({
      pr: "pr-etag",
      checks: "checks-etag",
      reviews: "rev-etag",
      comments: "com-etag",
    })
  })

  it("discovers the PR by branch when given a branch ref", async () => {
    const o = makeOctokit({
      "GET /repos/{owner}/{repo}/pulls": {
        status: 200,
        data: [{ number: 12, html_url: "https://gh/acme/app/pull/12" }],
      },
      ...openPrRoutes(),
    })
    const obs = await fetchPrObservation(
      o,
      "acme/app",
      { branch: "agent/run1/dev/task1" },
      undefined,
      1
    )
    expect(obs.fetched).toBe(true)
    expect(obs.pr.number).toBe(12)
  })

  it("returns unfetched when no open PR is found for the branch", async () => {
    const o = makeOctokit({ "GET /repos/{owner}/{repo}/pulls": { status: 200, data: [] } })
    const obs = await fetchPrObservation(o, "acme/app", { branch: "nope" }, undefined, 5)
    expect(obs.fetched).toBe(false)
    expect(obs.repo).toBe("acme/app")
  })

  it("returns unfetched when the PR detail 404s", async () => {
    const o = makeOctokit({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": { status: 404 },
    })
    const obs = await fetchPrObservation(o, "acme/app", { number: 99 }, undefined, 5)
    expect(obs.fetched).toBe(false)
  })

  it("skips CI/review work for a merged PR and marks metadata changed", async () => {
    const o = makeOctokit({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": {
        status: 200,
        data: {
          number: 12,
          state: "closed",
          merged: true,
          merged_at: "2026-01-01",
          head: { sha: "s" },
          base: { ref: "main" },
        },
      },
    })
    const obs = await fetchPrObservation(o, "acme/app", { number: 12 }, undefined, 9)
    expect(obs.pr.merged).toBe(true)
    expect(obs.changed).toEqual({ metadata: true, ci: false, review: false })
    // Only the PR detail endpoint is hit for a merged PR.
    expect(o.request).toHaveBeenCalledTimes(1)
  })

  it("reuses prior buckets on 304 and reports no change", async () => {
    const prev: PrObservation = {
      fetched: true,
      observedAt: 1,
      repo: "acme/app",
      pr: {
        url: "https://gh/acme/app/pull/12",
        number: 12,
        state: "open",
        draft: false,
        merged: false,
        closed: false,
        sourceBranch: "agent/run1/dev/task1",
        targetBranch: "main",
        headSha: "deadbeef",
        title: "Add feature",
        additions: 10,
        deletions: 2,
        author: "dev",
      },
      ci: {
        summary: "failing",
        headSha: "deadbeef",
        failedChecks: [
          { name: "build", status: "completed", conclusion: "failure", commitHash: "deadbeef" },
        ],
      },
      review: {
        decision: "changes_requested",
        threads: [
          {
            id: "1",
            path: "x.ts",
            line: 5,
            resolved: false,
            isBot: false,
            comments: [{ id: "1", author: "reviewer", body: "fix this", isBot: false }],
          },
        ],
      },
      mergeability: { state: "mergeable", mergeable: true, conflict: false, behindBase: false },
      changed: { metadata: true, ci: true, review: true },
      etags: { pr: "pr-etag", checks: "checks-etag", reviews: "rev-etag", comments: "com-etag" },
    }
    const notModified: RouteHandler = { status: 304 }
    const o = makeOctokit({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": notModified,
      "GET /repos/{owner}/{repo}/commits/{ref}/check-runs": notModified,
      "GET /repos/{owner}/{repo}/commits/{ref}/status": notModified,
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews": notModified,
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments": notModified,
    })
    const obs = await fetchPrObservation(o, "acme/app", { number: 12 }, prev, 2000)
    expect(obs.ci).toEqual(prev.ci)
    expect(obs.review).toEqual(prev.review)
    expect(obs.pr).toEqual(prev.pr)
    expect(obs.changed).toEqual({ metadata: false, ci: false, review: false })
    // Conditional requests carried the prior ETags.
    expect(o.request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      expect.objectContaining({ headers: { "if-none-match": "pr-etag" } })
    )
  })

  it("normalizes a passing + approved + clean PR with sparse fields", async () => {
    const o = makeOctokit({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": {
        status: 200,
        data: {
          number: 3,
          state: "open",
          mergeable: true,
          mergeable_state: "clean",
          head: { sha: "s" },
        },
      },
      "GET /repos/{owner}/{repo}/commits/{ref}/check-runs": {
        status: 200,
        data: { check_runs: [{ name: "test", status: "completed", conclusion: "success" }] },
      },
      "GET /repos/{owner}/{repo}/commits/{ref}/status": {
        status: 200,
        data: { state: "success", statuses: [] },
      },
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews": {
        status: 200,
        data: [{ state: "APPROVED", user: { login: "rev" } }],
      },
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments": { status: 200, data: [] },
    })
    const obs = await fetchPrObservation(
      o,
      "acme/app",
      { number: 3, url: "https://gh/pull/3" },
      undefined,
      1
    )
    expect(obs.pr).toMatchObject({
      url: "https://gh/pull/3",
      author: "",
      sourceBranch: "",
      additions: 0,
    })
    expect(obs.ci.summary).toBe("passing")
    expect(obs.review.decision).toBe("approved")
    expect(obs.mergeability.state).toBe("mergeable")
  })

  it("handles a mixed 304 (reviews unchanged, comments refetched)", async () => {
    const prev: PrObservation = {
      fetched: true,
      observedAt: 1,
      repo: "acme/app",
      pr: {
        url: "u",
        number: 12,
        state: "open",
        draft: false,
        merged: false,
        closed: false,
        sourceBranch: "b",
        targetBranch: "main",
        headSha: "s",
        title: "t",
        additions: 0,
        deletions: 0,
        author: "d",
      },
      ci: { summary: "passing", headSha: "s", failedChecks: [] },
      review: { decision: "approved", threads: [] },
      mergeability: { state: "mergeable", mergeable: true, conflict: false, behindBase: false },
      changed: { metadata: false, ci: false, review: false },
      etags: { reviews: "rev-etag", comments: "com-etag" },
    }
    const o = makeOctokit({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": {
        status: 200,
        data: {
          number: 12,
          state: "open",
          mergeable: true,
          mergeable_state: "clean",
          head: { sha: "s" },
          base: { ref: "main" },
        },
      },
      "GET /repos/{owner}/{repo}/commits/{ref}/check-runs": {
        status: 200,
        data: { check_runs: [] },
      },
      "GET /repos/{owner}/{repo}/commits/{ref}/status": {
        status: 200,
        data: { state: "success", statuses: [] },
      },
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews": { status: 304 },
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments": {
        status: 200,
        data: [{ id: 7, path: "z.ts", line: 1, body: "please change", user: { login: "human" } }],
      },
    })
    const obs = await fetchPrObservation(o, "acme/app", { number: 12 }, prev, 2)
    // decision carried from prev (reviews 304), threads refetched (comments 200).
    expect(obs.review.decision).toBe("approved")
    expect(obs.review.threads).toHaveLength(1)
    expect(obs.changed.review).toBe(true)
  })

  it("bounds log fetches, skips checks without a job url, and tolerates empty logs", async () => {
    const failing = Array.from({ length: 7 }, (_, i) => ({
      name: `check-${i}`,
      status: "completed",
      conclusion: "failure",
      // even checks have a job url; odd ones do not (jobId null → skipped).
      details_url: i % 2 === 0 ? `https://gh/actions/runs/1/job/${100 + i}` : undefined,
      id: 100 + i,
    }))
    const o = makeOctokit({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": {
        status: 200,
        data: {
          number: 1,
          state: "open",
          mergeable: true,
          mergeable_state: "unstable",
          head: { sha: "s" },
        },
      },
      "GET /repos/{owner}/{repo}/commits/{ref}/check-runs": {
        status: 200,
        data: { check_runs: failing },
      },
      "GET /repos/{owner}/{repo}/commits/{ref}/status": {
        status: 200,
        data: { state: "success", statuses: [] },
      },
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews": { status: 200, data: [] },
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments": { status: 200, data: [] },
      "GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs": { status: 200, data: "" },
    })
    const obs = await fetchPrObservation(o, "acme/app", { number: 1 }, undefined, 1)
    expect(obs.ci.summary).toBe("failing")
    const logCalls = o.request.mock.calls.filter(
      (c) => c[0] === "GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs"
    )
    // 4 even-indexed checks have urls (0,2,4,6) but the per-poll cap is 5, so all 4 fetch.
    expect(logCalls.length).toBe(4)
    expect(obs.ci.failedChecks.every((c) => c.logTail === "" || c.logTail === undefined)).toBe(true)
  })

  it("reuses prev CI/review facts for a merged PR when prev exists", async () => {
    const prev = (await fetchPrObservation(
      makeOctokit(openPrRoutes()),
      "acme/app",
      { number: 12 },
      undefined,
      1
    )) as PrObservation
    const o = makeOctokit({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": {
        status: 200,
        data: {
          number: 12,
          state: "closed",
          merged: true,
          head: { sha: "deadbeef" },
          base: { ref: "main" },
        },
      },
    })
    const obs = await fetchPrObservation(o, "acme/app", { number: 12 }, prev, 3)
    expect(obs.pr.merged).toBe(true)
    expect(obs.ci).toEqual(prev.ci)
    expect(obs.review).toEqual(prev.review)
  })
})
