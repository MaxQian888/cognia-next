import { createFakeForge } from "./forge/fake"
import { attachPullRequests, discoverStacks, stackIdFor } from "./discover"

function deps(pairs: Array<[string, string]>) {
  return { parents: jest.fn(async () => pairs) }
}

describe("discoverStacks", () => {
  it("walks the parent pointers into a chain, bottom layer first", async () => {
    const stacks = await discoverStacks(
      { repositoryRoot: "/repos/app" },
      deps([
        ["me/c", "me/b"],
        ["me/a", "main"],
        ["me/b", "me/a"],
      ])
    )
    expect(stacks).toHaveLength(1)
    expect(stacks[0]!.trunk).toBe("main")
    expect(stacks[0]!.layers.map((layer) => layer.branch)).toEqual(["me/a", "me/b", "me/c"])
    expect(stacks[0]!.layers.map((layer) => layer.order)).toEqual([0, 1, 2])
    expect(stacks[0]!.id).toBe(stackIdFor("me/c"))
  })

  it("returns two stacks when a layer has two children, sharing the prefix", async () => {
    // They are two independent things to publish and land that happen to rest
    // on the same work — not one branching stack.
    const stacks = await discoverStacks(
      { repositoryRoot: "/repos/app" },
      deps([
        ["me/a", "main"],
        ["me/b", "me/a"],
        ["me/c", "me/a"],
      ])
    )
    expect(stacks.map((stack) => stack.layers.map((layer) => layer.branch))).toEqual([
      ["me/a", "me/b"],
      ["me/a", "me/c"],
    ])
  })

  it("finds several independent stacks in one repository", async () => {
    const stacks = await discoverStacks(
      { repositoryRoot: "/repos/app" },
      deps([
        ["feature/one", "main"],
        ["fix/two", "release/3"],
      ])
    )
    expect(stacks.map((stack) => stack.trunk)).toEqual(["main", "release/3"])
  })

  it("is deterministic, so a panel does not reshuffle between reads", async () => {
    const pairs: Array<[string, string]> = [
      ["z/tip", "main"],
      ["a/tip", "main"],
    ]
    const first = await discoverStacks({ repositoryRoot: "/r" }, deps(pairs))
    const second = await discoverStacks({ repositoryRoot: "/r" }, deps([...pairs].reverse()))
    expect(first.map((stack) => stack.id)).toEqual(second.map((stack) => stack.id))
  })

  it("drops a pointer cycle without hiding the stacks that are fine", async () => {
    // A loop is corrupt data one `git config --unset` fixes. Refusing to show
    // anything because of it hides the nine stacks that work.
    const stacks = await discoverStacks(
      { repositoryRoot: "/repos/app" },
      deps([
        ["loop/a", "loop/b"],
        ["loop/b", "loop/a"],
        ["good/one", "main"],
      ])
    )
    expect(stacks.map((stack) => stack.id)).toEqual([stackIdFor("good/one")])
  })

  it("finds nothing in a repository with no pointers", async () => {
    expect(await discoverStacks({ repositoryRoot: "/repos/app" }, deps([]))).toEqual([])
  })

  it("stamps the authoring model the caller asked for", async () => {
    const stacks = await discoverStacks(
      { repositoryRoot: "/r", model: "commitPerPullRequest" },
      deps([["a", "main"]])
    )
    expect(stacks[0]!.model).toBe("commitPerPullRequest")
  })
})

describe("attachPullRequests", () => {
  it("fills in the pull request each branch has, and leaves the rest alone", async () => {
    const adapter = createFakeForge()
    await adapter.createPullRequest({
      repository: "octo/app",
      branch: "me/a",
      baseBranch: "main",
      title: "A",
      order: 0,
      total: 2,
    })
    const [stack] = await discoverStacks(
      { repositoryRoot: "/repos/app" },
      deps([
        ["me/a", "main"],
        ["me/b", "me/a"],
      ])
    )
    const filled = await attachPullRequests(stack!, "octo/app", adapter)
    expect(filled.layers[0]!.pullRequest?.number).toBe(1)
    expect(filled.layers[1]!.pullRequest).toBeUndefined()
  })

  it("survives a forge that fails on one branch", async () => {
    const [stack] = await discoverStacks({ repositoryRoot: "/r" }, deps([["me/a", "main"]]))
    const filled = await attachPullRequests(stack!, "octo/app", {
      findByBranch: async () => {
        throw new Error("rate limited")
      },
    })
    expect(filled.layers[0]!.pullRequest).toBeUndefined()
  })
})
