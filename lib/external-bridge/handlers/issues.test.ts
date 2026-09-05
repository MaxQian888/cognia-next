const mockResolve = jest.fn(async (_ref: string): Promise<unknown> => undefined)
const mockCreate = jest.fn(async (req: unknown) => ({
  id: "n",
  identifier: "MERC-9",
  externalKeys: [],
  ...(req as object),
}))
const mockQuery = jest.fn(async (_q: unknown): Promise<unknown[]> => [])
const mockApply = jest.fn(async (..._a: unknown[]) => ({ applied: 1, skipped: 0, failed: 0 }))
jest.mock("@/lib/issues/service", () => {
  const actual = jest.requireActual("@/lib/issues/service")
  return {
    ...actual,
    resolveIssue: (ref: string) => mockResolve(ref),
    createIssueRecord: (req: unknown) => mockCreate(req),
    queryIssues: (q: unknown) => mockQuery(q),
    applyIssueAction: (...a: unknown[]) => mockApply(...a),
  }
})
const mockEvents = jest.fn(async (_q: unknown) => [{ id: "e1" }])
jest.mock("@/lib/db/issue-events", () => ({ listIssueEvents: (q: unknown) => mockEvents(q) }))

import {
  issuesComment,
  issuesCreate,
  issuesGet,
  issuesList,
  issuesUpdate,
  MCP_ISSUE_ACTOR,
} from "./issues"

const issue = { id: "i1", identifier: "MERC-1", title: "One", externalKeys: ["k"] }

beforeEach(() => {
  jest.clearAllMocks()
  mockResolve.mockResolvedValue(issue)
})

describe("issuesList", () => {
  it("drops unknown statuses, caps the page, and reports the total", async () => {
    mockQuery.mockResolvedValueOnce([issue, { ...issue, id: "i2" }, { ...issue, id: "i3" }])
    const result = await issuesList({ projectKey: "MERC", statuses: ["todo", "bogus"], limit: 2 })
    expect(mockQuery).toHaveBeenCalledWith({ projectKey: "MERC", statuses: ["todo"] })
    expect(result.issues).toHaveLength(2)
    expect(result.total).toBe(3)
    expect("externalKeys" in result.issues[0]).toBe(false)
  })
})

describe("issuesGet", () => {
  it("returns the row with its newest trail entries, or not_found", async () => {
    const found = await issuesGet({ ref: "merc-1", events: 5 })
    expect(found).toMatchObject({
      ok: true,
      issue: { identifier: "MERC-1" },
      events: [{ id: "e1" }],
    })
    expect(mockEvents).toHaveBeenCalledWith({ issueId: "i1", descending: true, limit: 5 })
    mockResolve.mockResolvedValueOnce(undefined)
    expect(await issuesGet({ ref: "MERC-404" })).toEqual({ ok: false, reason: "not_found" })
    await expect(issuesGet({ ref: " " })).rejects.toThrow(/ref/)
  })
})

describe("issuesCreate", () => {
  it("stamps the mcp actor and turns a service refusal into an answer", async () => {
    const ok = await issuesCreate({ title: " Fix ", labels: ["bug"], priority: "high" })
    expect(mockCreate).toHaveBeenCalledWith({
      title: "Fix",
      by: MCP_ISSUE_ACTOR,
      priority: "high",
      labels: ["bug"],
    })
    expect(ok).toMatchObject({ ok: true, issue: { identifier: "MERC-9" } })
    mockCreate.mockRejectedValueOnce(new Error("Create a project first"))
    expect(await issuesCreate({ title: "x" })).toEqual({
      ok: false,
      reason: "invalid",
      detail: "Create a project first",
    })
    expect(await issuesCreate({ title: "x", status: "closed" })).toMatchObject({
      ok: false,
      reason: "invalid",
    })
    await expect(issuesCreate({ title: "" })).rejects.toThrow(/title/)
  })
})

describe("issuesUpdate and issuesComment", () => {
  it("maps fields to board actions and returns the refreshed row", async () => {
    const result = await issuesUpdate({
      ref: "MERC-1",
      status: "done",
      assignee: null,
      estimate: null,
    })
    expect(mockApply.mock.calls.map((c) => c[1])).toEqual([
      { kind: "status", to: "done" },
      { kind: "assignee", to: null },
      { kind: "estimate", to: null },
    ])
    expect(mockApply.mock.calls[0][2]).toBe(MCP_ISSUE_ACTOR)
    expect(result).toMatchObject({ ok: true, outcome: { applied: 3 } })
  })

  it("reports a refusal with the gate's reason instead of ok", async () => {
    mockApply.mockResolvedValueOnce({ applied: 0, skipped: 1, failed: 0, reason: "running" })
    expect(await issuesComment({ ref: "MERC-1", body: "hi" })).toEqual({
      ok: false,
      reason: "refused",
      detail: "running",
    })
  })

  it("rejects an empty patch, an agent without an id, and an unknown ref", async () => {
    expect(await issuesUpdate({ ref: "MERC-1" })).toMatchObject({ ok: false, reason: "invalid" })
    expect(await issuesUpdate({ ref: "MERC-1", assignee: { kind: "agent" } })).toMatchObject({
      ok: false,
      reason: "invalid",
    })
    mockResolve.mockResolvedValueOnce(undefined)
    expect(await issuesComment({ ref: "MERC-404", body: "x" })).toEqual({
      ok: false,
      reason: "not_found",
    })
    expect(mockApply).not.toHaveBeenCalled()
  })
})
