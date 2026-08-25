import { TopologyError, linearChain, topologicalOrder } from "./topology"

function node(id: string, dependsOn: string[] = [], order = 0, tieBreaker?: string) {
  return { id, dependsOn, order, ...(tieBreaker ? { tieBreaker } : {}) }
}

describe("topologicalOrder", () => {
  it("puts every dependency before what needs it", () => {
    const ordered = topologicalOrder([node("c", ["b"], 2), node("a", [], 0), node("b", ["a"], 1)])
    expect(ordered.map((entry) => entry.id)).toEqual(["a", "b", "c"])
  })

  it("orders a multi-root graph deterministically", () => {
    // Two runs producing different sequences makes a publish that fails
    // halfway impossible to reason about.
    const nodes = [
      node("api-1", [], 0, "api"),
      node("web-1", [], 0, "web"),
      node("web-2", ["web-1"], 1, "web"),
      node("api-2", ["api-1"], 1, "api"),
    ]
    const first = topologicalOrder(nodes).map((entry) => entry.id)
    const second = topologicalOrder([...nodes].reverse()).map((entry) => entry.id)
    expect(first).toEqual(second)
    expect(first).toEqual(["api-1", "web-1", "api-2", "web-2"])
  })

  it("names the unknown dependency instead of dropping the node", () => {
    let thrown: unknown
    try {
      topologicalOrder([node("a", ["ghost"])])
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(TopologyError)
    expect((thrown as TopologyError).message).toContain("ghost")
    expect((thrown as TopologyError).nodes).toEqual(["ghost"])
  })

  it("names every node stuck in a cycle", () => {
    let thrown: unknown
    try {
      topologicalOrder([node("a", ["c"]), node("b", ["a"]), node("c", ["b"])])
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(TopologyError)
    expect([...(thrown as TopologyError).nodes].sort()).toEqual(["a", "b", "c"])
  })

  it("handles an empty graph", () => {
    expect(topologicalOrder([])).toEqual([])
  })
})

describe("linearChain", () => {
  it("returns the chain bottom first", () => {
    const chain = linearChain([node("c", ["b"], 2), node("a", [], 0), node("b", ["a"], 1)])
    expect(chain?.map((entry) => entry.id)).toEqual(["a", "b", "c"])
  })

  it("refuses a fork, because restacking one would silently drop the sibling", () => {
    expect(linearChain([node("a"), node("b", ["a"]), node("c", ["a"])])).toBeNull()
  })

  it("refuses a merge, where one layer has two parents", () => {
    expect(linearChain([node("a"), node("b"), node("c", ["a", "b"])])).toBeNull()
  })

  it("refuses two disconnected chains", () => {
    expect(linearChain([node("a"), node("b", ["a"]), node("x"), node("y", ["x"])])).toBeNull()
  })

  it("is empty for no nodes and single for one", () => {
    expect(linearChain([])).toEqual([])
    expect(linearChain([node("only")])?.map((entry) => entry.id)).toEqual(["only"])
  })
})
