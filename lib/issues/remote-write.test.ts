const mockEnqueue = jest.fn(async (input: unknown) => ({ id: "job", ...(input as object) }))
jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueue: (input: unknown) => mockEnqueue(input),
}))

import {
  isRemoteIssueAction,
  queueIssueAction,
  queueIssueCreate,
  REMOTE_ISSUE_ACTION_KINDS,
} from "./remote-write"

describe("remote issue writes", () => {
  beforeEach(() => mockEnqueue.mockClear())

  it("allows the phone's vocabulary and refuses the desktop-only kinds", () => {
    expect(isRemoteIssueAction({ kind: "status", to: "done" })).toBe(true)
    expect(isRemoteIssueAction({ kind: "comment", body: "hi" })).toBe(true)
    expect(isRemoteIssueAction({ kind: "delete" })).toBe(false)
    expect(isRemoteIssueAction({ kind: "project", issueProjectId: "p" })).toBe(false)
    expect(isRemoteIssueAction({ kind: "parent", parentId: null })).toBe(false)
    expect(REMOTE_ISSUE_ACTION_KINDS).not.toContain("delete")
  })

  it("queues an action with the issue and a readable label", async () => {
    await queueIssueAction({
      issueId: "i1",
      identifier: "MERC-4",
      action: { kind: "status", to: "done" },
    })
    expect(mockEnqueue).toHaveBeenCalledWith({
      command: "issue_apply_action",
      payload: { issueId: "i1", action: { kind: "status", to: "done" } },
      label: "MERC-4: status",
    })
    await queueIssueAction({ issueId: "i1", action: { kind: "comment", body: "x" } })
    expect(mockEnqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ label: "issue: comment" })
    )
  })

  it("queues a create with only the fields that were given, and refuses a blank title", async () => {
    await expect(
      queueIssueCreate({ projectId: "w", issueProjectId: "p", title: "  " })
    ).rejects.toThrow(/title/)
    await queueIssueCreate({
      projectId: "w",
      issueProjectId: "p",
      title: " New ",
      description: " ",
      status: "todo",
      estimate: 0,
      labelIds: [],
    })
    expect(mockEnqueue).toHaveBeenCalledWith({
      command: "issue_create",
      payload: { projectId: "w", issueProjectId: "p", title: "New", status: "todo", estimate: 0 },
      label: "New",
    })
  })
})
