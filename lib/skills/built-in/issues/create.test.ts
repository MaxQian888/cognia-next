/**
 * `issue.create` — the two shapes and the one rule ("不点不落库"): an IM session
 * with no explicit project only PROPOSES; every other path writes.
 */
const mockProposeIssueFromIm = jest.fn(
  async (..._a: unknown[]): Promise<{ status: string; draftId?: string }> => ({
    status: "proposed",
    draftId: "draft_1",
  })
)
jest.mock("@/lib/issues/im/propose", () => ({
  proposeIssueFromIm: (...a: unknown[]) => mockProposeIssueFromIm(...a),
}))

const mockPushIssueCard = jest.fn(async (..._a: unknown[]) => undefined)
jest.mock("@/lib/issues/im/push", () => ({
  pushIssueCard: (...a: unknown[]) => mockPushIssueCard(...a),
}))

const mockCreateIssue = jest.fn(async (..._a: unknown[]) => ({
  id: "iss_1",
  identifier: "MER-3",
}))
jest.mock("@/lib/db/issues", () => ({
  createIssue: (...a: unknown[]) => mockCreateIssue(...a),
}))

const mockListIssueProjects = jest.fn(async (..._a: unknown[]): Promise<unknown[]> => [])
// An explicitly named container is now looked up and scope-checked before the
// write, so the two single-row readers have to answer as well.
const mockGetIssueProject = jest.fn(async (id: unknown): Promise<unknown> => ({
  id,
  key: "MER",
  projectId: "ws_1",
}))
const mockGetIssueProjectByKey = jest.fn(async (..._a: unknown[]): Promise<unknown> => undefined)
jest.mock("@/lib/db/issue-projects", () => ({
  listIssueProjects: (...a: unknown[]) => mockListIssueProjects(...a),
  getIssueProject: (...a: unknown[]) => mockGetIssueProject(...a),
  getIssueProjectByKey: (...a: unknown[]) => mockGetIssueProjectByKey(...a),
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
import "./create"

const skill = getSharedBuiltInSkillRegistry().get("issue.create")!

const imBinding = {
  adapterId: "ad_1",
  platform: "lark" as const,
  conversationKey: "lark:ad_1:oc_1",
}
const desktopCtx = { sessionId: "s1" } as BuiltInSkillContext
const imCtx = { sessionId: "s1", imBinding } as BuiltInSkillContext

type Args = {
  title: string
  description?: string
  issueProjectId?: string
  sourceMessageId?: string
}
const run = (args: Args, ctx: BuiltInSkillContext) =>
  skill.execute(args as never, ctx) as Promise<Record<string, unknown>>

beforeEach(() => {
  activeProjectId = "ws_1"
  mockListIssueProjects.mockResolvedValue([])
  mockGetIssueProjectByKey.mockResolvedValue(undefined)
  mockGetIssueProject.mockImplementation(async (id: unknown) => ({
    id,
    key: "MER",
    projectId: "ws_1",
  }))
  mockProposeIssueFromIm.mockResolvedValue({ status: "proposed", draftId: "draft_1" })
})

describe("issue.create — registration", () => {
  it("is a write skill with a HITL surface", () => {
    expect(skill.mutation).toBe("write")
    expect(skill.hitlSurface).toBeDefined()
    expect(skill.mcpToolName).toBe("issue_create")
  })

  it("requires a non-empty title and caps the free text", () => {
    expect(skill.inputSchema.safeParse({}).success).toBe(false)
    expect(skill.inputSchema.safeParse({ title: "" }).success).toBe(false)
    expect(skill.inputSchema.safeParse({ title: "x".repeat(201) }).success).toBe(false)
    expect(skill.inputSchema.safeParse({ title: "Fix it" }).success).toBe(true)
    expect(
      skill.inputSchema.safeParse({ title: "Fix it", description: "y".repeat(4001) }).success
    ).toBe(false)
  })
})

describe("issue.create — IM session without an explicit project", () => {
  it("proposes instead of writing, and says so", async () => {
    const out = await run({ title: "Crash on launch" }, imCtx)
    expect(mockCreateIssue).not.toHaveBeenCalled()
    expect(out).toMatchObject({ status: "pending", draftId: "draft_1" })
    expect(out.instruction).toContain("Do not file the issue yourself")
  })

  it("hands the proposer the conversation and the optional quoted message", async () => {
    await run({ title: "Crash", description: "on cold start", sourceMessageId: "om_9" }, imCtx)
    expect(mockProposeIssueFromIm).toHaveBeenCalledWith({
      adapterId: "ad_1",
      conversationKey: "lark:ad_1:oc_1",
      workspaceId: "ws_1",
      title: "Crash",
      description: "on cold start",
      sourceMessageId: "om_9",
    })
  })

  it("omits the optional keys entirely when they were not supplied", async () => {
    await run({ title: "Crash" }, imCtx)
    const payload = mockProposeIssueFromIm.mock.calls[0][0] as Record<string, unknown>
    expect("description" in payload).toBe(false)
    expect("sourceMessageId" in payload).toBe(false)
  })

  it("passes a non-proposed outcome (e.g. no-projects) straight back", async () => {
    mockProposeIssueFromIm.mockResolvedValue({ status: "no-projects" })
    await expect(run({ title: "Crash" }, imCtx)).resolves.toEqual({ status: "no-projects" })
    expect(mockCreateIssue).not.toHaveBeenCalled()
  })
})

describe("issue.create — the writing shapes", () => {
  it("files directly on desktop, defaulting to the most recently touched project", async () => {
    mockListIssueProjects.mockResolvedValue([
      { id: "ip_old", updatedAt: 1 },
      { id: "ip_new", updatedAt: 9 },
    ])
    const out = await run({ title: "Crash" }, desktopCtx)
    expect(mockCreateIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "ws_1",
        issueProjectId: "ip_new",
        title: "Crash",
        createdBy: { kind: "agent" },
      })
    )
    expect(out).toEqual({ status: "created", issueId: "iss_1", identifier: "MER-3" })
  })

  it("refuses rather than inventing a container when the workspace has none", async () => {
    await expect(run({ title: "Crash" }, desktopCtx)).resolves.toEqual({ status: "no-projects" })
    expect(mockCreateIssue).not.toHaveBeenCalled()
  })

  it("takes a named container without scanning the workspace for a default", async () => {
    await run({ title: "Crash", issueProjectId: "ip_named" }, desktopCtx)
    expect(mockListIssueProjects).not.toHaveBeenCalled()
    expect(mockCreateIssue).toHaveBeenCalledWith(
      expect.objectContaining({ issueProjectId: "ip_named" })
    )
  })

  it("refuses a named container that belongs to another workspace", async () => {
    // The id comes from a model, which may be repeating one it saw while a
    // different workspace was active. Writing it would strand the issue where
    // neither workspace's board could show it.
    mockGetIssueProject.mockResolvedValue({ id: "ip_far", key: "FAR", projectId: "ws_other" })

    await expect(run({ title: "Crash", issueProjectId: "ip_far" }, desktopCtx)).rejects.toThrow(
      /belongs to another workspace/
    )
    expect(mockCreateIssue).not.toHaveBeenCalled()
  })

  it("resolves a container named by its key", async () => {
    mockGetIssueProjectByKey.mockResolvedValue({ id: "ip_1", key: "MER", projectId: "ws_1" })

    await run({ title: "Crash", issueProjectId: "mer" }, desktopCtx)
    expect(mockGetIssueProjectByKey).toHaveBeenCalledWith("MER")
    expect(mockCreateIssue).toHaveBeenCalledWith(
      expect.objectContaining({ issueProjectId: "ip_1" })
    )
  })

  it("attributes the issue to the assistant, never to the user", async () => {
    // A skill call is the model acting. `createdBy` is the only record of who
    // filed an issue, and it used to claim a human did whatever called in.
    await run({ title: "Crash", issueProjectId: "ip_1" }, desktopCtx)
    const payload = mockCreateIssue.mock.calls[0][0] as { createdBy: { kind: string } }
    expect(payload.createdBy.kind).toBe("agent")
  })

  it("writes on the IM path too once a project is explicit, and stamps the IM origin", async () => {
    await run({ title: "Crash", issueProjectId: "ip_1", sourceMessageId: "om_9" }, imCtx)
    expect(mockProposeIssueFromIm).not.toHaveBeenCalled()
    expect(mockCreateIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: { kind: "im", conversationKey: "lark:ad_1:oc_1", messageId: "om_9" },
      })
    )
  })

  it("records no origin at all for a desktop session", async () => {
    await run({ title: "Crash", issueProjectId: "ip_1" }, desktopCtx)
    const payload = mockCreateIssue.mock.calls[0][0] as Record<string, unknown>
    expect("origin" in payload).toBe(false)
  })

  it("pushes the issue card back to the conversation after an IM write", async () => {
    await run({ title: "Crash", issueProjectId: "ip_1" }, imCtx)
    expect(mockPushIssueCard).toHaveBeenCalledWith({
      adapterId: "ad_1",
      conversationKey: "lark:ad_1:oc_1",
      issue: { id: "iss_1", identifier: "MER-3" },
    })
  })

  it("pushes no card for a desktop write", async () => {
    await run({ title: "Crash", issueProjectId: "ip_1" }, desktopCtx)
    expect(mockPushIssueCard).not.toHaveBeenCalled()
  })

  it("falls back to the default workspace when no project is active", async () => {
    activeProjectId = null
    // The scope check compares against whatever workspace was resolved, so the
    // container has to live in the fallback one for this path to be reachable.
    mockGetIssueProject.mockResolvedValue({ id: "ip_1", key: "MER", projectId: "ws_default" })
    await run({ title: "Crash", issueProjectId: "ip_1" }, desktopCtx)
    expect(mockEnsureDefaultProject).toHaveBeenCalled()
    expect(mockCreateIssue).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "ws_default" })
    )
  })
})

describe("issue.create — HITL surface", () => {
  it("warns that the project is still to be picked when none was named", () => {
    const surface = skill.hitlSurface!({ title: "Crash" } as never)
    expect(JSON.stringify(surface)).toContain("you will pick the project next")
  })

  it("lists the project and a truncated description when they are known", () => {
    const surface = skill.hitlSurface!({
      title: "Crash",
      issueProjectId: "ip_1",
      description: "z".repeat(300),
    } as never)
    const json = JSON.stringify(surface)
    expect(json).toContain("ip_1")
    expect(json).not.toContain("you will pick the project next")
    expect(json).toContain("z".repeat(200))
    expect(json).not.toContain("z".repeat(201))
  })

  it("offers confirm and cancel so the dispatcher has a card to send", () => {
    const surface = skill.hitlSurface!({ title: "Crash" } as never)
    const components = surface.components as Record<string, unknown>
    expect(components.btn_confirm).toBeDefined()
    expect(components.btn_cancel).toBeDefined()
  })
})
