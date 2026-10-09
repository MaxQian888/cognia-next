import type { ChatSession } from "@cognia/agent-config-types"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import {
  applyTriageAction,
  bulkTriage,
  inverseTriageActions,
  isTriageNoop,
  isUndoableTriageAction,
  labelStateAcross,
  labelToggleAction,
  summarizeTriageResult,
  toggleTriageAction,
  triageMessageKey,
  triageTargetOf,
  type TriageAction,
  type TriageTarget,
  type TriageWriters,
} from "./bulk-triage"
import type { ConversationRowItem } from "./conversation-grouping"

function target(id: string, extra: Partial<TriageTarget> = {}): TriageTarget {
  return {
    sessionId: id,
    conversationKey: `tg:a1:${id}`,
    adapterId: "a1",
    status: "open",
    labelIds: [],
    pinned: false,
    archived: false,
    unread: false,
    ...extra,
  }
}

function writers(overrides: Partial<TriageWriters> = {}): jest.Mocked<Required<TriageWriters>> {
  return {
    markRead: jest.fn(async () => {}),
    markUnread: jest.fn(async () => {}),
    setPinned: jest.fn(async () => {}),
    setArchived: jest.fn(async () => {}),
    setStatus: jest.fn(async () => {}),
    setAssignee: jest.fn(async () => {}),
    addLabel: jest.fn(async () => {}),
    removeLabel: jest.fn(async () => {}),
    notifyAssignment: jest.fn(async () => {}),
    ...overrides,
  } as jest.Mocked<Required<TriageWriters>>
}

describe("triageTargetOf", () => {
  it("captures everything a write and its undo need from a row", () => {
    const row: ConversationRowItem = {
      session: {
        id: "s1",
        pinned: true,
        archivedAt: 5,
        platformBinding: { adapterId: "a1", conversationKey: "tg:a1:c1", platform: "telegram" },
      } as unknown as ChatSession,
      override: {
        id: "o1",
        conversationKey: "tg:a1:c1",
        status: "snoozed",
        snoozeUntil: 99,
        assignee: { kind: "human" },
        labelIds: ["l1"],
      } as ConversationOverrideRow,
      unreadCount: 2,
    }
    expect(triageTargetOf(row)).toEqual({
      sessionId: "s1",
      conversationKey: "tg:a1:c1",
      adapterId: "a1",
      status: "snoozed",
      snoozeUntil: 99,
      assignee: { kind: "human" },
      labelIds: ["l1"],
      pinned: true,
      archived: true,
      unread: true,
    })
  })

  it("defaults a row without an override to open, unlabelled, unassigned", () => {
    const row = {
      session: { id: "s2", platformBinding: { adapterId: "", conversationKey: "k" } },
      override: undefined,
      unreadCount: 0,
    } as unknown as ConversationRowItem
    expect(triageTargetOf(row)).toMatchObject({
      status: "open",
      labelIds: [],
      adapterId: undefined,
      pinned: false,
      archived: false,
      unread: false,
    })
  })
})

describe("isTriageNoop", () => {
  it.each<[TriageAction, Partial<TriageTarget>, boolean]>([
    [{ kind: "markRead" }, { unread: false }, true],
    [{ kind: "markRead" }, { unread: true }, false],
    [{ kind: "markUnread" }, { unread: true }, true],
    [{ kind: "setPinned", pinned: true }, { pinned: true }, true],
    [{ kind: "setArchived", archived: false }, { archived: true }, false],
    [{ kind: "setStatus", status: "resolved" }, { status: "resolved" }, true],
    [{ kind: "setStatus", status: "snoozed", snoozeUntil: 5 }, { status: "snoozed" }, false],
    [{ kind: "setAssignee", assignee: null }, {}, true],
    [{ kind: "setAssignee", assignee: { kind: "human" } }, { assignee: { kind: "human" } }, true],
    [
      { kind: "setAssignee", assignee: { kind: "character", id: "b" } },
      { assignee: { kind: "character", id: "a" } },
      false,
    ],
    [{ kind: "addLabel", labelId: "l1" }, { labelIds: ["l1"] }, true],
    [{ kind: "removeLabel", labelId: "l1" }, { labelIds: [] }, true],
  ])("%j on %j → %s", (action, extra, expected) => {
    expect(isTriageNoop(action, target("s", extra))).toBe(expected)
  })
})

describe("applyTriageAction", () => {
  it("routes each action to its writer", async () => {
    const w = writers()
    const t = target("s1", { assignee: { kind: "human" } })
    await applyTriageAction({ kind: "markRead" }, t, w)
    await applyTriageAction({ kind: "markUnread" }, t, w)
    await applyTriageAction({ kind: "setPinned", pinned: true }, t, w)
    await applyTriageAction({ kind: "setArchived", archived: true }, t, w)
    await applyTriageAction({ kind: "setStatus", status: "snoozed", snoozeUntil: 10 }, t, w)
    await applyTriageAction({ kind: "setStatus", status: "open", snoozeUntil: 10 }, t, w)
    await applyTriageAction({ kind: "addLabel", labelId: "l1" }, t, w)
    await applyTriageAction({ kind: "removeLabel", labelId: "l2" }, t, w)
    expect(w.markRead).toHaveBeenCalledWith("s1")
    expect(w.markUnread).toHaveBeenCalledWith("s1")
    expect(w.setPinned).toHaveBeenCalledWith("s1", true)
    expect(w.setArchived).toHaveBeenCalledWith("s1", true)
    expect(w.setStatus).toHaveBeenNthCalledWith(1, {
      conversationKey: "tg:a1:s1",
      sessionId: "s1",
      status: "snoozed",
      snoozeUntil: 10,
    })
    // A wake-up time only travels with a snooze.
    expect(w.setStatus).toHaveBeenNthCalledWith(2, {
      conversationKey: "tg:a1:s1",
      sessionId: "s1",
      status: "open",
      snoozeUntil: undefined,
    })
    expect(w.addLabel).toHaveBeenCalledWith({
      conversationKey: "tg:a1:s1",
      sessionId: "s1",
      labelId: "l1",
    })
    expect(w.removeLabel).toHaveBeenCalledWith({
      conversationKey: "tg:a1:s1",
      sessionId: "s1",
      labelId: "l2",
    })
  })

  it("assigns with the adapter id and notifies only when asked", async () => {
    const w = writers()
    const t = target("s1", { assignee: { kind: "human" } })
    const to = { kind: "team" as const, id: "t1", label: "Ops" }
    await applyTriageAction({ kind: "setAssignee", assignee: to }, t, w)
    expect(w.setAssignee).toHaveBeenCalledWith({
      conversationKey: "tg:a1:s1",
      sessionId: "s1",
      adapterId: "a1",
      assignee: to,
    })
    expect(w.notifyAssignment).not.toHaveBeenCalled()
    await applyTriageAction({ kind: "setAssignee", assignee: null }, t, w, {
      notifyAssignment: true,
    })
    expect(w.notifyAssignment).toHaveBeenCalledWith({
      conversationKey: "tg:a1:s1",
      from: { kind: "human" },
      to: null,
    })
  })
})

describe("bulkTriage", () => {
  it("writes every target independently and reports which failed", async () => {
    const w = writers({
      markRead: jest.fn(async (id: string) => {
        if (id === "bad") throw new Error("relay dropped")
      }),
    })
    const result = await bulkTriage(
      { kind: "markRead" },
      [
        target("a", { unread: true }),
        target("bad", { unread: true }),
        target("c", { unread: true }),
      ],
      w
    )
    expect(result.succeeded.map((t) => t.sessionId)).toEqual(["a", "c"])
    expect(result.failed).toEqual([{ sessionId: "bad", error: new Error("relay dropped") }])
    expect(result.skipped).toEqual([])
  })

  it("skips no-ops and duplicate targets", async () => {
    const w = writers()
    const result = await bulkTriage(
      { kind: "markRead" },
      [target("a", { unread: true }), target("a", { unread: true }), target("b")],
      w
    )
    expect(w.markRead).toHaveBeenCalledTimes(1)
    expect(result.succeeded.map((t) => t.sessionId)).toEqual(["a"])
    expect(result.skipped.map((t) => t.sessionId)).toEqual(["b"])
  })

  it("notifies an assignment for one conversation but not for a bulk run", async () => {
    const single = writers()
    await bulkTriage({ kind: "setAssignee", assignee: { kind: "human" } }, [target("a")], single)
    expect(single.notifyAssignment).toHaveBeenCalledTimes(1)

    const bulk = writers()
    await bulkTriage(
      { kind: "setAssignee", assignee: { kind: "human" } },
      [target("a"), target("b")],
      bulk
    )
    expect(bulk.setAssignee).toHaveBeenCalledTimes(2)
    expect(bulk.notifyAssignment).not.toHaveBeenCalled()
  })
})

describe("toggleTriageAction", () => {
  it("goes forward while any target still needs it", () => {
    expect(toggleTriageAction("read", [target("a"), target("b", { unread: true })])).toEqual({
      kind: "markRead",
    })
    expect(toggleTriageAction("read", [target("a")])).toEqual({ kind: "markUnread" })
    expect(toggleTriageAction("pin", [target("a", { pinned: true }), target("b")])).toEqual({
      kind: "setPinned",
      pinned: true,
    })
    expect(toggleTriageAction("pin", [target("a", { pinned: true })])).toEqual({
      kind: "setPinned",
      pinned: false,
    })
    expect(toggleTriageAction("archive", [target("a", { archived: true })])).toEqual({
      kind: "setArchived",
      archived: false,
    })
    expect(toggleTriageAction("archive", [target("a"), target("b", { archived: true })])).toEqual({
      kind: "setArchived",
      archived: true,
    })
  })
})

describe("labels across a selection", () => {
  it("is tri-state", () => {
    expect(labelStateAcross("l", [])).toBe("unchecked")
    expect(labelStateAcross("l", [target("a", { labelIds: ["l"] })])).toBe("checked")
    expect(labelStateAcross("l", [target("a", { labelIds: ["l"] }), target("b")])).toBe("mixed")
    expect(labelStateAcross("l", [target("a")])).toBe("unchecked")
  })

  it("adds a mixed or missing label everywhere and removes a checked one", () => {
    expect(labelToggleAction("l", "mixed")).toEqual({ kind: "addLabel", labelId: "l" })
    expect(labelToggleAction("l", "unchecked")).toEqual({ kind: "addLabel", labelId: "l" })
    expect(labelToggleAction("l", "checked")).toEqual({ kind: "removeLabel", labelId: "l" })
  })
})

describe("inverseTriageActions", () => {
  const NOW = 1_000

  it("restores each conversation's previous status after a resolve", () => {
    const inverse = inverseTriageActions(
      { kind: "setStatus", status: "resolved" },
      [
        target("a", { status: "pending" }),
        target("b", { status: "snoozed", snoozeUntil: NOW + 50 }),
        target("c", { status: "snoozed", snoozeUntil: NOW - 50 }),
      ],
      NOW
    )
    expect(inverse.map(({ action }) => action)).toEqual([
      { kind: "setStatus", status: "pending", snoozeUntil: undefined },
      { kind: "setStatus", status: "snoozed", snoozeUntil: NOW + 50 },
      // The snooze ran out in the meantime: back to open, not a dead snooze.
      { kind: "setStatus", status: "open", snoozeUntil: undefined },
    ])
    // The undo runs against the post-write state, so it is never a no-op.
    for (const { action, target: after } of inverse) {
      expect(isTriageNoop(action, after)).toBe(false)
    }
  })

  it("restores the archive flag", () => {
    const inverse = inverseTriageActions(
      { kind: "setArchived", archived: true },
      [target("a")],
      NOW
    )
    expect(inverse).toEqual([
      { action: { kind: "setArchived", archived: false }, target: target("a", { archived: true }) },
    ])
  })

  it("offers no undo for in-place changes", () => {
    expect(inverseTriageActions({ kind: "markRead" }, [target("a")], NOW)).toEqual([])
    expect(isUndoableTriageAction({ kind: "markRead" })).toBe(false)
    expect(isUndoableTriageAction({ kind: "setStatus", status: "snoozed" })).toBe(false)
    expect(isUndoableTriageAction({ kind: "setStatus", status: "resolved" })).toBe(true)
    expect(isUndoableTriageAction({ kind: "setArchived", archived: false })).toBe(true)
  })
})

describe("reporting", () => {
  it("names every action", () => {
    expect(triageMessageKey({ kind: "markRead" })).toBe("markRead")
    expect(triageMessageKey({ kind: "markUnread" })).toBe("markUnread")
    expect(triageMessageKey({ kind: "setPinned", pinned: true })).toBe("pin")
    expect(triageMessageKey({ kind: "setPinned", pinned: false })).toBe("unpin")
    expect(triageMessageKey({ kind: "setArchived", archived: true })).toBe("archive")
    expect(triageMessageKey({ kind: "setArchived", archived: false })).toBe("unarchive")
    expect(triageMessageKey({ kind: "setStatus", status: "open" })).toBe("open")
    expect(triageMessageKey({ kind: "setStatus", status: "pending" })).toBe("pending")
    expect(triageMessageKey({ kind: "setStatus", status: "snoozed" })).toBe("snooze")
    expect(triageMessageKey({ kind: "setStatus", status: "resolved" })).toBe("resolve")
    expect(triageMessageKey({ kind: "setAssignee", assignee: { kind: "human" } })).toBe("assign")
    expect(triageMessageKey({ kind: "setAssignee", assignee: null })).toBe("unassign")
    expect(triageMessageKey({ kind: "addLabel", labelId: "l" })).toBe("labelAdd")
    expect(triageMessageKey({ kind: "removeLabel", labelId: "l" })).toBe("labelRemove")
  })

  it("summarises the tone from what landed", () => {
    const base = { action: { kind: "markRead" } as TriageAction, skipped: [] }
    expect(summarizeTriageResult({ ...base, succeeded: [], failed: [] }).tone).toBe("none")
    expect(summarizeTriageResult({ ...base, succeeded: [target("a")], failed: [] })).toEqual({
      tone: "success",
      messageKey: "markRead",
      done: 1,
      failed: 0,
      attempted: 1,
    })
    expect(
      summarizeTriageResult({
        ...base,
        succeeded: [target("a")],
        failed: [{ sessionId: "b", error: new Error("x") }],
      }).tone
    ).toBe("partial")
    expect(
      summarizeTriageResult({
        ...base,
        succeeded: [],
        failed: [{ sessionId: "b", error: new Error("x") }],
      }).tone
    ).toBe("error")
  })
})
