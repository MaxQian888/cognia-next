import {
  AGENT_BRANCH_PREFIX,
  canDeleteBranch,
  describePlacement,
  isAgentBranch,
  primaryActionFor,
  stackParentIndex,
  worktreeLabel,
} from "./branch-placement"
import type { GitBranch } from "@/types/git"

function branch(overrides: Partial<GitBranch> = {}): GitBranch {
  return {
    name: "feature",
    isCurrent: false,
    isRemote: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    checkedOutIn: null,
    checkoutLocked: false,
    ...overrides,
  }
}

describe("describePlacement", () => {
  it("reads the bound checkout from isCurrent, not from a path", () => {
    // isCurrent wins even though a worktree path is present: on the main
    // checkout the backend fills both, and over a companion the panel's
    // rootDir is an opaque target that no path comparison could match.
    const placement = describePlacement(
      branch({ name: "dev", isCurrent: true, checkedOutIn: "/repo" })
    )
    expect(placement).toEqual({ kind: "here" })
  })

  it("names the worktree holding a branch this checkout does not have", () => {
    expect(describePlacement(branch({ checkedOutIn: "/repo/wt/feature" }))).toEqual({
      kind: "otherWorktree",
      path: "/repo/wt/feature",
      locked: false,
    })
  })

  it("carries the lock, which marks a Registry-owned worktree", () => {
    const placement = describePlacement(
      branch({ checkedOutIn: "/repo/wt/run-a", checkoutLocked: true })
    )
    expect(placement).toEqual({
      kind: "otherWorktree",
      path: "/repo/wt/run-a",
      locked: true,
    })
  })

  it("calls an unheld local branch free", () => {
    expect(describePlacement(branch())).toEqual({ kind: "free" })
  })

  it("splits a remote ref on its first slash so a slashed branch survives", () => {
    expect(describePlacement(branch({ name: "origin/feat/x", isRemote: true }))).toEqual({
      kind: "remoteOnly",
      remote: "origin",
      shortName: "feat/x",
    })
  })

  it("treats a remote ref as remote even when a worktree path came back", () => {
    // A worktree checks out a local branch or a detached HEAD, never origin/x.
    const placement = describePlacement(
      branch({ name: "origin/feature", isRemote: true, checkedOutIn: "/repo/wt/f" })
    )
    expect(placement.kind).toBe("remoteOnly")
  })

  it("survives a remote ref with no slash", () => {
    expect(describePlacement(branch({ name: "weird", isRemote: true }))).toEqual({
      kind: "remoteOnly",
      remote: "",
      shortName: "weird",
    })
  })
})

describe("primaryActionFor", () => {
  it("sends a held branch to its worktree instead of a checkout git would refuse", () => {
    const held = describePlacement(branch({ checkedOutIn: "/repo/wt/feature" }))
    expect(primaryActionFor(held)).toBe("openWorktree")
  })

  it("creates a tracking branch for a remote ref rather than detaching HEAD", () => {
    const remote = describePlacement(branch({ name: "origin/feature", isRemote: true }))
    expect(primaryActionFor(remote)).toBe("createTracking")
  })

  it("checks out a free branch and offers nothing on the current one", () => {
    expect(primaryActionFor({ kind: "free" })).toBe("checkout")
    expect(primaryActionFor({ kind: "here" })).toBe("none")
  })
})

describe("canDeleteBranch", () => {
  it("allows only a branch no worktree holds", () => {
    expect(canDeleteBranch(branch())).toBe(true)
    expect(canDeleteBranch(branch({ isCurrent: true }))).toBe(false)
    expect(canDeleteBranch(branch({ checkedOutIn: "/repo/wt/f" }))).toBe(false)
    expect(canDeleteBranch(branch({ name: "origin/f", isRemote: true }))).toBe(false)
  })
})

describe("isAgentBranch", () => {
  it("matches the prefix isolated runs cut", () => {
    expect(isAgentBranch(`${AGENT_BRANCH_PREFIX}run_a/alice/t1`)).toBe(true)
    expect(isAgentBranch("feature/agent/x")).toBe(false)
  })
})

describe("worktreeLabel", () => {
  it("reduces a path to its last segment on both separators", () => {
    expect(worktreeLabel("/repo/wt/feature")).toBe("feature")
    expect(worktreeLabel("C:\\repo\\wt\\feature")).toBe("feature")
  })

  it("ignores a trailing separator", () => {
    expect(worktreeLabel("/repo/wt/feature/")).toBe("feature")
  })

  it("returns a bare name unchanged", () => {
    expect(worktreeLabel("feature")).toBe("feature")
  })
})

describe("stackParentIndex", () => {
  it("indexes child to parent", () => {
    const index = stackParentIndex([
      ["b", "a"],
      ["c", "b"],
    ])
    expect(index.get("c")).toBe("b")
    expect(index.get("a")).toBeUndefined()
  })
})
