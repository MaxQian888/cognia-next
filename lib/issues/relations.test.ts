import type { Issue } from "@/types/issues"
import { statusCategoryOf } from "@/types/issues"
import {
  blockedIssues,
  childIssues,
  cycleProgress,
  dueState,
  DUE_SOON_WINDOW_MS,
  isBlocked,
  issueRelations,
  openBlockers,
  subIssueProgress,
  wouldCreateParentLoop,
} from "./relations"

const DAY = 24 * 60 * 60 * 1000

function issue(over: Partial<Issue> & { id: string }): Issue {
  const status = over.status ?? "todo"
  return {
    identifier: over.id.toUpperCase(),
    number: 1,
    projectId: "w1",
    issueProjectId: "p1",
    title: over.id,
    status,
    statusCategory: statusCategoryOf(status),
    priority: "none",
    createdBy: { kind: "human" },
    labelIds: [],
    order: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

const byId = (rows: Issue[]) => new Map(rows.map((row) => [row.id, row]))

describe("issueRelations", () => {
  it("fills the three optional arrays with defaults", () => {
    expect(issueRelations({})).toEqual({ blockedBy: [], externalRefs: [] })
    expect(issueRelations({ parentId: "p", blockedBy: ["a"] })).toEqual({
      parentId: "p",
      blockedBy: ["a"],
      externalRefs: [],
    })
  })
})

describe("blockers", () => {
  it("lists only open, existing blockers", () => {
    const rows = [
      issue({ id: "a" }),
      issue({ id: "b", status: "done" }),
      issue({ id: "c", status: "canceled" }),
    ]
    const target = issue({ id: "t", blockedBy: ["a", "b", "c", "ghost"] })
    expect(openBlockers(target, byId(rows)).map((row) => row.id)).toEqual(["a"])
    expect(isBlocked(target, byId(rows))).toBe(true)
    expect(isBlocked(issue({ id: "u", blockedBy: ["b"] }), byId(rows))).toBe(false)
    expect(isBlocked(issue({ id: "v" }), byId(rows))).toBe(false)
  })

  it("derives the blocks side", () => {
    const rows = [issue({ id: "a" }), issue({ id: "b", blockedBy: ["a"] }), issue({ id: "c" })]
    expect(blockedIssues("a", rows).map((row) => row.id)).toEqual(["b"])
  })
})

describe("hierarchy", () => {
  it("lists direct children and counts their progress", () => {
    const rows = [
      issue({ id: "p" }),
      issue({ id: "a", parentId: "p", status: "done" }),
      issue({ id: "b", parentId: "p" }),
      issue({ id: "g", parentId: "a", status: "done" }),
    ]
    expect(childIssues("p", rows).map((row) => row.id)).toEqual(["a", "b"])
    expect(subIssueProgress("p", rows)).toEqual({ total: 2, done: 1 })
    expect(subIssueProgress("b", rows)).toEqual({ total: 0, done: 0 })
  })

  it("detects a parent loop before the write refuses it", () => {
    const rows = [
      issue({ id: "a" }),
      issue({ id: "b", parentId: "a" }),
      issue({ id: "c", parentId: "b" }),
    ]
    const map = byId(rows)
    expect(wouldCreateParentLoop("a", "a", map)).toBe(true)
    expect(wouldCreateParentLoop("a", "c", map)).toBe(true)
    expect(wouldCreateParentLoop("c", "a", map)).toBe(false)
    expect(wouldCreateParentLoop("a", "ghost", map)).toBe(false)
  })
})

describe("dueState", () => {
  const now = new Date("2026-09-06T15:00:00").getTime()

  it("reads the calendar, not the clock", () => {
    expect(dueState(issue({ id: "x" }), now)).toBe("none")
    expect(dueState(issue({ id: "x", dueDate: now - 2 * DAY }), now)).toBe("overdue")
    expect(dueState(issue({ id: "x", dueDate: now - 60_000 }), now)).toBe("today")
    expect(dueState(issue({ id: "x", dueDate: now + 60_000 }), now)).toBe("today")
    expect(dueState(issue({ id: "x", dueDate: now + DUE_SOON_WINDOW_MS - 1 }), now)).toBe("soon")
    expect(dueState(issue({ id: "x", dueDate: now + 30 * DAY }), now)).toBe("later")
  })

  it("never shouts overdue on a finished issue", () => {
    expect(dueState(issue({ id: "x", dueDate: now - 5 * DAY, status: "done" }), now)).toBe("met")
    expect(dueState(issue({ id: "x", dueDate: now - 5 * DAY, status: "canceled" }), now)).toBe(
      "met"
    )
  })
})

describe("cycleProgress", () => {
  it("sums counts and points for one cycle only", () => {
    const rows = [
      issue({ id: "a", cycleId: "c1", estimate: 3, status: "done" }),
      issue({ id: "b", cycleId: "c1", estimate: 5 }),
      issue({ id: "c", cycleId: "c1" }),
      issue({ id: "d", cycleId: "c2", estimate: 8 }),
    ]
    expect(cycleProgress("c1", rows)).toEqual({ total: 3, done: 1, points: 8, pointsDone: 3 })
    expect(cycleProgress("zzz", rows)).toEqual({ total: 0, done: 0, points: 0, pointsDone: 0 })
  })
})
