import { publishTeammatePr, type PublishGitOps, type PublishPrArgs } from "./publish"
import type { OctokitLike } from "@/lib/github/pr-observe/types"

type Handler = { status?: number; data?: unknown } | ((p: Record<string, unknown>) => unknown)

function makeOctokit(routes: Record<string, Handler>): OctokitLike & { request: jest.Mock } {
  const request = jest.fn(async (route: string, params: Record<string, unknown> = {}) => {
    const h = routes[route]
    if (h === undefined) throw { status: 404 }
    const res = typeof h === "function" ? h(params) : h
    if (res instanceof Error) throw res
    return {
      status: (res as { status?: number }).status ?? 200,
      headers: {},
      data: (res as { data?: unknown }).data,
    }
  })
  return { request } as OctokitLike & { request: jest.Mock }
}

function gitOps(): PublishGitOps & { push: jest.Mock } {
  return { push: jest.fn(async () => {}) } as PublishGitOps & { push: jest.Mock }
}

const args: PublishPrArgs = {
  repo: "acme/app",
  branch: "agent/run-1/m1/t1",
  baseBranch: "main",
  worktreePath: "/wt",
  title: "Add feature",
  body: "does things",
}

describe("publishTeammatePr", () => {
  it("returns the existing PR without pushing or creating", async () => {
    const o = makeOctokit({
      "GET /repos/{owner}/{repo}/pulls": {
        status: 200,
        data: [{ number: 8, html_url: "https://gh/pull/8" }],
      },
    })
    const git = gitOps()
    const r = await publishTeammatePr(o, git, args)
    expect(r).toEqual({ number: 8, url: "https://gh/pull/8", created: false })
    expect(git.push).not.toHaveBeenCalled()
  })

  it("pushes the branch and opens a PR when none exists", async () => {
    const o = makeOctokit({
      "GET /repos/{owner}/{repo}/pulls": { status: 200, data: [] },
      "POST /repos/{owner}/{repo}/pulls": {
        status: 201,
        data: { number: 12, html_url: "https://gh/pull/12" },
      },
    })
    const git = gitOps()
    const r = await publishTeammatePr(o, git, args)
    expect(git.push).toHaveBeenCalledWith("/wt", "agent/run-1/m1/t1")
    expect(o.request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/pulls",
      expect.objectContaining({
        owner: "acme",
        repo: "app",
        head: "agent/run-1/m1/t1",
        base: "main",
        title: "Add feature",
      })
    )
    expect(r).toEqual({ number: 12, url: "https://gh/pull/12", created: true })
  })

  it("defaults body/draft and tolerates a missing html_url", async () => {
    const o = makeOctokit({
      "GET /repos/{owner}/{repo}/pulls": { status: 200, data: [] },
      "POST /repos/{owner}/{repo}/pulls": { status: 201, data: { number: 20 } },
    })
    const r = await publishTeammatePr(o, gitOps(), {
      repo: "acme/app",
      branch: "b",
      baseBranch: "main",
      worktreePath: "/wt",
      title: "T",
    })
    expect(o.request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/pulls",
      expect.objectContaining({ body: "", draft: false })
    )
    expect(r).toEqual({ number: 20, url: "", created: true })
  })

  it("returns null when the create response has no PR number", async () => {
    const o = makeOctokit({
      "GET /repos/{owner}/{repo}/pulls": { status: 200, data: [] },
      "POST /repos/{owner}/{repo}/pulls": { status: 201, data: {} },
    })
    expect(await publishTeammatePr(o, gitOps(), args)).toBeNull()
  })

  it("rediscovers on a 422 create race", async () => {
    let getCalls = 0
    const o = makeOctokit({
      "GET /repos/{owner}/{repo}/pulls": () => {
        getCalls += 1
        // first discover: none; after the race, the PR exists.
        return {
          status: 200,
          data: getCalls === 1 ? [] : [{ number: 15, html_url: "https://gh/pull/15" }],
        }
      },
      "POST /repos/{owner}/{repo}/pulls": () => {
        throw { status: 422 }
      },
    })
    const r = await publishTeammatePr(o, gitOps(), args)
    expect(r).toEqual({ number: 15, url: "https://gh/pull/15", created: false })
  })

  it("rethrows a 422 when rediscovery still finds nothing", async () => {
    const o = makeOctokit({
      "GET /repos/{owner}/{repo}/pulls": { status: 200, data: [] },
      "POST /repos/{owner}/{repo}/pulls": () => {
        throw { status: 422 }
      },
    })
    await expect(publishTeammatePr(o, gitOps(), args)).rejects.toEqual({ status: 422 })
  })

  it("rethrows a non-422 create error", async () => {
    const o = makeOctokit({
      "GET /repos/{owner}/{repo}/pulls": { status: 200, data: [] },
      "POST /repos/{owner}/{repo}/pulls": () => {
        throw { status: 500 }
      },
    })
    await expect(publishTeammatePr(o, gitOps(), args)).rejects.toEqual({ status: 500 })
  })
})
