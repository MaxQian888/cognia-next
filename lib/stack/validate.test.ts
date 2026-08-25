import type { GitStackLayerState } from "@/types/git"

import type { Stack } from "./model"
import { canPublish, canRestack, validateStack } from "./validate"

const STACK: Pick<Stack, "trunk" | "layers"> = {
  trunk: "main",
  layers: [
    { id: "a", branch: "me/a", title: "A", order: 0 },
    { id: "b", branch: "me/b", title: "B", order: 1 },
    { id: "c", branch: "me/c", title: "C", order: 2 },
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

const HEALTHY: GitStackLayerState[] = [
  state({ branch: "me/a", parent: "main" }),
  state({ branch: "me/b", parent: "me/a" }),
  state({ branch: "me/c", parent: "me/b" }),
]

describe("validateStack", () => {
  it("passes a stack whose layers actually sit on each other", () => {
    const verdict = validateStack({ stack: STACK, states: HEALTHY })
    expect(verdict).toEqual({ ok: true, problems: [], remedy: "none" })
    expect(canPublish(verdict)).toBe(true)
    expect(canRestack(verdict)).toBe(false)
  })

  it("reports a layer that no longer contains its parent, and offers a restack", () => {
    // The layer still publishes. Its pull request just quietly contains its
    // parent's diff as well — which is the whole reason ancestry is checked.
    const verdict = validateStack({
      stack: STACK,
      states: [
        HEALTHY[0]!,
        state({ branch: "me/b", parent: "me/a", containsParent: false }),
        HEALTHY[2]!,
      ],
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.problems).toEqual([{ kind: "behindParent", branch: "me/b", parent: "me/a" }])
    expect(verdict.remedy).toBe("restack")
    expect(canRestack(verdict)).toBe(true)
  })

  it("asks for the branch before anything else when a layer has none", () => {
    const verdict = validateStack({
      stack: STACK,
      states: [HEALTHY[0]!, state({ branch: "me/b", head: null }), HEALTHY[2]!],
    })
    expect(verdict.problems).toEqual([{ kind: "missingBranch", branch: "me/b" }])
    expect(verdict.remedy).toBe("createBranch")
    // A restack cannot create a branch, so the button must not be offered.
    expect(canRestack(verdict)).toBe(false)
  })

  it("treats a missing state row the same as a missing branch", () => {
    const verdict = validateStack({ stack: STACK, states: [HEALTHY[0]!, HEALTHY[1]!] })
    expect(verdict.problems).toEqual([{ kind: "missingBranch", branch: "me/c" }])
  })

  it("asks for the worktree to be released before moving a layer", () => {
    const verdict = validateStack({
      stack: STACK,
      states: [
        HEALTHY[0]!,
        state({ branch: "me/b", parent: "me/a", checkedOutIn: "/tmp/task-42" }),
        HEALTHY[2]!,
      ],
    })
    expect(verdict.problems).toEqual([
      { kind: "checkedOut", branch: "me/b", worktree: "/tmp/task-42" },
    ])
    expect(verdict.remedy).toBe("releaseWorktree")
  })

  it("wants a person when the recorded parent contradicts the stack", () => {
    const verdict = validateStack({
      stack: STACK,
      states: [
        HEALTHY[0]!,
        state({ branch: "me/b", parent: "somebody-else", containsParent: false }),
        HEALTHY[2]!,
      ],
    })
    // `containsParent` answered about `somebody-else`, so it says nothing
    // about THIS stack and must not be reported as being behind.
    expect(verdict.problems).toEqual([
      { kind: "parentMismatch", branch: "me/b", recorded: "somebody-else", expected: "me/a" },
    ])
    expect(verdict.remedy).toBe("repair")
  })

  it("flags a layer git was never told is stacked", () => {
    // Harmless to git, fatal to a pull request: the base branch is computed
    // from the pointer.
    const verdict = validateStack({
      stack: STACK,
      states: [HEALTHY[0]!, state({ branch: "me/b", parent: null }), HEALTHY[2]!],
    })
    expect(verdict.problems).toEqual([
      { kind: "parentUnrecorded", branch: "me/b", expected: "me/a" },
    ])
    expect(verdict.remedy).toBe("restack")
  })

  it("refuses outright when the only write access is to a fork", () => {
    // A stack cannot cross a fork boundary: every layer above the bottom is
    // based on a branch the upstream repository cannot see.
    const verdict = validateStack({
      stack: STACK,
      states: HEALTHY,
      forkOnlyRepository: "octo/upstream",
    })
    expect(verdict.problems).toEqual([{ kind: "forkOnly", repository: "octo/upstream" }])
    expect(verdict.remedy).toBe("blocked")
    expect(canRestack(verdict)).toBe(false)
    expect(canPublish(verdict)).toBe(false)
  })

  it("offers the remedy that has to happen first when several things are wrong", () => {
    const verdict = validateStack({
      stack: STACK,
      states: [
        state({ branch: "me/a", parent: "main", containsParent: false }),
        state({ branch: "me/b", head: null }),
        state({ branch: "me/c", parent: "me/b", checkedOutIn: "/tmp/wt" }),
      ],
    })
    // Restacking cannot run while a branch is missing, so "create the branch"
    // wins over both of the others.
    expect(verdict.remedy).toBe("createBranch")
    expect(verdict.problems).toHaveLength(3)
  })
})
