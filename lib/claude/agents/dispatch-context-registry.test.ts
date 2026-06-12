import {
  registerDispatchContext,
  getDispatchContext,
  clearDispatchContext,
  recordResolvedPermissionCeiling,
  getResolvedPermissionCeiling,
  clearResolvedPermissionCeiling,
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

  describe("resolved permission-ceiling registry", () => {
    it("records and reads a ceiling back by sessionId", () => {
      recordResolvedPermissionCeiling("s1", { allowedTools: ["Read"], permissionMode: "plan" })
      expect(getResolvedPermissionCeiling("s1")).toEqual({
        allowedTools: ["Read"],
        permissionMode: "plan",
      })
    })

    it("returns undefined for a session with no recorded ceiling", () => {
      expect(getResolvedPermissionCeiling("missing")).toBeUndefined()
    })

    it("replaces the ceiling on re-record (self-refresh each turn)", () => {
      recordResolvedPermissionCeiling("s1", { allowedTools: ["Read", "Bash"] })
      recordResolvedPermissionCeiling("s1", { allowedTools: ["Read"] })
      expect(getResolvedPermissionCeiling("s1")?.allowedTools).toEqual(["Read"])
    })

    it("clears one session's ceiling without touching others", () => {
      recordResolvedPermissionCeiling("s1", { allowedTools: ["Read"] })
      recordResolvedPermissionCeiling("s2", { allowedTools: ["Bash"] })
      clearResolvedPermissionCeiling("s1")
      expect(getResolvedPermissionCeiling("s1")).toBeUndefined()
      expect(getResolvedPermissionCeiling("s2")?.allowedTools).toEqual(["Bash"])
    })

    it("ignores an empty sessionId on record", () => {
      recordResolvedPermissionCeiling("", { allowedTools: ["Read"] })
      expect(getResolvedPermissionCeiling("")).toBeUndefined()
    })

    it("is wiped by the test-only reset alongside dispatch contexts", () => {
      recordResolvedPermissionCeiling("s1", { allowedTools: ["Read"] })
      __clearAllDispatchContextsForTesting()
      expect(getResolvedPermissionCeiling("s1")).toBeUndefined()
    })
  })
})
