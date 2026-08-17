/**
 * @jest-environment jsdom
 */

const mockPropose = jest.fn()
jest.mock("@/lib/issues/im/propose", () => ({
  proposeIssueFromIm: (...a: unknown[]) => mockPropose(...a),
}))
const mockPushCard = jest.fn()
jest.mock("@/lib/issues/im/push", () => ({
  pushIssueCard: (...a: unknown[]) => mockPushCard(...a),
}))
let activeProjectId: string | null = "w1"
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ activeProjectId }) },
}))
jest.mock("@/lib/db/project-scope", () => ({
  ensureDefaultProject: async () => ({ id: "w-default" }),
}))

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createIssueProject } from "@/lib/db/issue-projects"
import { getIssue } from "@/lib/db/issues"
import { getSharedBuiltInSkillRegistry } from "../registry"
import "./index"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)
beforeEach(() => {
  jest.clearAllMocks()
  activeProjectId = "w1"
  mockPropose.mockResolvedValue({
    status: "proposed",
    draftId: "d1",
    surfaceId: "s",
    projectIds: [],
  })
  mockPushCard.mockResolvedValue({ status: "sent", surfaceId: "s" })
})

const registry = getSharedBuiltInSkillRegistry()
const create = registry.get("issue.create")!
const list = registry.get("issue.list_projects")!
const IM = { adapterId: "lark-1", platform: "lark" as const, conversationKey: "lark:lark-1:oc_1" }

describe("issue family registration", () => {
  it("registers both skills with the expected tiers", () => {
    expect(create).toBeDefined()
    expect(create.mutation).toBe("write")
    expect(create.mcpToolName).toBe("issue_create")
    expect(create.hitlSurface).toBeDefined()
    expect(list.mutation).toBe("read")
    expect(list.mcpToolName).toBe("issue_list_projects")
    expect(
      registry
        .list()
        .filter((s) => s.family === "issue")
        .map((s) => s.id)
        .sort()
    ).toEqual(["issue.create", "issue.list_projects"])
  })
})

describe("issue.create", () => {
  it("proposes on IM when no project is named, and writes nothing", async () => {
    const out = await create.execute(
      { title: "Fix it", description: "d", sourceMessageId: "m1" },
      { sessionId: "s", imBinding: IM }
    )
    expect(out).toMatchObject({ status: "pending", draftId: "d1" })
    expect(mockPropose).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: "lark-1",
        conversationKey: IM.conversationKey,
        workspaceId: "w1",
        title: "Fix it",
        description: "d",
        sourceMessageId: "m1",
      })
    )
    mockPropose.mockResolvedValueOnce({ status: "no-projects" })
    expect(await create.execute({ title: "x" }, { sessionId: "s", imBinding: IM })).toEqual({
      status: "no-projects",
    })
  })

  it("files directly with an explicit project on IM, stamps the origin, replies a card", async () => {
    const project = await createIssueProject({ projectId: "w1", name: "M", key: "MERC" })
    const out = (await create.execute(
      { title: "Named", issueProjectId: project.id, sourceMessageId: "m2" },
      { sessionId: "s", imBinding: IM, hitlBypass: true }
    )) as { status: string; issueId: string; identifier: string }
    expect(out.status).toBe("created")
    expect(out.identifier).toBe("MERC-1")
    const row = (await getIssue(out.issueId))!
    expect(row.origin).toEqual({ kind: "im", conversationKey: IM.conversationKey, messageId: "m2" })
    expect(mockPushCard).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: "lark-1",
        issue: expect.objectContaining({ id: out.issueId }),
      })
    )
    expect(mockPropose).not.toHaveBeenCalled()
  })

  it("on the desktop defaults to the newest project and reports no-projects when empty", async () => {
    expect(await create.execute({ title: "x" }, { sessionId: "s" })).toEqual({
      status: "no-projects",
    })
    await createIssueProject({ projectId: "w1", name: "Old", key: "OLD" })
    const newest = await createIssueProject({ projectId: "w1", name: "New", key: "NEW" })
    const out = (await create.execute(
      { title: "desk", description: "body" },
      { sessionId: "s" }
    )) as {
      status: string
      issueId: string
    }
    expect(out.status).toBe("created")
    const row = (await getIssue(out.issueId))!
    expect(row.issueProjectId).toBe(newest.id)
    expect(row.origin).toBeUndefined()
    expect(mockPushCard).not.toHaveBeenCalled()
  })

  it("falls back to the default workspace when none is active", async () => {
    activeProjectId = null
    await createIssueProject({ projectId: "w-default", name: "D", key: "DEF" })
    const out = (await create.execute({ title: "x" }, { sessionId: "s" })) as { status: string }
    expect(out.status).toBe("created")
  })

  it("builds a HITL surface naming the project when given", () => {
    const withProject = create.hitlSurface!({
      title: "T",
      issueProjectId: "p1",
      description: "desc",
    })
    const mirror = JSON.stringify(withProject.components)
    expect(mirror).toContain("p1")
    expect(mirror).toContain("desc")
    const without = create.hitlSurface!({ title: "T" })
    expect(JSON.stringify(without.components)).toContain("pick the project next")
  })
})

describe("issue.list_projects", () => {
  it("lists only the workspace's projects, filtered by query", async () => {
    await createIssueProject({ projectId: "w1", name: "Mercury", key: "MERC" })
    await createIssueProject({ projectId: "w1", name: "Venus", key: "VEN" })
    await createIssueProject({ projectId: "w2", name: "Other", key: "OTH" })
    const all = (await list.execute({}, { sessionId: "s" })) as {
      workspaceId: string
      projects: Array<{ key: string }>
    }
    expect(all.workspaceId).toBe("w1")
    expect(all.projects.map((p) => p.key).sort()).toEqual(["MERC", "VEN"])
    const filtered = (await list.execute({ query: "merc" }, { sessionId: "s" })) as {
      projects: Array<{ key: string }>
    }
    expect(filtered.projects.map((p) => p.key)).toEqual(["MERC"])
    activeProjectId = null
    const fallback = (await list.execute({}, { sessionId: "s" })) as { workspaceId: string }
    expect(fallback.workspaceId).toBe("w-default")
  })
})
