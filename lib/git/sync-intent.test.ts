import { resolveSyncIntent, type SyncState } from "./sync-intent"

const tracking: SyncState = { branch: "main", upstream: "origin/main", ahead: 0, behind: 0 }

describe("resolveSyncIntent", () => {
  it("fetches an up-to-date branch", () => {
    expect(resolveSyncIntent(tracking)).toBe("fetch")
  })

  it("fetches on a detached HEAD, whatever the counts", () => {
    expect(resolveSyncIntent({ ...tracking, branch: null, upstream: null, ahead: 3 })).toBe("fetch")
  })

  it("publishes a branch with no upstream", () => {
    expect(resolveSyncIntent({ ...tracking, upstream: null, ahead: 2 })).toBe("publish")
  })

  it("pulls a branch that is only behind", () => {
    expect(resolveSyncIntent({ ...tracking, behind: 4 })).toBe("pull")
  })

  it("pushes a branch that is only ahead", () => {
    expect(resolveSyncIntent({ ...tracking, ahead: 1 })).toBe("push")
  })

  it("synchronizes a branch that has diverged", () => {
    expect(resolveSyncIntent({ ...tracking, ahead: 1, behind: 2 })).toBe("sync")
  })
})
