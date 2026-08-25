import { createFakeForge } from "./fake"

/**
 * The fake is what the publish and merge tests trust. A fake that reports
 * success for something a real forge would refuse turns those suites green
 * while the engine is wrong, so its own behaviour is pinned here.
 */
describe("createFakeForge", () => {
  it("hands out increasing numbers and remembers the branch each belongs to", async () => {
    const forge = createFakeForge()
    const first = await forge.createPullRequest({
      repository: "octo/app",
      branch: "me/a",
      baseBranch: "main",
      title: "A",
      order: 0,
      total: 2,
    })
    expect(first.number).toBe(1)
    expect(await forge.findByBranch("octo/app", "me/a")).toMatchObject({ number: 1 })
    expect(await forge.findByBranch("octo/app", "me/b")).toBeNull()
    // Branches are scoped to their repository, not global.
    expect(await forge.findByBranch("other/app", "me/a")).toBeNull()
  })

  it("moves a base on retarget rather than creating a second pull request", async () => {
    const forge = createFakeForge()
    await forge.createPullRequest({
      repository: "octo/app",
      branch: "me/a",
      baseBranch: "me/root",
      title: "A",
      order: 0,
      total: 1,
    })
    await forge.retarget("octo/app", 1, "main")
    expect((await forge.findByBranch("octo/app", "me/a"))?.baseBranch).toBe("main")
    expect(forge.pullRequests.size).toBe(1)
  })

  it("reports a merged pull request as merged afterwards", async () => {
    // Without this, the resume path in `mergeStack` would never be exercised.
    const forge = createFakeForge()
    await forge.createPullRequest({
      repository: "octo/app",
      branch: "me/a",
      baseBranch: "main",
      title: "A",
      order: 0,
      total: 1,
    })
    expect((await forge.observe("octo/app", 1)).merged).toBe(false)
    await forge.merge("octo/app", 1, "squash")
    expect((await forge.observe("octo/app", 1)).merged).toBe(true)
  })

  it("lets a test change an observation mid-run", async () => {
    const forge = createFakeForge({ observations: { "me/a": { ci: "pending" } } })
    await forge.createPullRequest({
      repository: "octo/app",
      branch: "me/a",
      baseBranch: "main",
      title: "A",
      order: 0,
      total: 1,
    })
    expect((await forge.observe("octo/app", 1)).ci).toBe("pending")
    forge.setObservation("me/a", { ci: "passing" })
    expect((await forge.observe("octo/app", 1)).ci).toBe("passing")
  })

  it("has no registerStack at all when it models a forge without stacks", () => {
    // Absent, not present-and-returning-null: `publishStack` checks for the
    // method, and a forge without stacks must exercise that branch.
    expect(createFakeForge().registerStack).toBeInstanceOf(Function)
    expect(createFakeForge({ capabilities: { nativeStacks: false } }).registerStack).toBeUndefined()
  })

  it("refuses to touch a pull request it never created", async () => {
    const forge = createFakeForge()
    await expect(forge.retarget("octo/app", 99, "main")).rejects.toThrow("no pull request 99")
    await expect(forge.merge("octo/app", 99, "squash")).rejects.toThrow("no pull request 99")
    await expect(forge.comment("octo/app", 99, "hi")).rejects.toThrow("no pull request 99")
  })
})
