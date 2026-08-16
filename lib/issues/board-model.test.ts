import type { IssueActor, IssueStatus } from "@/types/issues"
import { statusCategoryOf } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import {
  FULL_ISSUE_CAPABILITIES,
  makeUnifiedIssueId,
  READ_ONLY_ISSUE_CAPABILITIES,
} from "@/types/issues/unified"
import {
  actorKey,
  applyIssueFilter,
  buildIssueColumns,
  buildIssueGroups,
  buildIssueSwimlanes,
  collectIssueFilterOptions,
  columnDropId,
  countActiveIssueFilters,
  EMPTY_ISSUE_FILTER,
  isIssueFilterActive,
  ISSUE_BOARD_COLUMN_ORDER,
  issueRunHint,
  parseDndId,
  reorderIssueColumn,
  resolveIssueDrop,
  sortIssueColumn,
} from "./board-model"

const AT_REST = { runActive: false }

let seq = 0
function item(over: Partial<UnifiedIssueItem> = {}): UnifiedIssueItem {
  seq += 1
  const kind = over.kind ?? "local"
  const sourceId = over.sourceId ?? `s${seq}`
  const status: IssueStatus = over.status ?? "todo"
  return {
    unifiedId: makeUnifiedIssueId(kind, sourceId),
    kind,
    sourceId,
    identifier: `KEY-${seq}`,
    title: `Issue ${seq}`,
    status,
    statusCategory: statusCategoryOf(status),
    priority: "none",
    labelIds: [],
    order: 0,
    createdAt: seq,
    updatedAt: seq,
    origin: { deepLinkHref: `/issues?id=${sourceId}` },
    capabilities: kind === "local" ? FULL_ISSUE_CAPABILITIES : READ_ONLY_ISSUE_CAPABILITIES,
    ...over,
  }
}

const HUMAN: IssueActor = { kind: "human" }
const AGENT: IssueActor = { kind: "agent", id: "a1" }

beforeEach(() => {
  seq = 0
})

describe("actorKey", () => {
  it("collapses the id-less local human to one stable key", () => {
    expect(actorKey(HUMAN)).toBe("human:self")
  })

  it("distinguishes actors of the same kind", () => {
    expect(actorKey(AGENT)).toBe("agent:a1")
    expect(actorKey({ kind: "agent", id: "a2" })).toBe("agent:a2")
  })

  it("distinguishes an agent from a team with the same id", () => {
    expect(actorKey({ kind: "agent", id: "x" })).not.toBe(actorKey({ kind: "team", id: "x" }))
  })

  it("returns null for no assignee", () => {
    expect(actorKey(undefined)).toBeNull()
  })
})

describe("filtering", () => {
  it("treats the empty filter as inactive and returns a copy", () => {
    const items = [item()]
    expect(isIssueFilterActive(EMPTY_ISSUE_FILTER)).toBe(false)
    const result = applyIssueFilter(items, EMPTY_ISSUE_FILTER)
    expect(result).toEqual(items)
    expect(result).not.toBe(items)
  })

  it("matches the query against identifier, title and description", () => {
    const items = [
      item({ identifier: "MERC-1", title: "alpha" }),
      item({ identifier: "COG-2", title: "beta", description: "mentions alpha" }),
      item({ identifier: "COG-3", title: "gamma" }),
    ]
    expect(
      applyIssueFilter(items, { ...EMPTY_ISSUE_FILTER, query: "alpha" }).map((i) => i.identifier)
    ).toEqual(["MERC-1", "COG-2"])
    expect(
      applyIssueFilter(items, { ...EMPTY_ISSUE_FILTER, query: "merc" }).map((i) => i.identifier)
    ).toEqual(["MERC-1"])
  })

  it("keeps an issue carrying ANY of the selected labels", () => {
    const items = [item({ labelIds: ["bug"] }), item({ labelIds: ["chore"] }), item()]
    expect(
      applyIssueFilter(items, { ...EMPTY_ISSUE_FILTER, labelIds: ["bug", "docs"] })
    ).toHaveLength(1)
  })

  it("filters by priority, source and delivery container", () => {
    const items = [
      item({ priority: "urgent", kind: "local", issueProjectId: "p1" }),
      item({ priority: "low", kind: "github", issueProjectId: "p2" }),
    ]
    expect(applyIssueFilter(items, { ...EMPTY_ISSUE_FILTER, priorities: ["urgent"] })).toHaveLength(
      1
    )
    expect(applyIssueFilter(items, { ...EMPTY_ISSUE_FILTER, sources: ["github"] })).toHaveLength(1)
    expect(
      applyIssueFilter(items, { ...EMPTY_ISSUE_FILTER, issueProjectIds: ["p1"] })
    ).toHaveLength(1)
  })

  it("drops unassigned issues when an assignee facet is engaged", () => {
    const items = [item({ assignee: AGENT }), item()]
    expect(
      applyIssueFilter(items, { ...EMPTY_ISSUE_FILTER, assignees: ["agent:a1"] })
    ).toHaveLength(1)
  })

  it("drops container-less issues when a container facet is engaged", () => {
    const items = [item({ issueProjectId: "p1" }), item()]
    expect(
      applyIssueFilter(items, { ...EMPTY_ISSUE_FILTER, issueProjectIds: ["p1"] })
    ).toHaveLength(1)
  })

  it("ANDs facets together", () => {
    const items = [
      item({ priority: "urgent", labelIds: ["bug"] }),
      item({ priority: "urgent", labelIds: ["chore"] }),
    ]
    expect(
      applyIssueFilter(items, {
        ...EMPTY_ISSUE_FILTER,
        priorities: ["urgent"],
        labelIds: ["bug"],
      })
    ).toHaveLength(1)
  })

  it("counts engaged facets for the toolbar badge, ignoring a blank query", () => {
    expect(countActiveIssueFilters(EMPTY_ISSUE_FILTER)).toBe(0)
    expect(countActiveIssueFilters({ ...EMPTY_ISSUE_FILTER, query: "   " })).toBe(0)
    expect(
      countActiveIssueFilters({ ...EMPTY_ISSUE_FILTER, query: "a", priorities: ["low"] })
    ).toBe(2)
  })

  it("collects the distinct facet values actually present", () => {
    const options = collectIssueFilterOptions([
      item({ labelIds: ["bug"], assignee: AGENT, issueProjectId: "p1" }),
      item({ labelIds: ["bug", "chore"], kind: "github", issueProjectId: "p2" }),
    ])
    expect(options.labelIds).toEqual(["bug", "chore"])
    expect(options.assignees).toEqual([{ key: "agent:a1", actor: AGENT }])
    expect(options.sources).toEqual(["github", "local"])
    expect(options.issueProjectIds).toEqual(["p1", "p2"])
  })
})

describe("buildIssueColumns", () => {
  it("returns every column in canonical order even when empty", () => {
    const columns = buildIssueColumns([])
    expect(columns.map((c) => c.status)).toEqual([...ISSUE_BOARD_COLUMN_ORDER])
    expect(columns.every((c) => c.items.length === 0)).toBe(true)
  })

  it("routes each item to its own column", () => {
    const columns = buildIssueColumns([item({ status: "done" }), item({ status: "backlog" })])
    expect(columns.find((c) => c.status === "done")!.items).toHaveLength(1)
    expect(columns.find((c) => c.status === "backlog")!.items).toHaveLength(1)
  })
})

describe("sortIssueColumn", () => {
  it("orders by manual order first", () => {
    const sorted = sortIssueColumn([item({ order: 2 }), item({ order: 0 }), item({ order: 1 })])
    expect(sorted.map((i) => i.order)).toEqual([0, 1, 2])
  })

  it("breaks ties on recency, then id, and does not mutate the input", () => {
    const input = [
      item({ sourceId: "b", order: 0, updatedAt: 5 }),
      item({ sourceId: "a", order: 0, updatedAt: 9 }),
    ]
    const snapshot = [...input]
    expect(sortIssueColumn(input).map((i) => i.sourceId)).toEqual(["a", "b"])
    expect(input).toEqual(snapshot)
  })
})

describe("buildIssueSwimlanes", () => {
  it("groups by assignee and appends the unassigned lane last", () => {
    const lanes = buildIssueSwimlanes([
      item({ assignee: AGENT }),
      item(),
      item({ assignee: HUMAN }),
    ])
    expect(lanes.map((l) => l.assigneeKey)).toEqual(["agent:a1", "human:self", null])
    expect(lanes.at(-1)!.itemCount).toBe(1)
  })

  it("omits the unassigned lane when everything is assigned", () => {
    const lanes = buildIssueSwimlanes([item({ assignee: AGENT })])
    expect(lanes.map((l) => l.assigneeKey)).toEqual(["agent:a1"])
  })

  it("carries the actor through for rendering", () => {
    expect(buildIssueSwimlanes([item({ assignee: AGENT })])[0].actor).toEqual(AGENT)
  })
})

describe("buildIssueGroups", () => {
  it("returns a single group for `none`", () => {
    expect(buildIssueGroups([item(), item()], "none")).toHaveLength(1)
  })

  it("orders status groups by lifecycle, not alphabetically", () => {
    const groups = buildIssueGroups(
      [item({ status: "done" }), item({ status: "backlog" }), item({ status: "in_progress" })],
      "status"
    )
    expect(groups.map((g) => g.key)).toEqual(["backlog", "in_progress", "done"])
  })

  it("orders priority groups by urgency", () => {
    const groups = buildIssueGroups(
      [item({ priority: "low" }), item({ priority: "urgent" }), item({ priority: "medium" })],
      "priority"
    )
    expect(groups.map((g) => g.key)).toEqual(["urgent", "medium", "low"])
  })

  it("sinks the catch-all group to the end", () => {
    const groups = buildIssueGroups([item(), item({ assignee: AGENT })], "assignee")
    expect(groups.at(-1)!.key).toBe("")
  })

  it("groups by delivery container", () => {
    const groups = buildIssueGroups(
      [item({ issueProjectId: "p1" }), item({ issueProjectId: "p2" })],
      "project"
    )
    expect(groups.map((g) => g.key)).toEqual(["p1", "p2"])
  })
})

describe("issueRunHint", () => {
  it("counts running issues and those awaiting review", () => {
    const running = item({ status: "in_progress" })
    const hint = issueRunHint(
      [running, item({ status: "in_review" }), item({ status: "todo" })],
      new Set([running.unifiedId])
    )
    expect(hint).toEqual({ running: 1, awaitingReview: 1 })
  })

  it("is all zeroes for an empty board", () => {
    expect(issueRunHint([], new Set())).toEqual({ running: 0, awaitingReview: 0 })
  })
})

describe("dnd ids", () => {
  it("round-trips a column id", () => {
    expect(parseDndId(columnDropId("in_review"))).toEqual({ kind: "column", status: "in_review" })
  })

  it("treats anything else as a card", () => {
    expect(parseDndId("local:abc")).toEqual({ kind: "card", unifiedId: "local:abc" })
  })
})

describe("resolveIssueDrop", () => {
  function indexOf(items: UnifiedIssueItem[]) {
    return new Map(items.map((i) => [i.unifiedId, i]))
  }

  it("returns null for a no-op drop", () => {
    const a = item()
    const map = indexOf([a])
    expect(resolveIssueDrop(null, "x", map, AT_REST)).toBeNull()
    expect(resolveIssueDrop(a.unifiedId, a.unifiedId, map, AT_REST)).toBeNull()
    expect(resolveIssueDrop("local:missing", columnDropId("done"), map, AT_REST)).toBeNull()
  })

  it("returns null when a card is dropped back on its own column", () => {
    const a = item({ status: "todo" })
    expect(resolveIssueDrop(a.unifiedId, columnDropId("todo"), indexOf([a]), AT_REST)).toBeNull()
  })

  it("resolves a cross-column drop into a guarded move", () => {
    const a = item({ status: "todo" })
    expect(resolveIssueDrop(a.unifiedId, columnDropId("done"), indexOf([a]), AT_REST)).toEqual({
      type: "move",
      unifiedId: a.unifiedId,
      to: "done",
    })
  })

  it("infers the target column from the card that was dropped on", () => {
    const a = item({ status: "todo" })
    const b = item({ status: "done" })
    expect(resolveIssueDrop(a.unifiedId, b.unifiedId, indexOf([a, b]), AT_REST)).toEqual({
      type: "move",
      unifiedId: a.unifiedId,
      to: "done",
    })
  })

  it("resolves a same-column card drop into a reorder", () => {
    const a = item({ status: "todo", order: 0 })
    const b = item({ status: "todo", order: 1 })
    expect(resolveIssueDrop(a.unifiedId, b.unifiedId, indexOf([a, b]), AT_REST)).toEqual({
      type: "reorder",
      unifiedId: a.unifiedId,
      targetIndex: 1,
    })
  })

  it("denies a move on a federated row", () => {
    const a = item({ kind: "github", status: "todo" })
    expect(resolveIssueDrop(a.unifiedId, columnDropId("done"), indexOf([a]), AT_REST)).toEqual({
      type: "denied",
      unifiedId: a.unifiedId,
      reason: "federated-read-only",
    })
  })

  it("denies a same-column reorder on a federated row too", () => {
    const a = item({ kind: "github", status: "todo", order: 0 })
    const b = item({ kind: "github", status: "todo", order: 1 })
    expect(resolveIssueDrop(a.unifiedId, b.unifiedId, indexOf([a, b]), AT_REST)).toEqual({
      type: "denied",
      unifiedId: a.unifiedId,
      reason: "federated-read-only",
    })
  })

  it("denies moving into in_progress while a run is in flight", () => {
    const a = item({ status: "todo" })
    expect(
      resolveIssueDrop(a.unifiedId, columnDropId("in_progress"), indexOf([a]), { runActive: true })
    ).toEqual({ type: "denied", unifiedId: a.unifiedId, reason: "runtime-owned" })
  })
})

describe("reorderIssueColumn", () => {
  it("renumbers the column and returns only the rows that moved", () => {
    const a = item({ sourceId: "a", order: 0 })
    const b = item({ sourceId: "b", order: 1 })
    const c = item({ sourceId: "c", order: 2 })
    expect(reorderIssueColumn([a, b, c], c.unifiedId, 0)).toEqual([
      { sourceId: "c", order: 0 },
      { sourceId: "a", order: 1 },
      { sourceId: "b", order: 2 },
    ])
  })

  it("returns nothing when the position does not change", () => {
    const a = item({ sourceId: "a", order: 0 })
    const b = item({ sourceId: "b", order: 1 })
    expect(reorderIssueColumn([a, b], a.unifiedId, 0)).toEqual([])
  })

  it("clamps an out-of-range target index", () => {
    const a = item({ sourceId: "a", order: 0 })
    const b = item({ sourceId: "b", order: 1 })
    expect(reorderIssueColumn([a, b], a.unifiedId, 99)).toEqual([
      { sourceId: "b", order: 0 },
      { sourceId: "a", order: 1 },
    ])
  })

  it("ignores an unknown id", () => {
    expect(reorderIssueColumn([item()], "local:nope", 0)).toEqual([])
  })

  it("never emits an order write for a federated row", () => {
    const gh = item({ kind: "github", sourceId: "g", order: 0 })
    const local = item({ sourceId: "l", order: 1 })
    const changes = reorderIssueColumn([gh, local], local.unifiedId, 0)
    expect(changes.every((c) => c.sourceId === "l")).toBe(true)
  })
})
