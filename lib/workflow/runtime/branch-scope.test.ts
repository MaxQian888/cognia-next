import { losingBranchScope, reverseReachable, type ScopeEdge } from "./branch-scope"

// Diamond with two parallel branches of different lengths:
//
//   trigger → split → a1 → a2 → join
//                   ↘ b1 ──────↗
const EDGES: ScopeEdge[] = [
  { source: "trigger", target: "split" },
  { source: "split", target: "a1" },
  { source: "a1", target: "a2" },
  { source: "a2", target: "join" },
  { source: "split", target: "b1" },
  { source: "b1", target: "join" },
]

describe("reverseReachable", () => {
  it("includes the start node and all ancestors", () => {
    expect(reverseReachable(EDGES, "a2")).toEqual(new Set(["a2", "a1", "split", "trigger"]))
  })

  it("a source node reaches only itself", () => {
    expect(reverseReachable(EDGES, "trigger")).toEqual(new Set(["trigger"]))
  })

  it("tolerates cycles without spinning", () => {
    const cyclic: ScopeEdge[] = [
      { source: "x", target: "y" },
      { source: "y", target: "x" },
      { source: "y", target: "z" },
    ]
    expect(reverseReachable(cyclic, "z")).toEqual(new Set(["z", "y", "x"]))
  })
})

describe("losingBranchScope", () => {
  it("isolates the losing branch, excluding shared ancestors and the join", () => {
    // b1 won the race; the a-branch (a1, a2) is the losing scope.
    expect(losingBranchScope(EDGES, "join", "b1", "a2")).toEqual(new Set(["a1", "a2"]))
  })

  it("works symmetrically for the other branch", () => {
    expect(losingBranchScope(EDGES, "join", "a2", "b1")).toEqual(new Set(["b1"]))
  })

  it("never includes the shared fan-out / trigger nodes", () => {
    const scope = losingBranchScope(EDGES, "join", "b1", "a2")
    expect(scope.has("split")).toBe(false)
    expect(scope.has("trigger")).toBe(false)
    expect(scope.has("join")).toBe(false)
  })

  it("returns an empty scope when winner and loser share the whole path", () => {
    // Degenerate: loser IS an ancestor of the winner.
    expect(losingBranchScope(EDGES, "join", "a2", "a1")).toEqual(new Set())
  })
})
