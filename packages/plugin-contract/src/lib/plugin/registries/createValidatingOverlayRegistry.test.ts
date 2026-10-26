import {
  createValidatingOverlayRegistry,
  type ValidatingOverlayRegistry,
} from "./createValidatingOverlayRegistry"

interface TestEntry {
  id: string
  deps: string[]
}
interface TestWarning {
  missing: string
}

describe("createValidatingOverlayRegistry", () => {
  // Validate against a mutable "available" set so refreshAllWarnings can be
  // exercised the way the real registries use it (a sibling registry gains a
  // dependency, the warning clears on refresh).
  let available: Set<string>
  let reg: ValidatingOverlayRegistry<TestEntry, TestWarning>

  beforeEach(() => {
    available = new Set<string>()
    reg = createValidatingOverlayRegistry<TestEntry, TestWarning>({
      name: "test",
      validate: (entry) =>
        entry.deps.filter((d) => !available.has(d)).map((missing) => ({ missing })),
    })
  })

  it("registers an entry and stamps warnings for unmet deps", () => {
    const prev = reg.register("a", { id: "a", deps: ["x", "y"] }, { pluginId: "p1" })
    expect(prev).toBeUndefined()
    expect(reg.get("a")).toEqual({ id: "a", deps: ["x", "y"] })
    expect(reg.getWarnings("a")).toEqual([{ missing: "x" }, { missing: "y" }])
  })

  it("returns an empty array (never undefined) for clean / unknown ids", () => {
    available.add("x")
    reg.register("a", { id: "a", deps: ["x"] }, { pluginId: "p1" })
    expect(reg.getWarnings("a")).toEqual([])
    expect(reg.getWarnings("never-registered")).toEqual([])
  })

  it("returns the previous entry on re-register (collision signal)", () => {
    reg.register("a", { id: "a", deps: [] }, { pluginId: "p1" })
    const prev = reg.register("a", { id: "a", deps: ["z"] }, { pluginId: "p1" })
    expect(prev?.entry).toEqual({ id: "a", deps: [] })
    expect(reg.getWarnings("a")).toEqual([{ missing: "z" }])
  })

  it("refreshAllWarnings clears a warning once the dependency becomes available", () => {
    reg.register("a", { id: "a", deps: ["x"] }, { pluginId: "p1" })
    expect(reg.getWarnings("a")).toEqual([{ missing: "x" }])

    available.add("x")
    reg.refreshAllWarnings()
    expect(reg.getWarnings("a")).toEqual([])
  })

  it("unregisterById drops the entry and its warnings", () => {
    reg.register("a", { id: "a", deps: ["x"] }, { pluginId: "p1" })
    expect(reg.unregisterById("a")).toBe(true)
    expect(reg.get("a")).toBeUndefined()
    expect(reg.getWarnings("a")).toEqual([])
    expect(reg.unregisterById("a")).toBe(false)
  })

  it("unregisterByPlugin drops every entry + warnings for the plugin and returns the count", () => {
    reg.register("a", { id: "a", deps: ["x"] }, { pluginId: "p1" })
    reg.register("b", { id: "b", deps: ["y"] }, { pluginId: "p1" })
    reg.register("c", { id: "c", deps: ["z"] }, { pluginId: "p2" })

    expect(reg.unregisterByPlugin("p1")).toBe(2)
    expect(reg.get("a")).toBeUndefined()
    expect(reg.getWarnings("a")).toEqual([])
    expect(reg.getWarnings("b")).toEqual([])
    // p2 untouched.
    expect(reg.get("c")).toEqual({ id: "c", deps: ["z"] })
    expect(reg.getWarnings("c")).toEqual([{ missing: "z" }])
  })

  it("list / entries reflect registration order", () => {
    reg.register("a", { id: "a", deps: [] }, { pluginId: "p1" })
    reg.register("b", { id: "b", deps: [] }, { pluginId: "p2" })
    expect(reg.list()).toEqual(["a", "b"])
    expect(reg.entries().map((e) => e.id)).toEqual(["a", "b"])
  })

  it("freezes the stamped warnings array", () => {
    reg.register("a", { id: "a", deps: ["x"] }, { pluginId: "p1" })
    const warnings = reg.getWarnings("a")
    expect(Object.isFrozen(warnings)).toBe(true)
  })

  it("__resetForTesting clears entries and warnings", () => {
    reg.register("a", { id: "a", deps: ["x"] }, { pluginId: "p1" })
    reg.__resetForTesting()
    expect(reg.list()).toEqual([])
    expect(reg.getWarnings("a")).toEqual([])
  })
})

// ── W4.4: hardValidate rejects structurally-broken contributions ─────────────
describe("hardValidate (W4.4)", () => {
  it("throws on a structurally broken entry and never registers it", () => {
    const reg = createValidatingOverlayRegistry<{ name?: string }, string>({
      name: "test-hard",
      validate: () => [],
      hardValidate: (entry) => (entry.name ? [] : ["missing name"]),
    })
    expect(() => reg.register("bad", {})).toThrow(/test-hard rejected "bad": missing name/)
    expect(reg.get("bad")).toBeUndefined()
    expect(() => reg.register("good", { name: "ok" })).not.toThrow()
    expect(reg.get("good")).toEqual({ name: "ok" })
  })

  it("keeps soft warnings advisory (entry still registers)", () => {
    const reg = createValidatingOverlayRegistry<{ dep?: string }, string>({
      name: "test-soft",
      validate: (entry) => (entry.dep ? [] : ["missing dep"]),
    })
    reg.register("warned", {})
    expect(reg.get("warned")).toEqual({})
    expect(reg.getWarnings("warned")).toEqual(["missing dep"])
  })
})
