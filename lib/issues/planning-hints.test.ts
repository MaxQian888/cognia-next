import { statusCategoryOf } from "@/types/issues"
import type { IssueCycle, IssueStatus } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES, READ_ONLY_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import { buildPlanningHints, hasPlanningBadges } from "./planning-hints"

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date("2026-09-06T12:00:00Z").getTime()

let seq = 0
function local(over: Partial<UnifiedIssueItem> = {}): UnifiedIssueItem {
  seq += 1
  const sourceId = over.sourceId ?? `i${seq}`
  const status: IssueStatus = over.status ?? "todo"
  return {
    unifiedId: `local:${sourceId}`,
    kind: "local",
    sourceId,
    identifier: `MERC-${seq}`,
    title: "t",
    status,
    statusCategory: statusCategoryOf(status),
    priority: "none",
    labelIds: [],
    order: 0,
    createdAt: 1,
    updatedAt: 1,
    origin: { deepLinkHref: "/issues" },
    capabilities: FULL_ISSUE_CAPABILITIES,
    ...over,
  }
}

function cycle(over: Partial<IssueCycle> = {}): IssueCycle {
  return {
    id: "c1",
    projectId: "w1",
    kind: "cycle",
    name: "Sprint 1",
    status: "active",
    externalRefs: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

describe("buildPlanningHints", () => {
  it("marks an issue blocked only by open blockers that exist", () => {
    const done = local({ sourceId: "done", status: "done" })
    const open = local({ sourceId: "open" })
    const target = local({ sourceId: "t", blockedBy: ["done", "open", "ghost"] })
    const hint = buildPlanningHints([done, open, target], new Map(), NOW).get(target.unifiedId)!
    expect(hint.blocked).toBe(true)
    expect(hint.blockerIdentifiers).toEqual([open.identifier])
  })

  it("is not blocked when every blocker is finished or gone", () => {
    const done = local({ sourceId: "done", status: "done" })
    const target = local({ sourceId: "t", blockedBy: ["done", "ghost"] })
    const hint = buildPlanningHints([done, target], new Map(), NOW).get(target.unifiedId)!
    expect(hint.blocked).toBe(false)
    expect(hint.blockerIdentifiers).toEqual([])
  })

  it("counts direct children and their completion on the parent", () => {
    const parent = local({ sourceId: "p" })
    const a = local({ sourceId: "a", parentId: "p", status: "done" })
    const b = local({ sourceId: "b", parentId: "p" })
    const grandchild = local({ sourceId: "g", parentId: "a", status: "done" })
    const hints = buildPlanningHints([parent, a, b, grandchild], new Map(), NOW)
    expect(hints.get(parent.unifiedId)!.subIssues).toEqual({ total: 2, done: 1 })
    expect(hints.get(a.unifiedId)!.subIssues).toEqual({ total: 1, done: 1 })
    expect(hints.get(a.unifiedId)!.parentIdentifier).toBe(parent.identifier)
    expect(hints.get(b.unifiedId)!.subIssues).toBeUndefined()
  })

  it("resolves the cycle name and the due state", () => {
    const item = local({ cycleId: "c1", dueDate: NOW - DAY })
    const hint = buildPlanningHints([item], new Map([["c1", cycle()]]), NOW).get(item.unifiedId)!
    expect(hint.cycleName).toBe("Sprint 1")
    expect(hint.due).toBe("overdue")
  })

  it("builds a hint for federated rows too, without relations", () => {
    const github: UnifiedIssueItem = {
      ...local({ sourceId: "gh" }),
      unifiedId: "github:gh",
      kind: "github",
      capabilities: READ_ONLY_ISSUE_CAPABILITIES,
      blockedBy: ["x"],
    }
    const hint = buildPlanningHints([github], new Map(), NOW).get("github:gh")!
    expect(hint.blocked).toBe(false)
    expect(hint.due).toBe("none")
  })
})

describe("hasPlanningBadges", () => {
  it("is false for a quiet hint and for no hint", () => {
    expect(hasPlanningBadges(undefined)).toBe(false)
    expect(hasPlanningBadges({ blocked: false, blockerIdentifiers: [], due: "later" })).toBe(false)
    expect(hasPlanningBadges({ blocked: false, blockerIdentifiers: [], due: "met" })).toBe(false)
  })

  it("is true when blocked, due soon, or a parent", () => {
    expect(hasPlanningBadges({ blocked: true, blockerIdentifiers: ["A-1"], due: "none" })).toBe(
      true
    )
    expect(hasPlanningBadges({ blocked: false, blockerIdentifiers: [], due: "soon" })).toBe(true)
    expect(
      hasPlanningBadges({
        blocked: false,
        blockerIdentifiers: [],
        due: "none",
        subIssues: { total: 2, done: 0 },
      })
    ).toBe(true)
  })
})
