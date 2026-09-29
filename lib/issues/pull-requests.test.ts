import type { Issue, IssueExternalRef } from "@/types/issues"
import {
  fetchPullRequestCi,
  hasMergedPullRequest,
  hasSettledPullRequestChecks,
  linkRunPullRequests,
  linkedPullRequests,
  parsePullRequestUrl,
  pullRequestExternalId,
  pullRequestStateOf,
  type LinkRunPullRequestsDeps,
} from "./pull-requests"

describe("parsePullRequestUrl", () => {
  it("reads a pull request URL on any host", () => {
    expect(parsePullRequestUrl("https://github.com/acme/app/pull/42")).toEqual({
      repoFullName: "acme/app",
      number: 42,
      url: "https://github.com/acme/app/pull/42",
    })
    expect(parsePullRequestUrl("https://ghe.example.com/acme/app/pull/7/?x=1")).toMatchObject({
      repoFullName: "acme/app",
      number: 7,
      url: "https://ghe.example.com/acme/app/pull/7/",
    })
  })

  it("refuses everything that is not one", () => {
    for (const href of [
      "/?session=s1",
      "/squads?id=t",
      "https://github.com/acme/app/issues/4",
      "https://github.com/acme/app/pull/new/branch",
      "http://github.com/acme/app/pull/4",
      "https://github.com/acme/app/pull/0",
      "not a url",
    ]) {
      expect(parsePullRequestUrl(href)).toBeUndefined()
    }
  })
})

it("maps GitHub's pull shape to a state, merged first", () => {
  expect(pullRequestStateOf({ state: "closed", merged_at: "2026-01-01T00:00:00Z" })).toBe("merged")
  expect(pullRequestStateOf({ state: "closed", merged: true })).toBe("merged")
  expect(pullRequestStateOf({ state: "closed", merged_at: null })).toBe("closed")
  expect(pullRequestStateOf({ state: "open" })).toBe("open")
  expect(pullRequestStateOf({})).toBeUndefined()
})

const pr = (externalId: string, prState?: string): IssueExternalRef => ({
  provider: "github-pr",
  externalId,
  url: `https://github.com/${externalId.replace("#", "/pull/")}`,
  ...(prState ? { meta: { prState } } : {}),
})

it("lists linked pull requests with the state last seen, and knows when one merged", () => {
  const issue = {
    externalRefs: [
      pr("a/b#1", "open"),
      pr("a/b#2", "bogus"),
      { provider: "github", externalId: "a/b#9" },
    ],
  }
  expect(linkedPullRequests(issue)).toEqual([
    { externalId: "a/b#1", url: "https://github.com/a/b/pull/1", state: "open" },
    { externalId: "a/b#2", url: "https://github.com/a/b/pull/2" },
  ])
  expect(hasMergedPullRequest(issue)).toBe(false)
  expect(hasMergedPullRequest({ externalRefs: [pr("a/b#1", "merged")] })).toBe(true)
  expect(pullRequestExternalId("a/b", 3)).toBe("a/b#3")
})

describe("linkRunPullRequests", () => {
  function deps(refs: IssueExternalRef[]): LinkRunPullRequestsDeps & { linked: unknown[] } {
    const linked: unknown[] = []
    return {
      linked,
      getIssue: async () => ({ id: "i1", externalRefs: refs }) as Issue,
      link: async (id, ref, by) => void linked.push({ id, ref, by }),
    }
  }
  const BY = { kind: "agent" as const, id: "t" }

  it("links the pull requests among the artifacts once, and leaves known refs alone", async () => {
    const harness = deps([pr("acme/app#1", "open")])
    const out = await linkRunPullRequests(
      "i1",
      [
        { label: "Session", href: "/?session=s1" },
        { label: "Pull request #1", href: "https://github.com/acme/app/pull/1" },
        { label: "Pull request #2", href: "https://github.com/acme/app/pull/2" },
        { label: "Again", href: "https://github.com/acme/app/pull/2" },
      ],
      BY,
      harness
    )
    expect(out).toEqual(["acme/app#2"])
    expect(harness.linked).toEqual([
      {
        id: "i1",
        ref: {
          provider: "github-pr",
          externalId: "acme/app#2",
          url: "https://github.com/acme/app/pull/2",
          label: "Pull request #2",
        },
        by: BY,
      },
    ])
  })

  it("does nothing without pull requests or without the issue", async () => {
    const harness = deps([])
    expect(await linkRunPullRequests("i1", [{ label: "x", href: "/x" }], BY, harness)).toEqual([])
    const gone = { ...harness, getIssue: async () => undefined }
    expect(
      await linkRunPullRequests(
        "i1",
        [{ label: "p", href: "https://github.com/a/b/pull/1" }],
        BY,
        gone
      )
    ).toEqual([])
    expect(harness.linked).toEqual([])
  })
})

describe("hasSettledPullRequestChecks", () => {
  const issue = (meta: Record<string, string>) => ({
    externalRefs: [{ provider: "github-pr", externalId: "a/b#1", meta }] as IssueExternalRef[],
  })

  it("answers for an open pull request whose CI finished, by result when asked", () => {
    expect(hasSettledPullRequestChecks(issue({ prState: "open", ciState: "passing" }))).toBe(true)
    expect(hasSettledPullRequestChecks(issue({ prState: "open", ciState: "failing" }))).toBe(true)
    expect(hasSettledPullRequestChecks(issue({ prState: "open", ciState: "pending" }))).toBe(false)
    expect(
      hasSettledPullRequestChecks(issue({ prState: "open", ciState: "failing" }), "passing")
    ).toBe(false)
  })

  it("ignores the last CI of a merged or closed pull request", () => {
    expect(hasSettledPullRequestChecks(issue({ prState: "merged", ciState: "passing" }))).toBe(
      false
    )
    expect(linkedPullRequests(issue({ ciState: "bogus" }))[0]).not.toHaveProperty("ci")
  })
})

describe("fetchPullRequestCi", () => {
  function octokit(checkRuns: unknown[][], status: unknown, total?: number) {
    const calls: Array<[string, Record<string, unknown> | undefined]> = []
    return {
      calls,
      request: async (route: string, params?: Record<string, unknown>) => {
        calls.push([route, params])
        if (route.endsWith("/check-runs")) {
          const page = Number(params?.page ?? 1)
          const runs = checkRuns[page - 1] ?? []
          return {
            status: 200,
            headers: {},
            data: {
              total_count: total ?? checkRuns.reduce((n, p) => n + p.length, 0),
              check_runs: runs,
            },
          }
        }
        return { status: 200, headers: {}, data: status }
      },
    }
  }
  const done = (conclusion: string) => ({ name: "ci", status: "completed", conclusion })

  it("rolls check runs and commit statuses into passing, failing or pending", async () => {
    await expect(
      fetchPullRequestCi(octokit([[done("success")]], { statuses: [] }), "a", "b", "sha")
    ).resolves.toBe("passing")
    await expect(
      fetchPullRequestCi(
        octokit([[done("success")]], { statuses: [{ context: "lint", state: "failure" }] }),
        "a",
        "b",
        "sha"
      )
    ).resolves.toBe("failing")
    await expect(
      fetchPullRequestCi(
        octokit([[{ name: "ci", status: "in_progress" }]], { statuses: [] }),
        "a",
        "b",
        "sha"
      )
    ).resolves.toBe("pending")
  })

  it("gives no state to a commit with no checks", async () => {
    await expect(
      fetchPullRequestCi(octokit([[]], { statuses: [] }), "a", "b", "sha")
    ).resolves.toBeUndefined()
  })

  it("pages check runs, and calls an unfinished read pending rather than passing", async () => {
    const page = Array.from({ length: 100 }, () => done("success"))
    const three = octokit([page, page, page], { statuses: [] }, 400)
    await expect(fetchPullRequestCi(three, "a", "b", "sha")).resolves.toBe("pending")
    expect(three.calls.filter(([route]) => route.endsWith("/check-runs"))).toHaveLength(3)
    const two = octokit([page, [done("success")]], { statuses: [] })
    await expect(fetchPullRequestCi(two, "a", "b", "sha")).resolves.toBe("passing")
    expect(two.calls.filter(([route]) => route.endsWith("/check-runs"))).toHaveLength(2)
  })
})
