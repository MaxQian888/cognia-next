const mockGetIssue = jest.fn(async (_id: string): Promise<unknown> => undefined)
const mockGetByIdentifier = jest.fn(async (_id: string): Promise<unknown> => undefined)
const mockCreateIssue = jest.fn(async (input: unknown) => ({
  id: "new",
  identifier: "MERC-9",
  ...(input as object),
}))
const mockListIssues = jest.fn(async (_q: unknown): Promise<unknown[]> => [])
jest.mock("@/lib/db/issues", () => ({
  getIssue: (id: string) => mockGetIssue(id),
  getIssueByIdentifier: (id: string) => mockGetByIdentifier(id),
  createIssue: (input: unknown) => mockCreateIssue(input),
  listIssues: (q: unknown) => mockListIssues(q),
}))
const mockByKey = jest.fn(async (_k: string): Promise<unknown> => undefined)
const mockGetProject = jest.fn(async (_id: string): Promise<unknown> => undefined)
const mockListProjects = jest.fn(async (_q: unknown): Promise<unknown[]> => [])
jest.mock("@/lib/db/issue-projects", () => ({
  getIssueProjectByKey: (k: string) => mockByKey(k),
  getIssueProject: (id: string) => mockGetProject(id),
  listIssueProjects: (q: unknown) => mockListProjects(q),
}))
const mockRunning = jest.fn(async (_p: string) => new Set<string>())
jest.mock("@/lib/db/issue-runs", () => ({
  listActiveIssueRunIssueIds: (p: string) => mockRunning(p),
}))
const mockEnsureLabels = jest.fn(async (names: readonly string[]) =>
  names.map((name) => ({ id: `l:${name}`, name }))
)
jest.mock("./sync/apply", () => ({
  ensureIssueLabels: (n: readonly string[]) => mockEnsureLabels(n),
}))
const mockApplyBulk = jest.fn(async (..._a: unknown[]) => ({ applied: 1, skipped: 0, failed: 0 }))
jest.mock("./bulk-actions", () => ({
  applyIssueBulkAction: (...a: unknown[]) => mockApplyBulk(...a),
}))
jest.mock("./sources/local-source", () => ({
  toUnifiedIssue: (issue: { id: string }) => ({
    unifiedId: `local:${issue.id}`,
    kind: "local",
    sourceId: issue.id,
  }),
}))
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ activeProjectId: "w1" }) },
}))

import type { Issue } from "@/types/issues"
import {
  applyIssueAction,
  createIssueRecord,
  isIssuePriority,
  isIssueStatus,
  queryIssues,
  resolveIssue,
  toIssueWire,
} from "./service"

const by = { kind: "human" as const }
function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: "i1",
    identifier: "MERC-1",
    number: 1,
    projectId: "w1",
    issueProjectId: "p1",
    title: "One",
    status: "todo",
    statusCategory: "unstarted",
    priority: "none",
    createdBy: by,
    labelIds: [],
    externalRefs: [],
    externalKeys: [],
    order: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as Issue
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGetIssue.mockResolvedValue(undefined)
  mockGetByIdentifier.mockResolvedValue(undefined)
  mockByKey.mockResolvedValue(undefined)
  mockGetProject.mockResolvedValue(undefined)
  mockListProjects.mockResolvedValue([])
  mockListIssues.mockResolvedValue([])
})

describe("resolveIssue", () => {
  it("tries the id first, then the identifier in upper case", async () => {
    mockGetByIdentifier.mockResolvedValueOnce(issue())
    expect(await resolveIssue(" merc-1 ")).toMatchObject({ id: "i1" })
    expect(mockGetIssue).toHaveBeenCalledWith("merc-1")
    expect(mockGetByIdentifier).toHaveBeenCalledWith("MERC-1")
    expect(await resolveIssue("   ")).toBeUndefined()
  })
})

describe("createIssueRecord", () => {
  it("defaults to the active workspace's first container and stamps the actor", async () => {
    mockListProjects.mockResolvedValueOnce([{ id: "p1" }, { id: "p2" }])
    await createIssueRecord({ title: " Fix ", by, labels: ["bug"] })
    expect(mockCreateIssue).toHaveBeenCalledWith({
      projectId: "w1",
      issueProjectId: "p1",
      title: "Fix",
      createdBy: by,
      labelIds: ["l:bug"],
    })
  })

  it("resolves a container by key inside the workspace only", async () => {
    mockByKey.mockResolvedValueOnce({ id: "p9", projectId: "other" })
    await expect(createIssueRecord({ title: "x", by, projectKey: "merc" })).rejects.toThrow(/MERC/)
    mockByKey.mockResolvedValueOnce({ id: "p9", projectId: "w1" })
    await createIssueRecord({ title: "x", by, projectKey: "merc", status: "todo", estimate: 0 })
    expect(mockCreateIssue).toHaveBeenLastCalledWith(
      expect.objectContaining({ issueProjectId: "p9", status: "todo", estimate: 0 })
    )
  })

  it("takes the workspace from a named container, so no active workspace is needed", async () => {
    mockGetProject.mockResolvedValueOnce({ id: "p7", projectId: "w9" })
    await createIssueRecord({ title: "x", by, issueProjectId: "p7" })
    expect(mockCreateIssue).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectId: "w9", issueProjectId: "p7" })
    )
    await expect(createIssueRecord({ title: "x", by, issueProjectId: "nope" })).rejects.toThrow(
      /No project with id/
    )
  })

  it("refuses a blank title and a workspace with no container", async () => {
    await expect(createIssueRecord({ title: " ", by })).rejects.toThrow(/title/)
    await expect(createIssueRecord({ title: "x", by })).rejects.toThrow(/project first/)
  })
})

describe("applyIssueAction", () => {
  it("runs the board's gate with the workspace's running set", async () => {
    mockRunning.mockResolvedValueOnce(new Set(["i1"]))
    const out = await applyIssueAction(issue(), { kind: "status", to: "done" }, by)
    expect(out).toEqual({ applied: 1, skipped: 0, failed: 0 })
    expect(mockApplyBulk).toHaveBeenCalledWith(
      [expect.objectContaining({ unifiedId: "local:i1" })],
      { kind: "status", to: "done" },
      by,
      new Set(["local:i1"])
    )
  })
})

describe("queryIssues", () => {
  it("scopes to the active workspace, resolves a key, filters text and caps", async () => {
    mockByKey.mockResolvedValueOnce({ id: "p1", projectId: "w1" })
    mockListIssues.mockResolvedValueOnce([
      issue({ id: "a", title: "Login broken" }),
      issue({ id: "b", title: "Docs", description: "login page" }),
      issue({ id: "c", title: "Other" }),
    ])
    const rows = await queryIssues({ projectKey: "merc", text: "LOGIN", limit: 1 })
    expect(mockListIssues).toHaveBeenCalledWith({ projectId: "w1", issueProjectId: "p1" })
    expect(rows.map((r) => r.id)).toEqual(["a"])
  })

  it("returns nothing for an unknown key instead of the whole workspace", async () => {
    await expect(queryIssues({ projectKey: "NOPE" })).resolves.toEqual([])
    expect(mockListIssues).not.toHaveBeenCalled()
  })
})

describe("guards and wire shape", () => {
  it("recognises statuses and priorities", () => {
    expect(isIssueStatus("done")).toBe(true)
    expect(isIssueStatus("closed")).toBe(false)
    expect(isIssuePriority("urgent")).toBe(true)
    expect(isIssuePriority(3)).toBe(false)
  })

  it("strips the indexed mirror from the wire row", () => {
    const wire = toIssueWire(issue({ externalKeys: ["github:o/r#1"] }))
    expect("externalKeys" in wire).toBe(false)
    expect(wire.identifier).toBe("MERC-1")
  })
})
