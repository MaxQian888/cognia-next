import { buildDefaultProject, DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME } from "./project-defaults"

describe("project-defaults", () => {
  it("exposes a stable default workspace id + name", () => {
    expect(DEFAULT_PROJECT_ID).toBe("project-default")
    expect(DEFAULT_PROJECT_NAME).toBe("Default")
  })

  it("builds a valid, empty Default workspace row", () => {
    const p = buildDefaultProject(1_700_000_000_000)
    expect(p.id).toBe(DEFAULT_PROJECT_ID)
    expect(p.name).toBe(DEFAULT_PROJECT_NAME)
    expect(p.roots).toEqual([])
    expect(p.knowledgeBase).toEqual([])
    expect(p.sessionIds).toEqual([])
    expect(p.sessionCount).toBe(0)
    expect(p.messageCount).toBe(0)
    expect(p.isArchived).toBe(false)
    expect(p.createdAt).toBeInstanceOf(Date)
    expect(p.createdAt.getTime()).toBe(1_700_000_000_000)
    expect(p.updatedAt.getTime()).toBe(1_700_000_000_000)
    expect(p.lastAccessedAt.getTime()).toBe(1_700_000_000_000)
  })

  it("defaults the timestamp to now when omitted", () => {
    const before = Date.now()
    const p = buildDefaultProject()
    expect(p.createdAt.getTime()).toBeGreaterThanOrEqual(before)
  })
})
