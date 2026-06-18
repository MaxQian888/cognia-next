import { resolveLoadOrder, type LoadOrderPluginInput } from "./load-order"

// Convenience builder so each test reads as a small dependency declaration.
function plugin(
  id: string,
  opts: Partial<Omit<LoadOrderPluginInput, "id">> = {}
): LoadOrderPluginInput {
  return {
    id,
    version: opts.version ?? "1.0.0",
    status: opts.status ?? "installed",
    dependencies: opts.dependencies,
    optionalDependencies: opts.optionalDependencies,
  }
}

describe("resolveLoadOrder", () => {
  it("orders required dependencies before their dependents", () => {
    const { order, blocked, cycles } = resolveLoadOrder([
      plugin("b", { dependencies: { a: "^1.0.0" } }),
      plugin("a"),
      plugin("c", { dependencies: { b: "*" } }),
    ])
    expect(order).toEqual(["a", "b", "c"])
    expect(blocked.size).toBe(0)
    expect(cycles).toEqual([])
  })

  it("keeps independent plugins in input order (stable)", () => {
    const { order } = resolveLoadOrder([plugin("x"), plugin("y"), plugin("z")])
    expect(order).toEqual(["x", "y", "z"])
  })

  it("blocks a plugin whose required dependency is missing", () => {
    const { order, blocked } = resolveLoadOrder([plugin("b", { dependencies: { a: "^1.0.0" } })])
    expect(order).toEqual([])
    expect(blocked.get("b")).toEqual([{ kind: "missing", dependencyId: "a", constraint: "^1.0.0" }])
  })

  it("blocks a plugin whose required dependency is disabled", () => {
    const { order, blocked } = resolveLoadOrder([
      plugin("a", { status: "disabled" }),
      plugin("b", { dependencies: { a: "*" } }),
    ])
    expect(order).toEqual([])
    expect(blocked.get("b")).toEqual([{ kind: "disabled", dependencyId: "a", constraint: "*" }])
  })

  it("blocks on a version mismatch and reports the found version", () => {
    const { order, blocked } = resolveLoadOrder([
      plugin("a", { version: "1.5.0" }),
      plugin("b", { dependencies: { a: "^2.0.0" } }),
    ])
    expect(order).toEqual(["a"])
    expect(blocked.get("b")).toEqual([
      { kind: "version-mismatch", dependencyId: "a", constraint: "^2.0.0", found: "1.5.0" },
    ])
  })

  it("cascades: a dependent of a blocked plugin is blocked too", () => {
    const { order, blocked } = resolveLoadOrder([
      // a is missing → b blocked → c (requires b) blocked.
      plugin("b", { dependencies: { a: "*" } }),
      plugin("c", { dependencies: { b: "*" } }),
    ])
    expect(order).toEqual([])
    expect(blocked.get("b")?.[0]).toEqual({ kind: "missing", dependencyId: "a", constraint: "*" })
    expect(blocked.get("c")?.[0]).toEqual({ kind: "disabled", dependencyId: "b", constraint: "*" })
  })

  it("detects a cycle once and excludes its members from the order", () => {
    const { order, cycles, blocked } = resolveLoadOrder([
      plugin("a", { dependencies: { b: "*" } }),
      plugin("b", { dependencies: { a: "*" } }),
      plugin("c"),
    ])
    expect(order).toEqual(["c"])
    expect(cycles).toHaveLength(1)
    expect([...cycles[0]].sort()).toEqual(["a", "b"])
    // Members surface via `cycles`, not `blocked`.
    expect(blocked.has("a")).toBe(false)
    expect(blocked.has("b")).toBe(false)
  })

  it("detects a self-dependency as a cycle", () => {
    const { order, cycles } = resolveLoadOrder([plugin("a", { dependencies: { a: "*" } })])
    expect(order).toEqual([])
    expect(cycles).toEqual([["a"]])
  })

  it("treats a plugin requiring a cycle member as blocked with reason 'cycle'", () => {
    const { blocked } = resolveLoadOrder([
      plugin("a", { dependencies: { b: "*" } }),
      plugin("b", { dependencies: { a: "*" } }),
      plugin("d", { dependencies: { a: "*" } }),
    ])
    expect(blocked.get("d")).toEqual([{ kind: "cycle", dependencyId: "a", constraint: "*" }])
  })

  it("does not block on an unmet optional dependency — records it as degraded", () => {
    const { order, blocked, degraded } = resolveLoadOrder([
      plugin("b", { optionalDependencies: { a: "^1.0.0" } }),
    ])
    expect(order).toEqual(["b"])
    expect(blocked.size).toBe(0)
    expect(degraded.get("b")).toEqual(["a"])
  })

  it("clears the degraded mark once the optional dependency is satisfiable", () => {
    const { degraded } = resolveLoadOrder([
      plugin("a", { version: "1.2.0" }),
      plugin("b", { optionalDependencies: { a: "^1.0.0" } }),
    ])
    expect(degraded.has("b")).toBe(false)
  })

  it("marks an optional dep as degraded when present but version-mismatched", () => {
    const { order, degraded } = resolveLoadOrder([
      plugin("a", { version: "1.0.0" }),
      plugin("b", { optionalDependencies: { a: "^2.0.0" } }),
    ])
    expect(order).toEqual(["a", "b"])
    expect(degraded.get("b")).toEqual(["a"])
  })

  it("excludes plugins that are themselves disabled/errored from the order", () => {
    const { order } = resolveLoadOrder([
      plugin("a", { status: "disabled" }),
      plugin("b", { status: "error" }),
      plugin("c", { status: "installed" }),
    ])
    expect(order).toEqual(["c"])
  })

  describe("layers", () => {
    it("puts independent plugins in a single layer", () => {
      const { layers, order } = resolveLoadOrder([plugin("x"), plugin("y"), plugin("z")])
      expect(layers).toEqual([["x", "y", "z"]])
      expect(layers.flat()).toEqual(order)
    })

    it("splits a linear chain into one plugin per layer", () => {
      const { layers, order } = resolveLoadOrder([
        plugin("c", { dependencies: { b: "*" } }),
        plugin("b", { dependencies: { a: "*" } }),
        plugin("a"),
      ])
      expect(layers).toEqual([["a"], ["b"], ["c"]])
      expect(layers.flat()).toEqual(order)
    })

    it("groups a diamond into [[roots],[middles],[sink]]", () => {
      // a (root); b,c depend on a; d depends on b and c.
      const { layers, order } = resolveLoadOrder([
        plugin("a"),
        plugin("b", { dependencies: { a: "*" } }),
        plugin("c", { dependencies: { a: "*" } }),
        plugin("d", { dependencies: { b: "*", c: "*" } }),
      ])
      expect(layers).toEqual([["a"], ["b", "c"], ["d"]])
      expect(layers.flat()).toEqual(order)
    })

    it("excludes blocked and cyclic plugins from the layers", () => {
      const { layers, order } = resolveLoadOrder([
        plugin("a"),
        plugin("blocked", { dependencies: { missing: "*" } }),
        plugin("x", { dependencies: { y: "*" } }),
        plugin("y", { dependencies: { x: "*" } }), // x↔y cycle
      ])
      expect(layers.flat()).toEqual(order)
      expect(layers.flat()).toEqual(["a"])
    })
  })
})
