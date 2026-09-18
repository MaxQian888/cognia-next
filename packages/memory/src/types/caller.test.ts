import { memoryRowWithinNamespaces, narrowNamespaceValue } from "./caller"

describe("memoryRowWithinNamespaces", () => {
  it("admits every row for an unconstrained caller", () => {
    expect(memoryRowWithinNamespaces({ projectId: "p1", agentId: "a1" }, undefined)).toBe(true)
  })

  it("admits a row whose carried namespaces are all authorized", () => {
    const namespaces = { projects: ["p1", "p2"], agentIds: ["a1"] }
    expect(memoryRowWithinNamespaces({ projectId: "p1", agentId: "a1" }, namespaces)).toBe(true)
  })

  it("denies a row carrying a namespace outside the caller's set", () => {
    expect(memoryRowWithinNamespaces({ projectId: "p9" }, { projects: ["p1"] })).toBe(false)
    expect(memoryRowWithinNamespaces({ characterId: "c9" }, { characterIds: ["c1"] })).toBe(false)
    expect(memoryRowWithinNamespaces({ agentId: "a9" }, { agentIds: ["a1"] })).toBe(false)
  })

  it("does not constrain a namespace field the row does not carry", () => {
    // A global row has no projectId — it is not project data.
    expect(memoryRowWithinNamespaces({}, { projects: ["p1"] })).toBe(true)
  })

  it("does not constrain a namespace class the caller's set leaves open", () => {
    expect(memoryRowWithinNamespaces({ projectId: "p9" }, { agentIds: ["a1"] })).toBe(true)
  })

  it("treats an empty set as fully closed for that class", () => {
    expect(memoryRowWithinNamespaces({ projectId: "p1" }, { projects: [] })).toBe(false)
  })
})

describe("narrowNamespaceValue", () => {
  it("passes through an absent request value", () => {
    expect(narrowNamespaceValue(undefined, ["p1"])).toBeUndefined()
    expect(narrowNamespaceValue(undefined, undefined)).toBeUndefined()
  })

  it("passes through a requested value when the class is unconstrained", () => {
    expect(narrowNamespaceValue("p9", undefined)).toBe("p9")
  })

  it("passes through a requested value inside the caller's set", () => {
    expect(narrowNamespaceValue("p1", ["p1", "p2"])).toBe("p1")
  })

  it("fails closed (null) on a value outside the caller's set", () => {
    expect(narrowNamespaceValue("p9", ["p1"])).toBeNull()
  })
})
