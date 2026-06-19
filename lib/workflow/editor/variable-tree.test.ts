import { buildVariableTree, filterVarTree, type VarTreeNodeInput } from "./variable-tree"
import type { GraphEdgeLike } from "./upstream-graph"

const nodes: VarTreeNodeInput[] = [
  { id: "a", kind: "trigger.manual", label: "Start" },
  { id: "b", kind: "ai.prompt", label: "Draft" },
  { id: "c", kind: "ai.prompt", label: "Final" },
]
const edges: GraphEdgeLike[] = [
  { source: "a", target: "b" },
  { source: "b", target: "c" },
]

describe("buildVariableTree", () => {
  it("lists upstream nodes nearest-first with their flattened output fields", () => {
    const tree = buildVariableTree("c", nodes, edges, {
      b: { result: { text: "hi" }, count: 2 },
      a: { payload: 1 },
    })
    expect(tree.map((n) => n.nodeId)).toEqual(["b", "a"])
    const b = tree[0]
    expect(b.distance).toBe(1)
    expect(b.baseInsert).toBe("{{ $node['b'] }}")
    const paths = b.fields.map((f) => f.path)
    expect(paths).toContain("result")
    expect(paths).toContain("result.text")
    expect(paths).toContain("count")
    const textField = b.fields.find((f) => f.path === "result.text")!
    expect(textField.insert).toBe("{{ $node['b'].result.text }}")
    expect(textField.type).toBe("string")
  })

  it("includes a node with no resolved output (base ref only)", () => {
    const tree = buildVariableTree("c", nodes, edges, {})
    expect(tree.every((n) => n.fields.length === 0)).toBe(true)
    expect(tree.find((n) => n.nodeId === "a")?.baseInsert).toBe("{{ $node['a'] }}")
  })

  it("excludes the current node and downstream nodes", () => {
    const tree = buildVariableTree("b", nodes, edges, {})
    expect(tree.map((n) => n.nodeId)).toEqual(["a"]) // c is downstream, b is self
  })
})

describe("filterVarTree", () => {
  const tree = buildVariableTree("c", nodes, edges, {
    b: { result: { text: "hi" }, count: 2 },
    a: { payload: "x" },
  })

  it("returns the tree unchanged with no filter", () => {
    expect(filterVarTree(tree, {})).toBe(tree)
  })

  it("filters fields by query substring", () => {
    const filtered = filterVarTree(tree, { query: "text" })
    const b = filtered.find((n) => n.nodeId === "b")
    expect(b?.fields.map((f) => f.path)).toEqual(["result.text"])
  })

  it("keeps a node when its label matches the query even with no field match", () => {
    const filtered = filterVarTree(tree, { query: "Start" })
    expect(filtered.some((n) => n.nodeId === "a")).toBe(true)
  })

  it("filters fields by type", () => {
    const filtered = filterVarTree(tree, { type: "number" })
    const b = filtered.find((n) => n.nodeId === "b")
    expect(b?.fields.map((f) => f.path)).toEqual(["count"])
    // 'a' has only a string field → dropped under the number filter.
    expect(filtered.some((n) => n.nodeId === "a")).toBe(false)
  })
})
