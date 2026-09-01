import {
  BUILTIN_RUNTIME_REF,
  findRuntimeByKey,
  isSameRuntimeRef,
  runtimeRefKey,
  type AgentRuntimeDescriptor,
} from "./types"

describe("runtimeRefKey", () => {
  it("names each lane distinctly", () => {
    expect(runtimeRefKey({ kind: "builtin" })).toBe("builtin")
    expect(runtimeRefKey({ kind: "external", agentId: "a1" })).toBe("external:a1")
    expect(
      runtimeRefKey({ kind: "host", configId: "eac_1", revision: "r2", lifecycleGeneration: 3 })
    ).toBe("host:eac_1")
  })

  it("is lossy for a host ref, so nothing can rebuild one by parsing", () => {
    const a = { kind: "host", configId: "eac_1", revision: "r1", lifecycleGeneration: 1 } as const
    const b = { kind: "host", configId: "eac_1", revision: "r9", lifecycleGeneration: 4 } as const
    expect(runtimeRefKey(a)).toBe(runtimeRefKey(b))
  })
})

describe("isSameRuntimeRef", () => {
  it("compares the lane and the target, not the revision stamp", () => {
    expect(isSameRuntimeRef({ kind: "builtin" }, BUILTIN_RUNTIME_REF)).toBe(true)
    expect(
      isSameRuntimeRef({ kind: "external", agentId: "a1" }, { kind: "external", agentId: "a2" })
    ).toBe(false)
    expect(
      isSameRuntimeRef(
        { kind: "host", configId: "eac_1", revision: "r1", lifecycleGeneration: 1 },
        { kind: "host", configId: "eac_1", revision: "r2", lifecycleGeneration: 2 }
      )
    ).toBe(true)
  })

  it("the builtin adapter pin is inert: a pinned ref is the same lane as an unpinned one", () => {
    // Guards the documented dormancy on `AgentRuntimeRef.adapter`. If a future
    // change makes the pin meaningful, this assertion is the one that must be
    // revisited deliberately rather than the behaviour drifting.
    expect(isSameRuntimeRef({ kind: "builtin", adapter: "ai-sdk" }, BUILTIN_RUNTIME_REF)).toBe(true)
  })
})

describe("findRuntimeByKey", () => {
  const rows: AgentRuntimeDescriptor[] = [
    { ref: { kind: "builtin" }, key: "builtin", group: "builtin" },
    { ref: { kind: "external", agentId: "a1" }, key: "external:a1", group: "external" },
  ]

  it("resolves a row and answers undefined for an unknown key", () => {
    expect(findRuntimeByKey(rows, "external:a1")?.group).toBe("external")
    expect(findRuntimeByKey(rows, "external:gone")).toBeUndefined()
  })
})
