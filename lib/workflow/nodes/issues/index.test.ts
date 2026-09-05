const mockResolve = jest.fn(async (_ref: string): Promise<unknown> => undefined)
const mockCreate = jest.fn(async (req: unknown) => ({
  id: "new",
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
const mockEnsureLabels = jest.fn(async (names: readonly string[]) =>
  names.map((name) => ({ id: `l:${name}`, name }))
)
jest.mock("@/lib/issues/sync/apply", () => ({
  ensureIssueLabels: (n: readonly string[]) => mockEnsureLabels(n),
}))
jest.mock("@/lib/db/labels", () => ({
  listLabels: async () => [{ id: "l:bug", name: "Bug" }],
}))

import "."
import { getExecutor } from "../registry"
import type { StepExecutionContext } from "@/types/workflow/visual"

const issue = {
  id: "i1",
  identifier: "MERC-1",
  projectId: "w1",
  issueProjectId: "p1",
  title: "One",
  status: "todo",
  externalKeys: ["x"],
}

function run(kind: string, params: Record<string, unknown>) {
  const executor = getExecutor(kind as never, 1)!
  const ctx = {
    params,
    workflowId: "wf1",
    runId: "run1",
    trigger: { originAt: 5, payload: { a: 1 } },
  } as unknown as StepExecutionContext
  return executor.execute(ctx)
}

beforeEach(() => {
  jest.clearAllMocks()
  mockResolve.mockResolvedValue(issue)
})

describe("issue node registration", () => {
  it.each([
    "action.issue.create",
    "action.issue.get",
    "action.issue.list",
    "action.issue.update",
    "action.issue.assign",
    "action.issue.comment",
    "action.issue.label",
    "trigger.issue.event",
  ])("registers %s@1", (kind) => {
    expect(getExecutor(kind as never, 1)).toBeDefined()
  })
})

describe("action.issue.create", () => {
  it("files with the workflow actor and only the fields given", async () => {
    const result = await run("action.issue.create", {
      title: " Fix login ",
      projectKey: "MERC",
      priority: "high",
      labels: "bug, auth",
      estimate: 3,
    })
    expect(mockCreate).toHaveBeenCalledWith({
      title: "Fix login",
      by: { kind: "agent", id: "workflow:wf1", label: "Workflow" },
      projectKey: "MERC",
      priority: "high",
      labels: ["bug", "auth"],
      estimate: 3,
    })
    expect(result.output).toMatchObject({ issueId: "new", identifier: "MERC-9" })
    expect((result.output as { issue: Record<string, unknown> }).issue.externalKeys).toBeUndefined()
  })

  it("refuses a blank title and an unknown status without writing", async () => {
    await expect(run("action.issue.create", { title: " " })).rejects.toThrow(/title/)
    await expect(run("action.issue.create", { title: "x", status: "closed" })).rejects.toThrow(
      /status/
    )
    expect(mockCreate).not.toHaveBeenCalled()
  })
})

describe("action.issue.get and list", () => {
  it("reports found or not without throwing", async () => {
    expect((await run("action.issue.get", { issue: "MERC-1" })).output).toMatchObject({
      found: true,
      identifier: "MERC-1",
    })
    mockResolve.mockResolvedValueOnce(undefined)
    expect((await run("action.issue.get", { issue: "MERC-404" })).output).toEqual({
      found: false,
      ref: "MERC-404",
    })
  })

  it("passes the filters through and counts", async () => {
    mockQuery.mockResolvedValueOnce([issue])
    const result = await run("action.issue.list", {
      projectKey: "MERC",
      statuses: ["todo", "bogus"],
      text: "log",
      limit: 5,
    })
    expect(mockQuery).toHaveBeenCalledWith({
      projectKey: "MERC",
      statuses: ["todo"],
      text: "log",
      limit: 5,
    })
    expect(result.output).toMatchObject({ count: 1 })
  })
})

describe("action.issue.update / assign / comment / label", () => {
  it("turns each given field into one board action, in order", async () => {
    const result = await run("action.issue.update", {
      issue: "MERC-1",
      status: "done",
      estimate: null,
      cycleId: "c1",
    })
    const kinds = mockApply.mock.calls.map((c) => (c[1] as { kind: string }).kind)
    expect(kinds).toEqual(["status", "estimate", "cycle"])
    expect(mockApply.mock.calls[0][2]).toEqual({
      kind: "agent",
      id: "workflow:wf1",
      label: "Workflow",
    })
    expect(result.output).toEqual({
      issueId: "i1",
      identifier: "MERC-1",
      applied: 3,
      skipped: 0,
      failed: 0,
    })
  })

  it("refuses an update with nothing to change and an unknown issue", async () => {
    await expect(run("action.issue.update", { issue: "MERC-1" })).rejects.toThrow(
      /nothing to change/
    )
    mockResolve.mockResolvedValueOnce(undefined)
    await expect(run("action.issue.update", { issue: "MERC-404", status: "done" })).rejects.toThrow(
      /no issue/
    )
  })

  it("surfaces the gate's refusal instead of hiding it", async () => {
    mockApply.mockResolvedValueOnce({ applied: 0, skipped: 1, failed: 0, reason: "running" })
    const result = await run("action.issue.comment", { issue: "MERC-1", body: "hi" })
    expect(result.output).toMatchObject({ applied: 0, skipped: 1, reason: "running" })
  })

  it("assigns to a squad, unassigns with none, and rejects an agent without an id", async () => {
    await run("action.issue.assign", {
      issue: "MERC-1",
      assigneeKind: "team",
      assigneeId: "t1",
      assigneeLabel: "Core",
    })
    expect(mockApply).toHaveBeenLastCalledWith(
      issue,
      { kind: "assignee", to: { kind: "team", id: "t1", label: "Core" } },
      expect.anything()
    )
    await run("action.issue.assign", { issue: "MERC-1", assigneeKind: "none" })
    expect(mockApply).toHaveBeenLastCalledWith(
      issue,
      { kind: "assignee", to: null },
      expect.anything()
    )
    await expect(
      run("action.issue.assign", { issue: "MERC-1", assigneeKind: "agent" })
    ).rejects.toThrow(/assigneeId/)
  })

  it("adds labels by name (creating them) and removes only names that exist", async () => {
    await run("action.issue.label", { issue: "MERC-1", add: ["Docs"], remove: "bug, nope" })
    const actions = mockApply.mock.calls.map((c) => c[1])
    expect(actions).toEqual([
      { kind: "addLabel", labelId: "l:Docs" },
      { kind: "removeLabel", labelId: "l:bug" },
    ])
    await expect(run("action.issue.label", { issue: "MERC-1" })).rejects.toThrow(/add/)
  })
})

describe("trigger.issue.event", () => {
  it("round-trips the trigger payload when run manually", async () => {
    const result = await run("trigger.issue.event", { kinds: ["created"] })
    expect(result.output).toEqual({ kinds: ["created"], firedAt: 5, payload: { a: 1 } })
  })
})
