/**
 * `issue.list_projects` — the resolver the assistant calls before `issue_create`
 * so a project NAME becomes the id the write path needs.
 */
const mockListIssueProjects = jest.fn(async (..._a: unknown[]): Promise<unknown[]> => [])
jest.mock("@/lib/db/issue-projects", () => ({
  listIssueProjects: (...a: unknown[]) => mockListIssueProjects(...a),
}))

const mockEnsureDefaultProject = jest.fn(async () => ({ id: "ws_default" }))
jest.mock("@/lib/db/project-scope", () => ({
  ensureDefaultProject: () => mockEnsureDefaultProject(),
}))

let activeProjectId: string | null = null
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ activeProjectId }) },
}))

import { getSharedBuiltInSkillRegistry } from "../registry"
import type { BuiltInSkillContext } from "../types"
import "./list-projects"

function project(over: Record<string, unknown> = {}) {
  return {
    id: "ip_1",
    projectId: "ws_1",
    key: "MER",
    name: "Mercury",
    status: "active",
    updatedAt: 1,
    ...over,
  }
}

const skill = getSharedBuiltInSkillRegistry().get("issue.list_projects")!
const ctx = { sessionId: "s1" } as BuiltInSkillContext
const run = (args: { query?: string }) =>
  skill.execute(args as never, ctx) as Promise<{
    workspaceId: string
    projects: Array<{ id: string; key: string; name: string; status: string }>
  }>

beforeEach(() => {
  activeProjectId = "ws_1"
  mockListIssueProjects.mockResolvedValue([])
})

describe("issue.list_projects", () => {
  it("is registered as a read skill with no HITL surface", () => {
    expect(skill).toBeDefined()
    expect(skill.mutation).toBe("read")
    expect(skill.hitlSurface).toBeUndefined()
  })

  it("scopes the query to the active workspace", async () => {
    await run({})
    expect(mockListIssueProjects).toHaveBeenCalledWith({ projectId: "ws_1" })
  })

  it("falls back to the default workspace when no project is active", async () => {
    activeProjectId = null
    const out = await run({})
    expect(mockEnsureDefaultProject).toHaveBeenCalled()
    expect(mockListIssueProjects).toHaveBeenCalledWith({ projectId: "ws_default" })
    expect(out.workspaceId).toBe("ws_default")
  })

  it("projects each row down to id/key/name/status — nothing else leaks to the model", async () => {
    mockListIssueProjects.mockResolvedValue([project({ description: "secret" })])
    const out = await run({})
    expect(out.projects).toEqual([{ id: "ip_1", key: "MER", name: "Mercury", status: "active" }])
  })

  it("filters case-insensitively on name or key", async () => {
    mockListIssueProjects.mockResolvedValue([
      project({ id: "ip_1", key: "MER", name: "Mercury" }),
      project({ id: "ip_2", key: "VEN", name: "Venus" }),
    ])
    await expect(run({ query: "mercury" })).resolves.toMatchObject({
      projects: [expect.objectContaining({ id: "ip_1" })],
    })
    await expect(run({ query: "ven" })).resolves.toMatchObject({
      projects: [expect.objectContaining({ id: "ip_2" })],
    })
  })

  it("treats a blank query as no filter", async () => {
    mockListIssueProjects.mockResolvedValue([project({ id: "ip_1" }), project({ id: "ip_2" })])
    await expect(run({ query: "   " })).resolves.toMatchObject({
      projects: [expect.anything(), expect.anything()],
    })
  })

  it("returns the most recently touched project first", async () => {
    mockListIssueProjects.mockResolvedValue([
      project({ id: "ip_old", name: "Old", updatedAt: 1 }),
      project({ id: "ip_new", name: "New", updatedAt: 9 }),
    ])
    const out = await run({})
    expect(out.projects.map((p) => p.id)).toEqual(["ip_new", "ip_old"])
  })

  it("returns an empty list rather than throwing when the workspace has no projects", async () => {
    await expect(run({})).resolves.toEqual({ workspaceId: "ws_1", projects: [] })
  })

  it("accepts an omitted query — the schema makes it optional", () => {
    expect(skill.inputSchema.safeParse({}).success).toBe(true)
    expect(skill.inputSchema.safeParse({ query: "mer" }).success).toBe(true)
  })
})
