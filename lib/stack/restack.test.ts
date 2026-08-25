import type { GitStackLayerState } from "@/types/git"

import type { Stack } from "./model"
import { restackNoteBody, restackStack, type RestackDeps } from "./restack"

const STACK: Stack = {
  id: "s1",
  repositoryRoot: "/repos/app",
  trunk: "main",
  model: "branchPerLayer",
  layers: [
    { id: "a", branch: "me/a", title: "A", order: 0 },
    { id: "b", branch: "me/b", title: "B", order: 1 },
  ],
}

function state(over: Partial<GitStackLayerState> & { branch: string }): GitStackLayerState {
  return {
    parent: null,
    head: "0".repeat(40),
    containsParent: true,
    checkedOutIn: null,
    ...over,
  }
}

function deps(over: Partial<RestackDeps> = {}): RestackDeps & {
  setParent: jest.Mock
  restack: jest.Mock
  push: jest.Mock
} {
  return {
    validate: jest.fn(async () => [
      state({ branch: "me/a", parent: "main" }),
      state({ branch: "me/b", parent: "me/a", containsParent: false }),
    ]),
    restack: jest.fn(async () => ({
      method: "replay" as const,
      updates: [
        { branch: "me/b", from: "a".repeat(40), to: "b".repeat(40), historyRef: "refs/cognia/x" },
      ],
      conflict: null,
    })),
    setParent: jest.fn(async () => {}),
    push: jest.fn(async () => ({ pushed: ["me/b"], forceIfIncludes: true })),
    ...over,
  } as never
}

describe("restackStack", () => {
  it("does nothing at all when every layer already sits on the one below", async () => {
    const injected = deps({
      validate: jest.fn(async () => [
        state({ branch: "me/a", parent: "main" }),
        state({ branch: "me/b", parent: "me/a" }),
      ]),
    })
    const result = await restackStack({ stack: STACK }, injected)
    expect(result.status).toBe("upToDate")
    expect(injected.restack).not.toHaveBeenCalled()
    expect(injected.push).not.toHaveBeenCalled()
  })

  it("moves the layers and reports what moved", async () => {
    const injected = deps()
    const result = await restackStack({ stack: STACK }, injected)
    expect(result.status).toBe("restacked")
    expect(injected.restack).toHaveBeenCalledWith("/repos/app", "main", ["me/a", "me/b"])
    if (result.status !== "restacked") throw new Error("unreachable")
    expect(result.updates).toEqual([
      { branch: "me/b", from: "a".repeat(40), to: "b".repeat(40), historyRef: "refs/cognia/x" },
    ])
    expect(result.method).toBe("replay")
  })

  it("restacks onto an explicit base when one is given", async () => {
    const injected = deps()
    await restackStack({ stack: STACK, onto: "release/2" }, injected)
    expect(injected.restack).toHaveBeenCalledWith("/repos/app", "release/2", ["me/a", "me/b"])
  })

  it("refuses, with the remedy, when a restack cannot fix the problem", async () => {
    // Offering a button that cannot work teaches people the button is broken.
    const injected = deps({
      validate: jest.fn(async () => [
        state({ branch: "me/a", parent: "main" }),
        state({ branch: "me/b", head: null }),
      ]),
    })
    const result = await restackStack({ stack: STACK }, injected)
    expect(result.status).toBe("refused")
    expect(result.verdict.remedy).toBe("createBranch")
    expect(injected.restack).not.toHaveBeenCalled()
  })

  it("refuses a fork-only repository rather than producing a broken stack", async () => {
    const injected = deps()
    const result = await restackStack(
      { stack: STACK, forkOnlyRepository: "octo/upstream" },
      injected
    )
    expect(result.status).toBe("refused")
    expect(result.verdict.remedy).toBe("blocked")
    expect(injected.restack).not.toHaveBeenCalled()
  })

  it("records a missing parent pointer before moving anything", async () => {
    // It is the one problem in the list this function is supposed to fix, and
    // writing it first means a crash mid-restack leaves the stack recorded.
    const injected = deps({
      validate: jest.fn(async () => [
        state({ branch: "me/a", parent: "main" }),
        state({ branch: "me/b", parent: null }),
      ]),
    })
    await restackStack({ stack: STACK }, injected)
    expect(injected.setParent).toHaveBeenCalledWith("/repos/app", "me/b", "me/a")
    expect(injected.setParent.mock.invocationCallOrder[0]).toBeLessThan(
      injected.restack.mock.invocationCallOrder[0]!
    )
  })

  it("hands back the worktree a conflict stopped in, and what moved before it", async () => {
    const injected = deps({
      restack: jest.fn(async () => ({
        method: "rebase" as const,
        updates: [
          { branch: "me/a", from: "1".repeat(40), to: "2".repeat(40), historyRef: "refs/cognia/a" },
        ],
        conflict: { branch: "me/b", worktree: "/repos/app/.git/cognia-stack-restack" },
      })),
    })
    const result = await restackStack({ stack: STACK, remote: "origin" }, injected)
    expect(result.status).toBe("conflict")
    if (result.status !== "conflict") throw new Error("unreachable")
    expect(result.branch).toBe("me/b")
    expect(result.worktree).toContain("cognia-stack-restack")
    expect(result.updates).toHaveLength(1)
    // Nothing is pushed from a half-finished restack.
    expect(injected.push).not.toHaveBeenCalled()
  })

  it("pushes only the branches that moved, and only when a remote is given", async () => {
    const injected = deps()
    await restackStack({ stack: STACK }, injected)
    expect(injected.push).not.toHaveBeenCalled()

    const withRemote = deps()
    const result = await restackStack({ stack: STACK, remote: "origin" }, withRemote)
    expect(withRemote.push).toHaveBeenCalledWith("/repos/app", "origin", ["me/b"])
    if (result.status !== "restacked") throw new Error("unreachable")
    expect(result.pushed?.forceIfIncludes).toBe(true)
  })

  it("announces after the push, never before it", async () => {
    // A note saying "your branch is now abc123" published before abc123 exists
    // on the remote sends every reader to a 404.
    const order: string[] = []
    const injected = deps({
      push: jest.fn(async () => {
        order.push("push")
        return { pushed: ["me/b"], forceIfIncludes: true }
      }),
    })
    await restackStack(
      {
        stack: STACK,
        remote: "origin",
        announce: async () => {
          order.push("announce")
        },
      },
      injected
    )
    expect(order).toEqual(["push", "announce"])
  })

  it("says nothing when nothing moved", async () => {
    const announce = jest.fn(async () => {})
    const injected = deps({
      restack: jest.fn(async () => ({ method: "replay" as const, updates: [], conflict: null })),
    })
    await restackStack({ stack: STACK, remote: "origin", announce }, injected)
    expect(announce).not.toHaveBeenCalled()
    expect(injected.push).not.toHaveBeenCalled()
  })
})

describe("restackNoteBody", () => {
  it("says it was a restack and where the old tip went", () => {
    // A reviewer finding their comments on commits that no longer exist needs
    // to know the work was not rewritten — and needs a way back.
    const body = restackNoteBody([
      { branch: "me/b", from: "a".repeat(40), to: "b".repeat(40), historyRef: "refs/cognia/x" },
    ])
    expect(body).toContain("The changes are the same; the commits are new.")
    expect(body).toContain("aaaaaaaa → bbbbbbbb")
    expect(body).toContain("refs/cognia/x")
  })
})
