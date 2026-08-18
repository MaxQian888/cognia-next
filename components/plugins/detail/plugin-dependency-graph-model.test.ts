import type { ResolutionResult } from "@/lib/plugin/package/dependency-resolver"
import { buildDependencyGraph } from "./plugin-dependency-graph-model"

function result(partial: Partial<ResolutionResult> = {}): ResolutionResult {
  return {
    success: true,
    resolved: [],
    missing: [],
    conflicts: [],
    installOrder: [],
    warnings: [],
    ...partial,
  }
}

const dep = (id: string, over: Partial<ResolutionResult["resolved"][number]> = {}) => ({
  id,
  version: "1.0.0",
  constraint: "^1.0.0",
  satisfies: true,
  source: "installed" as const,
  ...over,
})

describe("buildDependencyGraph", () => {
  it("renders a lone root for a plugin with no dependencies", () => {
    const model = buildDependencyGraph("root-plugin", result())
    expect(model.nodes).toHaveLength(1)
    expect(model.nodes[0]).toMatchObject({ id: "root-plugin", kind: "root", rank: 0 })
    expect(model.edges).toEqual([])
  })

  it("draws an edge from the root to each resolved dependency", () => {
    const model = buildDependencyGraph(
      "root",
      result({ resolved: [dep("a"), dep("b")], installOrder: ["a", "b"] })
    )
    expect(model.edges.map((e) => e.target).sort()).toEqual(["a", "b"])
    expect(model.edges.every((e) => e.source === "root")).toBe(true)
  })

  it("labels edges with the declared constraint", () => {
    const model = buildDependencyGraph(
      "root",
      result({ resolved: [dep("a", { constraint: "~2.1.0" })], installOrder: ["a"] })
    )
    expect(model.edges[0].label).toBe("~2.1.0")
  })

  /**
   * `installOrder` is the resolver's topological sort, so ranking by it is what
   * makes every edge point downward — the fact the old flat lists discarded.
   */
  it("ranks dependencies by the resolver's install order", () => {
    const model = buildDependencyGraph(
      "root",
      result({
        resolved: [dep("c"), dep("a"), dep("b")],
        installOrder: ["a", "b", "c"],
      })
    )
    const rank = (id: string) => model.nodes.find((n) => n.id === id)!.rank
    expect(rank("a")).toBeLessThan(rank("b"))
    expect(rank("b")).toBeLessThan(rank("c"))
    expect(rank("root")).toBe(0)
  })

  it("puts deeper ranks lower on the canvas", () => {
    const model = buildDependencyGraph(
      "root",
      result({ resolved: [dep("a"), dep("b")], installOrder: ["a", "b"] })
    )
    const y = (id: string) => model.nodes.find((n) => n.id === id)!.position.y
    expect(y("root")).toBeLessThan(y("a"))
    expect(y("a")).toBeLessThan(y("b"))
  })

  it("spreads same-rank nodes across a centred row", () => {
    const model = buildDependencyGraph(
      "root",
      result({ resolved: [dep("a"), dep("b")], installOrder: [] })
    )
    const a = model.nodes.find((n) => n.id === "a")!
    const b = model.nodes.find((n) => n.id === "b")!
    expect(a.rank).toBe(b.rank)
    expect(a.position.y).toBe(b.position.y)
    expect(a.position.x).not.toBe(b.position.x)
    expect(a.position.x + b.position.x).toBe(0)
  })

  it("marks an unsatisfied dependency distinctly from a satisfied one", () => {
    const model = buildDependencyGraph(
      "root",
      result({ resolved: [dep("a"), dep("b", { satisfies: false })], installOrder: ["a", "b"] })
    )
    expect(model.nodes.find((n) => n.id === "a")!.kind).toBe("resolved")
    expect(model.nodes.find((n) => n.id === "b")!.kind).toBe("unsatisfied")
  })

  it("adds missing dependencies as their own node kind", () => {
    const model = buildDependencyGraph("root", result({ missing: ["gone"], success: false }))
    expect(model.nodes.find((n) => n.id === "gone")!.kind).toBe("missing")
    expect(model.edges.find((e) => e.target === "gone")!.conflicted).toBe(true)
  })

  /**
   * The reason this is a graph at all: a conflict is a disagreement *between
   * two dependents* about one dependency, which four flat lists cannot express.
   */
  it("draws an edge from every plugin that demanded a conflicted dependency", () => {
    const model = buildDependencyGraph(
      "root",
      result({
        success: false,
        resolved: [dep("shared", { satisfies: false })],
        installOrder: ["shared"],
        conflicts: [
          {
            dependencyId: "shared",
            requiredBy: [
              { pluginId: "root", constraint: "^1.0.0" },
              { pluginId: "other", constraint: "^2.0.0" },
            ],
            reason: "incompatible ranges",
          },
        ],
      })
    )
    const intoShared = model.edges.filter((e) => e.target === "shared")
    expect(intoShared.map((e) => e.source).sort()).toEqual(["other", "root"])
    expect(intoShared.every((e) => e.conflicted)).toBe(true)
    expect(intoShared.find((e) => e.source === "other")!.label).toBe("^2.0.0")
  })

  it("materialises a requiring plugin that is not otherwise in the graph", () => {
    const model = buildDependencyGraph(
      "root",
      result({
        success: false,
        resolved: [dep("shared")],
        conflicts: [
          {
            dependencyId: "shared",
            requiredBy: [{ pluginId: "stranger", constraint: "^3.0.0" }],
            reason: "x",
          },
        ],
      })
    )
    expect(model.nodes.some((n) => n.id === "stranger")).toBe(true)
  })

  it("marks a conflicted dependency even when it otherwise resolved", () => {
    const model = buildDependencyGraph(
      "root",
      result({
        resolved: [dep("shared")],
        conflicts: [{ dependencyId: "shared", requiredBy: [], reason: "x" }],
      })
    )
    expect(model.nodes.find((n) => n.id === "shared")!.kind).toBe("conflicted")
  })

  it("never emits a duplicate edge for the same pair", () => {
    const model = buildDependencyGraph(
      "root",
      result({
        resolved: [dep("shared")],
        conflicts: [
          {
            dependencyId: "shared",
            requiredBy: [{ pluginId: "root", constraint: "^1" }],
            reason: "x",
          },
        ],
      })
    )
    expect(new Set(model.edges.map((e) => e.id)).size).toBe(model.edges.length)
  })

  it("grows its height with the number of ranks", () => {
    const shallow = buildDependencyGraph(
      "root",
      result({ resolved: [dep("a")], installOrder: ["a"] })
    )
    const deep = buildDependencyGraph(
      "root",
      result({ resolved: [dep("a"), dep("b")], installOrder: ["a", "b"] })
    )
    expect(deep.height).toBeGreaterThan(shallow.height)
  })

  /** Same input, same picture — otherwise the graph churns on every render. */
  it("is deterministic", () => {
    const input = result({ resolved: [dep("a"), dep("b")], installOrder: ["a", "b"] })
    expect(buildDependencyGraph("root", input)).toEqual(buildDependencyGraph("root", input))
  })
})
