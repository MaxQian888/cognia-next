import {
  registerDispatchContext,
  getDispatchContext,
  clearDispatchContext,
  __clearAllDispatchContextsForTesting,
  type DispatchContext,
} from "./dispatch-context-registry"

const ctx = (over: Partial<DispatchContext> = {}): DispatchContext => ({
  depth: 1,
  maxDepth: 2,
  parentChain: ["root"],
  ...over,
})

describe("dispatch-context-registry", () => {
  beforeEach(() => {
    __clearAllDispatchContextsForTesting()
  })

  it("registers and reads a context back by sessionId", () => {
    registerDispatchContext("s1", ctx({ depth: 2, parentChain: ["a", "b"] }))
    const got = getDispatchContext("s1")
    expect(got).toEqual({ depth: 2, maxDepth: 2, parentChain: ["a", "b"] })
  })

  it("returns undefined for an unknown session (top-level chat)", () => {
    expect(getDispatchContext("missing")).toBeUndefined()
  })

  it("replaces an existing entry on re-register", () => {
    registerDispatchContext("s1", ctx({ depth: 1 }))
    registerDispatchContext("s1", ctx({ depth: 2 }))
    expect(getDispatchContext("s1")?.depth).toBe(2)
  })

  it("clears a single session without touching others", () => {
    registerDispatchContext("s1", ctx())
    registerDispatchContext("s2", ctx({ depth: 2 }))
    clearDispatchContext("s1")
    expect(getDispatchContext("s1")).toBeUndefined()
    expect(getDispatchContext("s2")?.depth).toBe(2)
  })

  it("ignores empty sessionId on register", () => {
    registerDispatchContext("", ctx())
    expect(getDispatchContext("")).toBeUndefined()
  })

  it("carries optional deadline / budget keys", () => {
    registerDispatchContext("s1", ctx({ deadlineMs: 123, budgetRootRunId: "root-run" }))
    const got = getDispatchContext("s1")
    expect(got?.deadlineMs).toBe(123)
    expect(got?.budgetRootRunId).toBe("root-run")
  })
})
