import { byProjectId, scopedWorkspaceId, DEMOTED_SCORE_FACTOR } from "./workspace-scope"

const ctx = (activeProjectId: string | null) => ({ activeProjectId })

describe("scopedWorkspaceId", () => {
  it("scopes to the active workspace by default", () => {
    expect(scopedWorkspaceId({ filters: {} }, ctx("w1"))).toBe("w1")
  })

  it("scopes to the active workspace for an explicit workspace:current", () => {
    expect(scopedWorkspaceId({ filters: { workspace: "current" } }, ctx("w1"))).toBe("w1")
  })

  it("widens for workspace:all", () => {
    expect(scopedWorkspaceId({ filters: { workspace: "all" } }, ctx("w1"))).toBeNull()
  })

  it("widens when there is no workspace to scope to", () => {
    // An id-less filter would silently match nothing, which reads as a broken
    // search rather than a focused one.
    expect(scopedWorkspaceId({ filters: { workspace: "current" } }, ctx(null))).toBeNull()
  })

  it("tolerates a query with no filters object at all", () => {
    expect(scopedWorkspaceId({ filters: undefined as never }, ctx("w1"))).toBe("w1")
  })
})

describe("byProjectId", () => {
  const belongs = byProjectId<{ projectId?: string }>((row) => row.projectId)

  it("keeps a row from the workspace being searched", () => {
    expect(belongs({ projectId: "w1" }, null, "w1")).toBe(true)
  })

  it("rejects a row from another workspace", () => {
    expect(belongs({ projectId: "w2" }, null, "w1")).toBe(false)
  })

  it("keeps a row that names no workspace", () => {
    // Shared, not foreign — hiding these would lose every legacy row written
    // before the column existed, which is what makes a scoped search feel
    // broken rather than focused.
    expect(belongs({}, null, "w1")).toBe(true)
    expect(belongs({ projectId: "" }, null, "w1")).toBe(true)
  })
})

describe("DEMOTED_SCORE_FACTOR", () => {
  it("ranks a demoted hit below an in-scope one without zeroing it", () => {
    // Multiplying keeps ordering inside the demoted group; zeroing would make
    // the definition layer unfindable, which is the thing demotion avoids.
    expect(DEMOTED_SCORE_FACTOR).toBeGreaterThan(0)
    expect(DEMOTED_SCORE_FACTOR).toBeLessThan(1)
  })
})
