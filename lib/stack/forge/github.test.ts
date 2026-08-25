import type { OctokitLike } from "@/lib/github/pr-observe/types"

import { ciStateFrom, createGithubStackAdapter, reviewStateFrom } from "./github"
import { publishStack } from "../publish"
import type { Stack } from "../model"

interface Call {
  route: string
  params: Record<string, unknown>
}

function octokit(
  handler: (route: string, params: Record<string, unknown>) => { status: number; data?: unknown }
): OctokitLike & { calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    async request(route: string, params: Record<string, unknown> = {}) {
      calls.push({ route, params })
      const result = handler(route, params)
      if (result.status >= 400) {
        throw Object.assign(new Error(`HTTP ${result.status}`), { status: result.status })
      }
      return { status: result.status, headers: {}, data: result.data ?? {} }
    },
  } as never
}

const REPO_OK = { status: 200, data: { permissions: { push: true } } }

describe("ciStateFrom", () => {
  it("keeps 'no checks configured' apart from 'could not read them'", () => {
    // `fetchPrObservation` reports summary "unknown" for BOTH, on different
    // fields. They are opposite answers for a merge gate.
    expect(ciStateFrom(true, "unknown")).toBe("none")
    expect(ciStateFrom(false, "unknown")).toBe("unknown")
    expect(ciStateFrom(true, "passing")).toBe("passing")
    expect(ciStateFrom(true, "failing")).toBe("failing")
    expect(ciStateFrom(true, "pending")).toBe("pending")
  })
})

describe("reviewStateFrom", () => {
  it("maps GitHub's decision, and treats an unread one as requiring review", () => {
    expect(reviewStateFrom(true, "approved")).toBe("approved")
    expect(reviewStateFrom(true, "changes_requested")).toBe("changesRequested")
    expect(reviewStateFrom(true, "review_required")).toBe("reviewRequired")
    expect(reviewStateFrom(true, "none")).toBe("none")
    expect(reviewStateFrom(false, "approved")).toBe("reviewRequired")
  })
})

describe("createGithubStackAdapter", () => {
  it("probes for native stacks rather than assuming the endpoint exists", async () => {
    // Stacks are new and absent on Enterprise Server until it ships there.
    const missing = octokit((route) =>
      route === "GET /repos/{owner}/{repo}" ? REPO_OK : { status: 404 }
    )
    const withStacks = octokit((route) =>
      route === "GET /repos/{owner}/{repo}" ? REPO_OK : { status: 200, data: [] }
    )
    expect(
      (await createGithubStackAdapter({ octokit: missing }).capabilities("octo/app")).nativeStacks
    ).toBe(false)
    expect(
      (await createGithubStackAdapter({ octokit: withStacks }).capabilities("octo/app"))
        .nativeStacks
    ).toBe(true)
  })

  it("reports fork-only when the token cannot push to the target", async () => {
    const api = octokit((route) =>
      route === "GET /repos/{owner}/{repo}"
        ? { status: 200, data: { permissions: { push: false } } }
        : { status: 404 }
    )
    const capabilities = await createGithubStackAdapter({ octokit: api }).capabilities("octo/app")
    expect(capabilities.canPushToTarget).toBe(false)
  })

  it("treats an absent merge-method flag as allowed, not as forbidden", async () => {
    // The field is missing for tokens without admin scope; reading that as
    // "this repository allows no merges" would refuse every stack.
    const api = octokit((route) =>
      route === "GET /repos/{owner}/{repo}" ? REPO_OK : { status: 404 }
    )
    const capabilities = await createGithubStackAdapter({ octokit: api }).capabilities("octo/app")
    expect(capabilities.allowedMergeMethods).toEqual(["squash", "merge", "rebase"])
  })

  it("honours a repository that switched a merge method off", async () => {
    const api = octokit((route) =>
      route === "GET /repos/{owner}/{repo}"
        ? {
            status: 200,
            data: {
              permissions: { push: true },
              allow_squash_merge: false,
              allow_rebase_merge: false,
            },
          }
        : { status: 404 }
    )
    const capabilities = await createGithubStackAdapter({ octokit: api }).capabilities("octo/app")
    expect(capabilities.allowedMergeMethods).toEqual(["merge"])
  })

  it("reads an existing pull request's real base, so publish does not retarget it needlessly", async () => {
    const api = octokit(() => ({
      status: 200,
      data: [
        {
          number: 7,
          html_url: "https://github.com/octo/app/pull/7",
          base: { ref: "me/a" },
          head: { sha: "abc" },
        },
      ],
    }))
    const found = await createGithubStackAdapter({ octokit: api }).findByBranch("octo/app", "me/b")
    expect(found).toEqual({
      number: 7,
      url: "https://github.com/octo/app/pull/7",
      baseBranch: "me/a",
      headSha: "abc",
    })
  })

  it("treats a missing repository as 'no pull request', not as a failure", async () => {
    // A publish must not abort halfway through a stack because one lookup 404s.
    const api = octokit(() => ({ status: 404 }))
    expect(
      await createGithubStackAdapter({ octokit: api }).findByBranch("octo/app", "me/b")
    ).toBeNull()
  })

  it("registers the chain bottom-to-top through the stacks endpoint", async () => {
    const api = octokit((route) => {
      if (route === "POST /repos/{owner}/{repo}/stacks") {
        return { status: 201, data: { id: 900, number: 4 } }
      }
      return { status: 200, data: {} }
    })
    const adapter = createGithubStackAdapter({ octokit: api })
    const id = await adapter.registerStack?.("octo/app", [11, 12, 13])
    // The stack NUMBER is what the add/unstack endpoints key on, not the id.
    expect(id).toBe("4")
    const call = api.calls.find((entry) => entry.route === "POST /repos/{owner}/{repo}/stacks")
    expect(call?.params.pull_requests).toEqual([11, 12, 13])
  })

  it("returns null rather than throwing when the stacks endpoint refuses", async () => {
    // Not available on this host, not permitted for this token, or the chain
    // drifted. All three mean "the base chain is the whole truth".
    const api = octokit(() => ({ status: 422 }))
    const adapter = createGithubStackAdapter({ octokit: api })
    await expect(adapter.registerStack?.("octo/app", [1, 2])).resolves.toBeNull()
  })

  it("does not register a stack of one", async () => {
    const api = octokit(() => ({ status: 201, data: { number: 1 } }))
    const adapter = createGithubStackAdapter({ octokit: api })
    await expect(adapter.registerStack?.("octo/app", [1])).resolves.toBeNull()
    expect(api.calls).toEqual([])
  })

  it("publishes a real chain through the adapter, bottom first", async () => {
    // The engine driving the GitHub adapter rather than the fake — the check
    // that the interface is actually implementable against a real forge.
    let nextNumber = 100
    const created: Array<{ head: unknown; base: unknown }> = []
    const api = octokit((route, params) => {
      if (route === "GET /repos/{owner}/{repo}") return REPO_OK
      if (route === "GET /repos/{owner}/{repo}/stacks") return { status: 200, data: [] }
      if (route === "GET /repos/{owner}/{repo}/pulls") return { status: 200, data: [] }
      if (route === "POST /repos/{owner}/{repo}/pulls") {
        created.push({ head: params.head, base: params.base })
        const number = nextNumber++
        return {
          status: 201,
          data: { number, html_url: `u/${number}`, base: { ref: params.base }, head: { sha: "s" } },
        }
      }
      if (route === "POST /repos/{owner}/{repo}/stacks") {
        return { status: 201, data: { number: 5 } }
      }
      return { status: 200, data: {} }
    })
    const stack: Stack = {
      id: "s",
      repositoryRoot: "/repos/app",
      trunk: "main",
      model: "branchPerLayer",
      layers: [
        { id: "a", branch: "me/a", title: "A", order: 0 },
        { id: "b", branch: "me/b", title: "B", order: 1 },
      ],
    }
    const result = await publishStack({
      stack,
      repository: "octo/app",
      adapter: createGithubStackAdapter({ octokit: api }),
    })
    expect(result.status).toBe("published")
    if (result.status !== "published") throw new Error("unreachable")
    expect(created).toEqual([
      { head: "me/a", base: "main" },
      { head: "me/b", base: "me/a" },
    ])
    expect(result.nativeStackId).toBe("5")
  })
})
