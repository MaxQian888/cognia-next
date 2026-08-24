import { bindingKey, bindingRef, type TeammatePrBinding } from "./binding"

function mk(over: Partial<TeammatePrBinding> = {}): TeammatePrBinding {
  return {
    runId: "run-1",
    teamId: "team-a",
    memberId: "m1",
    taskId: "t1",
    repo: "acme/app",
    branch: "agent/run-1/dev/t1",
    ...over,
  }
}

describe("bindingKey", () => {
  it("is stable per (run, member, task) and independent of the discovered PR", () => {
    expect(bindingKey(mk())).toBe("run-1:m1:t1")
    expect(bindingKey(mk({ prUrl: "x", prNumber: 9 }))).toBe("run-1:m1:t1")
  })
})

describe("bindingRef", () => {
  it("uses an explicit PR number when present", () => {
    expect(bindingRef(mk({ prNumber: 9, prUrl: "u" }))).toEqual({ number: 9, url: "u" })
  })
  it("falls back to discovery by branch", () => {
    expect(bindingRef(mk())).toEqual({ branch: "agent/run-1/dev/t1" })
  })
})
