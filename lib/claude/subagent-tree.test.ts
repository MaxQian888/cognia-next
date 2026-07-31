import { buildSubagentTree, type SubagentTreeNode } from "./subagent-tree"

/** Local DFS flatten (roots first) — used to assert traversal/cycle behavior. */
function flatten(nodes: SubagentTreeNode[]): SubagentTreeNode[] {
  const out: SubagentTreeNode[] = []
  const walk = (n: SubagentTreeNode) => {
    out.push(n)
    for (const c of n.children) walk(c)
  }
  for (const n of nodes) walk(n)
  return out
}
import type { SubagentPart } from "./parts-extensions"

const part = (over: Partial<SubagentPart> & { subagentId: string }): SubagentPart => ({
  type: "subagent",
  parentSessionId: "s",
  name: over.subagentId,
  status: "completed",
  progress: 100,
  startedAt: 0,
  ...over,
})

describe("buildSubagentTree", () => {
  it("returns [] for no subagent parts", () => {
    expect(buildSubagentTree([])).toEqual([])
    expect(buildSubagentTree(undefined)).toEqual([])
    expect(buildSubagentTree([{ type: "text", text: "x" }])).toEqual([])
  })

  it("nests parent → child → grandchild", () => {
    const tree = buildSubagentTree([
      part({ subagentId: "a", startedAt: 1 }),
      part({ subagentId: "b", parentSubagentId: "a", startedAt: 2 }),
      part({ subagentId: "c", parentSubagentId: "b", startedAt: 3 }),
    ])
    expect(tree).toHaveLength(1)
    expect(tree[0].part.subagentId).toBe("a")
    expect(tree[0].depth).toBe(1)
    expect(tree[0].children[0].part.subagentId).toBe("b")
    expect(tree[0].children[0].depth).toBe(2)
    expect(tree[0].children[0].children[0].part.subagentId).toBe("c")
    expect(tree[0].children[0].children[0].depth).toBe(3)
  })

  it("groups sibling fan-out under one parent in startedAt order", () => {
    const tree = buildSubagentTree([
      part({ subagentId: "a", startedAt: 1 }),
      part({ subagentId: "c2", parentSubagentId: "a", startedAt: 3 }),
      part({ subagentId: "c1", parentSubagentId: "a", startedAt: 2 }),
    ])
    expect(tree[0].children.map((c) => c.part.subagentId)).toEqual(["c1", "c2"])
  })

  it("treats a part with a missing parent as a root", () => {
    const tree = buildSubagentTree([part({ subagentId: "orphan", parentSubagentId: "ghost" })])
    expect(tree).toHaveLength(1)
    expect(tree[0].part.subagentId).toBe("orphan")
  })

  it("prefers part.depth over the computed depth", () => {
    const tree = buildSubagentTree([part({ subagentId: "a", depth: 5 })])
    expect(tree[0].depth).toBe(5)
  })

  it("terminates on a 2-cycle and still surfaces both nodes", () => {
    const tree = buildSubagentTree([
      part({ subagentId: "a", parentSubagentId: "b" }),
      part({ subagentId: "b", parentSubagentId: "a" }),
    ])
    const ids = flatten(tree)
      .map((n) => n.part.subagentId)
      .sort()
    expect(ids).toContain("a")
    expect(ids).toContain("b")
  })

  it("ignores a self-parent edge (treated as root)", () => {
    const tree = buildSubagentTree([part({ subagentId: "a", parentSubagentId: "a" })])
    expect(tree).toHaveLength(1)
    expect(tree[0].children).toEqual([])
  })

  it("flattens depth-first, roots first", () => {
    const tree = buildSubagentTree([
      part({ subagentId: "a", startedAt: 1 }),
      part({ subagentId: "b", parentSubagentId: "a", startedAt: 2 }),
      part({ subagentId: "d", startedAt: 4 }),
    ])
    expect(flatten(tree).map((n) => n.part.subagentId)).toEqual(["a", "b", "d"])
  })
})
