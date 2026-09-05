jest.mock("@/lib/db/issues", () => ({
  addIssueBlocker: jest.fn(async () => undefined),
  addIssueComment: jest.fn(async () => undefined),
  linkIssueExternal: jest.fn(async () => undefined),
  removeIssueBlocker: jest.fn(async () => undefined),
  setIssueCycle: jest.fn(async () => undefined),
  setIssueDueDate: jest.fn(async () => undefined),
  setIssueEstimate: jest.fn(async () => undefined),
  setIssueParent: jest.fn(async () => undefined),
  unlinkIssueExternal: jest.fn(async () => undefined),
  addIssueLabel: jest.fn(async () => undefined),
  deleteIssue: jest.fn(async () => undefined),
  moveIssue: jest.fn(async () => null),
  moveIssueToProject: jest.fn(async () => undefined),
  removeIssueLabel: jest.fn(async () => undefined),
  setIssueAssignee: jest.fn(async () => undefined),
  updateIssue: jest.fn(async () => undefined),
}))

import {
  addIssueBlocker,
  addIssueComment,
  linkIssueExternal,
  removeIssueBlocker,
  setIssueCycle,
  setIssueDueDate,
  setIssueEstimate,
  setIssueParent,
  unlinkIssueExternal,
  addIssueLabel,
  deleteIssue,
  moveIssue,
  moveIssueToProject,
  removeIssueLabel,
  setIssueAssignee,
  updateIssue,
} from "@/lib/db/issues"
import { statusCategoryOf } from "@/types/issues"
import type { IssueActor, IssueStatus } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES, READ_ONLY_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import {
  applyIssueBulkAction,
  canApplyBulkAction,
  countApplicableItems,
  type IssueBulkAction,
} from "./bulk-actions"

const BY: IssueActor = { kind: "human" }

let seq = 0
function item(over: Partial<UnifiedIssueItem> = {}): UnifiedIssueItem {
  seq += 1
  const kind = over.kind ?? "local"
  const sourceId = over.sourceId ?? `s${seq}`
  const status: IssueStatus = over.status ?? "todo"
  return {
    unifiedId: `${kind}:${sourceId}`,
    kind,
    sourceId,
    identifier: `MERC-${seq}`,
    title: `Issue ${seq}`,
    status,
    statusCategory: statusCategoryOf(status),
    priority: "none",
    labelIds: [],
    order: seq,
    createdAt: seq,
    updatedAt: seq,
    origin: { deepLinkHref: "/issues" },
    capabilities: kind === "local" ? FULL_ISSUE_CAPABILITIES : READ_ONLY_ISSUE_CAPABILITIES,
    ...over,
  }
}

const NONE = new Set<string>()

beforeEach(() => {
  seq = 0
  jest.clearAllMocks()
})

describe("canApplyBulkAction", () => {
  it("allows every action on a local row at rest", () => {
    const local = item()
    const actions: IssueBulkAction[] = [
      { kind: "status", to: "done" },
      { kind: "title", to: "Renamed" },
      { kind: "description", to: "Because" },
      { kind: "priority", to: "high" },
      { kind: "assignee", to: null },
      { kind: "addLabel", labelId: "l1" },
      { kind: "removeLabel", labelId: "l1" },
      { kind: "project", issueProjectId: "p1" },
      { kind: "delete" },
    ]
    for (const action of actions) {
      expect(canApplyBulkAction(local, action, false)).toEqual({ ok: true })
    }
  })

  it("refuses every action on a federated row", () => {
    const remote = item({ kind: "github", sourceId: "o/r#1" })
    expect(canApplyBulkAction(remote, { kind: "priority", to: "high" }, false)).toEqual({
      ok: false,
      reason: "federated-read-only",
    })
    expect(canApplyBulkAction(remote, { kind: "delete" }, false)).toEqual({
      ok: false,
      reason: "federated-read-only",
    })
  })

  it("honours a missing capability bit even on a local row", () => {
    const locked = item({ capabilities: { ...FULL_ISSUE_CAPABILITIES, canAssign: false } })
    expect(canApplyBulkAction(locked, { kind: "assignee", to: null }, false)).toEqual({
      ok: false,
      reason: "federated-read-only",
    })
    // A different action needing a different bit is unaffected.
    expect(canApplyBulkAction(locked, { kind: "priority", to: "low" }, false)).toEqual({ ok: true })
  })

  it("refuses a status change on a running issue, with the runtime reason", () => {
    expect(canApplyBulkAction(item(), { kind: "status", to: "in_progress" }, true)).toEqual({
      ok: false,
      reason: "runtime-owned",
    })
  })

  it("still allows a non-status edit on a running issue", () => {
    expect(canApplyBulkAction(item(), { kind: "priority", to: "urgent" }, true)).toEqual({
      ok: true,
    })
  })
})

describe("countApplicableItems", () => {
  it("counts only the rows an action would touch", () => {
    const items = [item(), item({ kind: "github", sourceId: "o/r#1" }), item()]
    expect(countApplicableItems(items, { kind: "priority", to: "high" }, NONE)).toBe(2)
  })

  it("accounts for the run guard", () => {
    const running = item()
    const idle = item()
    expect(
      countApplicableItems(
        [running, idle],
        { kind: "status", to: "in_progress" },
        new Set([running.unifiedId])
      )
    ).toBe(1)
  })
})

describe("applyIssueBulkAction", () => {
  it("routes each action to its own writer", async () => {
    await applyIssueBulkAction([item()], { kind: "priority", to: "high" }, BY)
    expect(updateIssue).toHaveBeenCalledWith("s1", { priority: "high" }, BY)

    await applyIssueBulkAction([item()], { kind: "assignee", to: null }, BY)
    expect(setIssueAssignee).toHaveBeenCalledWith("s2", null, BY)

    await applyIssueBulkAction([item()], { kind: "addLabel", labelId: "l1" }, BY)
    expect(addIssueLabel).toHaveBeenCalledWith("s3", "l1", BY)

    await applyIssueBulkAction([item()], { kind: "removeLabel", labelId: "l1" }, BY)
    expect(removeIssueLabel).toHaveBeenCalledWith("s4", "l1", BY)

    await applyIssueBulkAction([item()], { kind: "project", issueProjectId: "p1" }, BY)
    expect(moveIssueToProject).toHaveBeenCalledWith("s5", "p1", BY)

    await applyIssueBulkAction([item()], { kind: "delete" }, BY)
    expect(deleteIssue).toHaveBeenCalledWith("s6")

    await applyIssueBulkAction([item()], { kind: "status", to: "done" }, BY)
    expect(moveIssue).toHaveBeenCalledWith({ id: "s7", to: "done", by: BY })

    await applyIssueBulkAction([item()], { kind: "title", to: "Renamed" }, BY)
    expect(updateIssue).toHaveBeenCalledWith("s8", { title: "Renamed" }, BY)

    await applyIssueBulkAction([item()], { kind: "description", to: "Because" }, BY)
    expect(updateIssue).toHaveBeenCalledWith("s9", { description: "Because" }, BY)
  })

  it("routes the v223 planning and relation actions to their writers", async () => {
    await applyIssueBulkAction([item({ sourceId: "p1" })], { kind: "cycle", cycleId: "c1" }, BY)
    expect(setIssueCycle).toHaveBeenCalledWith("p1", "c1", BY)
    await applyIssueBulkAction([item({ sourceId: "p2" })], { kind: "dueDate", to: 5 }, BY)
    expect(setIssueDueDate).toHaveBeenCalledWith("p2", 5, BY)
    await applyIssueBulkAction([item({ sourceId: "p3" })], { kind: "estimate", to: null }, BY)
    expect(setIssueEstimate).toHaveBeenCalledWith("p3", null, BY)
    await applyIssueBulkAction([item({ sourceId: "p4" })], { kind: "parent", parentId: "x" }, BY)
    expect(setIssueParent).toHaveBeenCalledWith("p4", "x", BY)
    await applyIssueBulkAction(
      [item({ sourceId: "p5" })],
      { kind: "addBlocker", blockerId: "b" },
      BY
    )
    expect(addIssueBlocker).toHaveBeenCalledWith("p5", "b", BY)
    await applyIssueBulkAction(
      [item({ sourceId: "p6" })],
      { kind: "removeBlocker", blockerId: "b" },
      BY
    )
    expect(removeIssueBlocker).toHaveBeenCalledWith("p6", "b", BY)
    const ref = { provider: "lark-task", externalId: "g" }
    await applyIssueBulkAction([item({ sourceId: "p7" })], { kind: "linkExternal", ref }, BY)
    expect(linkIssueExternal).toHaveBeenCalledWith("p7", ref, BY)
    await applyIssueBulkAction([item({ sourceId: "p8" })], { kind: "unlinkExternal", ref }, BY)
    expect(unlinkIssueExternal).toHaveBeenCalledWith("p8", ref, BY)
    await applyIssueBulkAction([item({ sourceId: "p9" })], { kind: "comment", body: "hi" }, BY)
    expect(addIssueComment).toHaveBeenCalledWith("p9", "hi", BY)
  })

  it("gates the planning actions on canEdit and comment on canComment", () => {
    const readOnly = item({ capabilities: { ...FULL_ISSUE_CAPABILITIES, canEdit: false } })
    expect(canApplyBulkAction(readOnly, { kind: "cycle", cycleId: null }, false).ok).toBe(false)
    expect(canApplyBulkAction(readOnly, { kind: "parent", parentId: null }, false).ok).toBe(false)
    expect(canApplyBulkAction(readOnly, { kind: "comment", body: "x" }, false).ok).toBe(true)
    const mute = item({ capabilities: { ...FULL_ISSUE_CAPABILITIES, canComment: false } })
    expect(canApplyBulkAction(mute, { kind: "comment", body: "x" }, false).ok).toBe(false)
  })

  it("refuses a title or description edit on a federated row", async () => {
    const outcome = await applyIssueBulkAction(
      [item({ kind: "github", sourceId: "o/r#1" })],
      { kind: "title", to: "Renamed" },
      BY
    )
    expect(outcome).toMatchObject({ applied: 0, skipped: 1, reason: "federated-read-only" })
    expect(updateIssue).not.toHaveBeenCalled()
  })

  it("passes the source id, not the unified id, to the writer", async () => {
    await applyIssueBulkAction([item({ sourceId: "abc" })], { kind: "delete" }, BY)
    expect(deleteIssue).toHaveBeenCalledWith("abc")
  })

  it("counts what it applied", async () => {
    const outcome = await applyIssueBulkAction(
      [item(), item(), item()],
      { kind: "priority", to: "low" },
      BY
    )
    expect(outcome).toEqual({ applied: 3, skipped: 0, failed: 0 })
  })

  it("skips federated rows instead of failing the whole batch", async () => {
    const outcome = await applyIssueBulkAction(
      [item(), item({ kind: "github", sourceId: "o/r#1" }), item()],
      { kind: "priority", to: "low" },
      BY
    )
    expect(outcome).toEqual({ applied: 2, skipped: 1, failed: 0, reason: "federated-read-only" })
    expect(updateIssue).toHaveBeenCalledTimes(2)
  })

  it("reports the run guard's own reason, not a generic one", async () => {
    const running = item()
    const outcome = await applyIssueBulkAction(
      [running],
      { kind: "status", to: "in_progress" },
      BY,
      new Set([running.unifiedId])
    )
    expect(outcome).toMatchObject({ applied: 0, skipped: 1, reason: "runtime-owned" })
    expect(moveIssue).not.toHaveBeenCalled()
  })

  it("keeps going after a row that throws, and counts it", async () => {
    ;(updateIssue as jest.Mock)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined)
    const outcome = await applyIssueBulkAction(
      [item(), item()],
      { kind: "priority", to: "low" },
      BY
    )
    expect(outcome).toEqual({ applied: 1, skipped: 0, failed: 1 })
  })

  it("treats a late denial from moveIssue as a failure, not a silent success", async () => {
    ;(moveIssue as jest.Mock).mockResolvedValueOnce("runtime-owned")
    const outcome = await applyIssueBulkAction([item()], { kind: "status", to: "done" }, BY)
    expect(outcome).toEqual({ applied: 0, skipped: 0, failed: 1 })
  })

  it("treats a vanished row as applied rather than failed", async () => {
    // `issue-not-found` means somebody else already removed it; the user's
    // intent is satisfied either way.
    ;(moveIssue as jest.Mock).mockResolvedValueOnce("issue-not-found")
    const outcome = await applyIssueBulkAction([item()], { kind: "status", to: "done" }, BY)
    expect(outcome).toEqual({ applied: 1, skipped: 0, failed: 0 })
  })

  it("writes nothing for an empty selection", async () => {
    expect(await applyIssueBulkAction([], { kind: "delete" }, BY)).toEqual({
      applied: 0,
      skipped: 0,
      failed: 0,
    })
    expect(deleteIssue).not.toHaveBeenCalled()
  })

  it("writes sequentially so the activity trail keeps a deterministic order", async () => {
    const order: string[] = []
    ;(updateIssue as jest.Mock).mockImplementation(async (id: string) => {
      order.push(`start:${id}`)
      await Promise.resolve()
      order.push(`end:${id}`)
    })
    await applyIssueBulkAction([item(), item()], { kind: "priority", to: "low" }, BY)
    expect(order).toEqual(["start:s1", "end:s1", "start:s2", "end:s2"])
  })
})
