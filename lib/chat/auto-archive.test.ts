import {
  AUTO_ARCHIVE_AFTER_DAYS_OPTIONS,
  AUTO_ARCHIVE_DAY_MS,
  conversationLastActivityAt,
  isAutoArchiveAfterDays,
  isAutoArchiveEligible,
  resolveAutoArchiveAfterDays,
  selectAutoArchiveCandidates,
  type AutoArchiveCandidate,
} from "./auto-archive"

const NOW = 1_800_000_000_000
const daysAgo = (days: number) => NOW - days * AUTO_ARCHIVE_DAY_MS

function row(id: string, patch: Partial<AutoArchiveCandidate> = {}): AutoArchiveCandidate {
  return { id, updatedAt: daysAgo(40), lastMessageAt: daysAgo(40), ...patch }
}

const base = { now: NOW, afterDays: 30 }

describe("resolveAutoArchiveAfterDays", () => {
  it("offers one ascending list of day counts", () => {
    expect([...AUTO_ARCHIVE_AFTER_DAYS_OPTIONS]).toEqual([7, 14, 30, 60, 90])
    expect(Object.isFrozen(AUTO_ARCHIVE_AFTER_DAYS_OPTIONS)).toBe(true)
  })

  it.each(AUTO_ARCHIVE_AFTER_DAYS_OPTIONS)("accepts %i days", (days) => {
    expect(resolveAutoArchiveAfterDays({ autoArchiveAfterDays: days })).toBe(days)
    expect(isAutoArchiveAfterDays(days)).toBe(true)
  })

  it.each([undefined, null, 0, -7, 8, 31, 365, Number.NaN, Number.POSITIVE_INFINITY])(
    "resolves %p to off instead of guessing a nearby option",
    (value) => {
      expect(resolveAutoArchiveAfterDays({ autoArchiveAfterDays: value })).toBeNull()
    }
  )

  it("treats an absent settings object as off", () => {
    expect(resolveAutoArchiveAfterDays(undefined)).toBeNull()
    expect(resolveAutoArchiveAfterDays(null)).toBeNull()
    expect(resolveAutoArchiveAfterDays({})).toBeNull()
    expect(isAutoArchiveAfterDays("30")).toBe(false)
  })
})

describe("conversationLastActivityAt", () => {
  it("reads the last message first, then the last update, then zero", () => {
    expect(conversationLastActivityAt({ lastMessageAt: 5, updatedAt: 9 })).toBe(5)
    expect(conversationLastActivityAt({ updatedAt: 9 })).toBe(9)
    expect(conversationLastActivityAt({} as Pick<AutoArchiveCandidate, "updatedAt">)).toBe(0)
  })
})

describe("selectAutoArchiveCandidates", () => {
  it("selects listed conversations idle for longer than the threshold", () => {
    const ids = selectAutoArchiveCandidates(
      [
        row("old"),
        row("fresh", { lastMessageAt: daysAgo(2), updatedAt: daysAgo(2) }),
        // Last message is old, but the basis is the message, not the update.
        row("old-message", { lastMessageAt: daysAgo(31), updatedAt: daysAgo(1) }),
        // No message yet: falls back to the update.
        row("empty-old", { lastMessageAt: undefined, updatedAt: daysAgo(45) }),
      ],
      base
    )
    expect(ids).toEqual(["old", "old-message", "empty-old"])
  })

  it("keeps a conversation exactly at the threshold", () => {
    expect(
      selectAutoArchiveCandidates([row("edge", { lastMessageAt: daysAgo(30) })], base)
    ).toEqual([])
    expect(
      selectAutoArchiveCandidates([row("past", { lastMessageAt: daysAgo(30) - 1 })], base)
    ).toEqual(["past"])
  })

  it("never selects embedded or subagent sessions the main list hides", () => {
    expect(
      selectAutoArchiveCandidates(
        [
          row("aside", { visibility: "embedded" }),
          row("workbench", { kind: "resource-workbench" }),
          row("editor", { kind: "workflow-editor" }),
          row("subagent", { kind: "subagent" }),
          row("direct", { kind: "direct" }),
        ],
        base
      )
    ).toEqual(["direct"])
  })

  it("skips archived, pinned, handed-off and IM-bound conversations", () => {
    expect(
      selectAutoArchiveCandidates(
        [
          row("archived", { archivedAt: daysAgo(35) }),
          row("pinned", { pinned: true }),
          row("handoff", { handoffLock: { ticketId: "t1", state: "frozen", at: daysAgo(40) } }),
          row("im", {
            platformBinding: {
              platform: "lark",
            } as unknown as AutoArchiveCandidate["platformBinding"],
          }),
          row("plain"),
        ],
        base
      )
    ).toEqual(["plain"])
  })

  it("skips the open, running and otherwise-open conversations", () => {
    expect(
      selectAutoArchiveCandidates([row("active"), row("running"), row("tab"), row("idle")], {
        ...base,
        activeSessionId: "active",
        runningIds: new Set(["running"]),
        openIds: new Set(["tab"]),
      })
    ).toEqual(["idle"])
  })

  it("keeps a project coordinator and its unresolved threads, archives resolved threads", () => {
    const thread = (resolvedAt?: number) =>
      ({
        coordinatorSessionId: "coord",
        brief: "brief",
        proposedBy: "coordinator",
        ...(resolvedAt !== undefined ? { resolvedAt, resolvedBy: "user" } : {}),
      }) as AutoArchiveCandidate["projectThread"]
    expect(
      selectAutoArchiveCandidates(
        [
          row("coord", { projectRole: "coordinator" }),
          row("open-thread", { projectRole: "thread", projectThread: thread() }),
          row("done-thread", { projectRole: "thread", projectThread: thread(daysAgo(35)) }),
          row("no-state-thread", { projectRole: "thread" }),
        ],
        base
      )
    ).toEqual(["done-thread"])
  })

  it("keeps attached children their parent still drives", () => {
    const child = (status: NonNullable<AutoArchiveCandidate["attachedChild"]>["status"]) =>
      ({
        parentSessionId: "parent",
        lifecycleOwnerSessionId: "parent",
        context: "fresh",
        workspace: "shared",
        status,
        createdAt: daysAgo(40),
      }) as unknown as AutoArchiveCandidate["attachedChild"]
    expect(
      selectAutoArchiveCandidates(
        [
          row("staged", { attachedChild: child("staged") }),
          row("running", { attachedChild: child("running") }),
          row("completed", { attachedChild: child("completed") }),
          row("closed", { attachedChild: child("closed") }),
          row("interrupted", { attachedChild: child("interrupted") }),
        ],
        base
      )
    ).toEqual(["completed", "closed", "interrupted"])
  })

  it("yields each id once when the input repeats a row", () => {
    expect(selectAutoArchiveCandidates([row("a"), row("a"), row("b")], base)).toEqual(["a", "b"])
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "selects nothing for an unusable threshold (%p)",
    (afterDays) => {
      expect(selectAutoArchiveCandidates([row("old")], { ...base, afterDays })).toEqual([])
      expect(isAutoArchiveEligible(row("old"), { ...base, afterDays })).toBe(false)
    }
  )
})
