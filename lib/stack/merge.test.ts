import { createFakeForge } from "./forge/fake"
import type { ForgeObservation } from "./forge/types"
import type { Stack } from "./model"
import { chooseMergeMethod, mergeBlockReason, mergeStack, type MergeStackDeps } from "./merge"
import { publishStack } from "./publish"
import type { RestackStackResult } from "./restack"

function observation(over: Partial<ForgeObservation> = {}): ForgeObservation {
  return {
    ci: "passing",
    review: "approved",
    mergeable: true,
    conflict: false,
    merged: false,
    ...over,
  }
}

const BASE_STACK: Stack = {
  id: "s1",
  repositoryRoot: "/repos/app",
  trunk: "main",
  model: "branchPerLayer",
  layers: [
    { id: "a", branch: "me/a", title: "First", order: 0 },
    { id: "b", branch: "me/b", title: "Second", order: 1 },
    { id: "c", branch: "me/c", title: "Third", order: 2 },
  ],
}

/** A stack whose layers carry the pull requests a publish just created. */
async function publishedStack(adapter = createFakeForge()) {
  const result = await publishStack({ stack: BASE_STACK, repository: "octo/app", adapter })
  if (result.status !== "published") throw new Error("unreachable")
  const stack: Stack = {
    ...BASE_STACK,
    layers: result.layers.map((entry) => ({ ...entry.layer, pullRequest: entry.pullRequest })),
  }
  return { adapter, stack }
}

function deps(over: Partial<MergeStackDeps> = {}): MergeStackDeps & {
  restack: jest.Mock
  setParent: jest.Mock
} {
  return {
    restack: jest.fn(async (): Promise<RestackStackResult> => ({
      status: "restacked",
      verdict: { ok: false, problems: [], remedy: "restack" },
      method: "replay",
      updates: [],
    })),
    setParent: jest.fn(async () => {}),
    ...over,
  } as never
}

describe("mergeBlockReason", () => {
  it("lets a repository with no CI configured merge", () => {
    // Blocking here would make the feature unusable on every repository
    // without checks.
    expect(mergeBlockReason(observation({ ci: "none" }))).toBeNull()
  })

  it("refuses to merge on a CI state it could not read", () => {
    // "Could not tell" is not "fine" — merging on an unread signal is how a
    // red stack lands.
    expect(mergeBlockReason(observation({ ci: "unknown" }))).toBe("ciUnknown")
  })

  it("lets an unreviewed pull request merge where no review is required", () => {
    expect(mergeBlockReason(observation({ review: "none" }))).toBeNull()
    expect(mergeBlockReason(observation({ review: "reviewRequired" }))).toBe("reviewRequired")
    expect(mergeBlockReason(observation({ review: "changesRequested" }))).toBe("changesRequested")
  })

  it("reports a conflict ahead of everything else", () => {
    expect(mergeBlockReason(observation({ conflict: true, ci: "failing" }))).toBe("conflict")
  })

  it("blocks failing and pending checks, and an unmergeable pull request", () => {
    expect(mergeBlockReason(observation({ ci: "failing" }))).toBe("ciFailing")
    expect(mergeBlockReason(observation({ ci: "pending" }))).toBe("ciPending")
    expect(mergeBlockReason(observation({ mergeable: false }))).toBe("notMergeable")
  })
})

describe("chooseMergeMethod", () => {
  it("prefers a squash for branch-per-layer", () => {
    expect(chooseMergeMethod("branchPerLayer", ["squash", "merge"])).toBe("squash")
  })

  it("never squashes a commit-per-pull-request stack", () => {
    // Each commit IS a pull request; collapsing it destroys the trailer that
    // identifies the next one.
    expect(chooseMergeMethod("commitPerPullRequest", ["squash", "rebase", "merge"])).toBe("rebase")
    expect(chooseMergeMethod("commitPerPullRequest", ["squash"])).toBeNull()
  })

  it("honours an explicit preference the repository allows", () => {
    expect(chooseMergeMethod("branchPerLayer", ["squash", "merge"], "merge")).toBe("merge")
  })

  it("ignores a preference the repository forbids, rather than failing", () => {
    expect(chooseMergeMethod("branchPerLayer", ["squash"], "merge")).toBe("squash")
  })
})

describe("mergeStack", () => {
  it("merges bottom-up and settles the remainder after each one", async () => {
    const { adapter, stack } = await publishedStack()
    const injected = deps()
    const result = await mergeStack({ stack, repository: "octo/app", adapter }, injected)
    expect(result.status).toBe("merged")
    if (result.status !== "merged") throw new Error("unreachable")
    expect(result.merged.map((entry) => entry.pullRequest)).toEqual([1, 2, 3])
    expect(adapter.merged.map((entry) => entry.method)).toEqual(["squash", "squash", "squash"])
    // Two merges have layers above them; the last does not.
    expect(injected.restack).toHaveBeenCalledTimes(2)
  })

  it("restacks and pushes before retargeting, never the other way round", async () => {
    // Retargeting first leaves the pull request showing every layer below it
    // until the push lands — exactly when a reviewer is looking at it.
    const { adapter, stack } = await publishedStack()
    const order: string[] = []
    const injected = deps({
      restack: jest.fn(async (): Promise<RestackStackResult> => {
        order.push("restack")
        return {
          status: "restacked",
          verdict: { ok: false, problems: [], remedy: "restack" },
          method: "replay",
          updates: [],
        }
      }),
    })
    const watched = {
      ...adapter,
      retarget: async (repository: string, pullRequest: number, baseBranch: string) => {
        order.push(`retarget:${pullRequest}`)
        return adapter.retarget(repository, pullRequest, baseBranch)
      },
    }
    await mergeStack(
      { stack, repository: "octo/app", adapter: watched, remote: "origin" },
      injected
    )
    expect(order).toEqual(["restack", "retarget:2", "restack", "retarget:3"])
    expect(adapter.pullRequests.get(2)?.baseBranch).toBe("main")
    expect(adapter.pullRequests.get(3)?.baseBranch).toBe("main")
  })

  it("tells git the layer below is gone before restacking onto the trunk", async () => {
    const { adapter, stack } = await publishedStack()
    const injected = deps()
    await mergeStack({ stack, repository: "octo/app", adapter }, injected)
    expect(injected.setParent).toHaveBeenNthCalledWith(1, "/repos/app", "me/b", "main")
    expect(injected.setParent.mock.invocationCallOrder[0]).toBeLessThan(
      injected.restack.mock.invocationCallOrder[0]!
    )
  })

  it("stops at the first layer that is not ready, keeping what already merged", async () => {
    const { adapter, stack } = await publishedStack()
    adapter.setObservation("me/b", { ci: "failing" })
    const result = await mergeStack({ stack, repository: "octo/app", adapter }, deps())
    expect(result.status).toBe("blocked")
    if (result.status !== "blocked") throw new Error("unreachable")
    expect(result.branch).toBe("me/b")
    expect(result.reason).toBe("ciFailing")
    expect(result.merged.map((entry) => entry.pullRequest)).toEqual([1])
    expect(adapter.merged).toHaveLength(1)
  })

  it("resumes rather than erroring on a stack that half merged", async () => {
    // A stack merge is a sequence of network calls that can fail halfway.
    const { adapter, stack } = await publishedStack()
    adapter.setObservation("me/c", { ci: "failing" })
    const first = await mergeStack({ stack, repository: "octo/app", adapter }, deps())
    expect(first.status).toBe("blocked")

    adapter.setObservation("me/c", { ci: "passing" })
    const second = await mergeStack({ stack, repository: "octo/app", adapter }, deps())
    expect(second.status).toBe("merged")
    // The two already-merged layers were not merged a second time.
    expect(adapter.merged.map((entry) => entry.pullRequest)).toEqual([1, 2, 3])
  })

  it("hands back the worktree when settling the remainder conflicts", async () => {
    const { adapter, stack } = await publishedStack()
    const injected = deps({
      restack: jest.fn(async (): Promise<RestackStackResult> => ({
        status: "conflict",
        verdict: { ok: false, problems: [], remedy: "restack" },
        branch: "me/b",
        worktree: "/repos/app/.git/cognia-stack-restack",
        updates: [],
      })),
    })
    const result = await mergeStack({ stack, repository: "octo/app", adapter }, injected)
    expect(result.status).toBe("conflict")
    if (result.status !== "conflict") throw new Error("unreachable")
    expect(result.worktree).toContain("cognia-stack-restack")
    expect(result.merged).toHaveLength(1)
    // The pull request keeps its old base: retargeting it now would show a
    // diff against a trunk its branch has not been rebased onto.
    expect(adapter.pullRequests.get(2)?.baseBranch).toBe("me/a")
  })

  it("refuses a repository that allows no method this stack can use", async () => {
    const adapter = createFakeForge({ capabilities: { allowedMergeMethods: ["squash"] } })
    const { stack } = await publishedStack(adapter)
    const result = await mergeStack(
      { stack: { ...stack, model: "commitPerPullRequest" }, repository: "octo/app", adapter },
      deps()
    )
    expect(result).toEqual({ status: "unsupportedMethod", allowed: ["squash"] })
    expect(adapter.merged).toEqual([])
  })

  it("refuses a layer with no pull request instead of skipping it", async () => {
    const { adapter, stack } = await publishedStack()
    const result = await mergeStack(
      {
        stack: {
          ...stack,
          layers: stack.layers.map((layer) =>
            layer.branch === "me/b" ? { ...layer, pullRequest: undefined } : layer
          ),
        },
        repository: "octo/app",
        adapter,
      },
      deps()
    )
    expect(result.status).toBe("blocked")
    if (result.status !== "blocked") throw new Error("unreachable")
    expect(result.reason).toBe("noPullRequest")
    expect(result.pullRequest).toBeNull()
  })
})
