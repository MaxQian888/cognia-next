import type { Project } from "@/types"
import { useProjectStore } from "@/stores/project/project-store"
import { getProject, updateCoordinator } from "./project-access"

function project(overrides: Partial<Project> = {}): Project {
  const now = new Date()
  return {
    id: "p1",
    name: "Workspace",
    roots: [],
    knowledgeBase: [],
    sessionIds: [],
    sessionCount: 0,
    messageCount: 0,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    ...overrides,
  }
}

describe("project-access", () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [project()] })
  })

  it("reads a workspace from the store", () => {
    expect(getProject("p1")?.name).toBe("Workspace")
    expect(getProject("nope")).toBeUndefined()
  })

  it("merges a coordinator patch through the store", () => {
    updateCoordinator("p1", { enabled: true, preferences: { dailyThreadCap: 3 } })
    const next = updateCoordinator("p1", { preferences: { autoFixPr: true } })
    expect(next.coordinator).toEqual({
      enabled: true,
      preferences: { dailyThreadCap: 3, autoFixPr: true },
    })
    expect(getProject("p1")?.coordinator?.enabled).toBe(true)
  })

  it("throws for an unknown workspace", () => {
    expect(() => updateCoordinator("nope", { enabled: true })).toThrow(/nope/)
  })
})
