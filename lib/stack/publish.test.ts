import { createFakeForge } from "./forge/fake"
import type { Stack } from "./model"
import { publishStack, stackBodyNote } from "./publish"

const STACK: Stack = {
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

describe("publishStack", () => {
  it("bases each layer on the one below and the bottom on the trunk", async () => {
    const adapter = createFakeForge()
    const result = await publishStack({ stack: STACK, repository: "octo/app", adapter })
    expect(result.status).toBe("published")
    if (result.status !== "published") throw new Error("unreachable")
    expect(result.layers.map((entry) => entry.pullRequest.baseBranch)).toEqual([
      "main",
      "me/a",
      "me/b",
    ])
    expect(result.layers.every((entry) => entry.action === "created")).toBe(true)
  })

  it("creates the pull requests bottom first", async () => {
    // A pull request whose base branch does not exist yet is rejected outright.
    const adapter = createFakeForge()
    const result = await publishStack({ stack: STACK, repository: "octo/app", adapter })
    if (result.status !== "published") throw new Error("unreachable")
    expect(result.layers.map((entry) => entry.pullRequest.number)).toEqual([1, 2, 3])
  })

  it("is idempotent — a second publish creates nothing", async () => {
    const adapter = createFakeForge()
    await publishStack({ stack: STACK, repository: "octo/app", adapter })
    const again = await publishStack({ stack: STACK, repository: "octo/app", adapter })
    if (again.status !== "published") throw new Error("unreachable")
    expect(again.layers.every((entry) => entry.action === "unchanged")).toBe(true)
    expect(adapter.pullRequests.size).toBe(3)
  })

  it("retargets a pull request whose base drifted, without making a new one", async () => {
    const adapter = createFakeForge()
    const first = await publishStack({ stack: STACK, repository: "octo/app", adapter })
    if (first.status !== "published") throw new Error("unreachable")
    await adapter.retarget("octo/app", 3, "main")

    const again = await publishStack({ stack: STACK, repository: "octo/app", adapter })
    if (again.status !== "published") throw new Error("unreachable")
    expect(again.layers.map((entry) => entry.action)).toEqual([
      "unchanged",
      "unchanged",
      "retargeted",
    ])
    expect(adapter.pullRequests.get(3)?.baseBranch).toBe("me/b")
    expect(adapter.pullRequests.size).toBe(3)
  })

  it("says which layer this is, so a reader is not lost on layer three", async () => {
    const adapter = createFakeForge()
    await publishStack({
      stack: STACK,
      repository: "octo/app",
      adapter,
      bodyFor: () => "Closes #12",
    })
    expect(stackBodyNote(2, 3, "me/b")).toBe("Stacked pull request 3 of 3 — based on `me/b`.")
  })

  it("registers the chain with the forge's own stack, once every layer exists", async () => {
    const adapter = createFakeForge()
    const result = await publishStack({ stack: STACK, repository: "octo/app", adapter })
    if (result.status !== "published") throw new Error("unreachable")
    expect(adapter.registered).toEqual([{ repository: "octo/app", pullRequests: [1, 2, 3] }])
    expect(result.nativeStackId).toBe("stack-1")
  })

  it("publishes fine against a forge with no stacks of its own", async () => {
    // The chain of base branches already carries the shape; the native object
    // only buys the forge's own UI and merge queue.
    const adapter = createFakeForge({ capabilities: { nativeStacks: false } })
    const result = await publishStack({ stack: STACK, repository: "octo/app", adapter })
    if (result.status !== "published") throw new Error("unreachable")
    expect(result.nativeStackId).toBeUndefined()
    expect(result.layers).toHaveLength(3)
  })

  it("treats a declined registration as no registration, not as a failure", async () => {
    const adapter = createFakeForge()
    const declining = {
      ...adapter,
      registerStack: async () => null,
    }
    const result = await publishStack({
      stack: STACK,
      repository: "octo/app",
      adapter: declining,
    })
    if (result.status !== "published") throw new Error("unreachable")
    expect(result.nativeStackId).toBeUndefined()
    expect(result.layers).toHaveLength(3)
  })

  it("refuses when only a fork can be pushed to", async () => {
    // Every layer above the bottom would be based on a branch the target
    // repository cannot see. No forge supports it.
    const adapter = createFakeForge({
      capabilities: { canPushToTarget: false, forkFullName: "me/app" },
    })
    const result = await publishStack({ stack: STACK, repository: "octo/app", adapter })
    expect(result).toEqual({ status: "forkOnly", repository: "octo/app", fork: "me/app" })
    expect(adapter.pullRequests.size).toBe(0)
  })

  it("does not register a stack of one", async () => {
    const adapter = createFakeForge()
    await publishStack({
      stack: { ...STACK, layers: [STACK.layers[0]!] },
      repository: "octo/app",
      adapter,
    })
    expect(adapter.registered).toEqual([])
  })
})
