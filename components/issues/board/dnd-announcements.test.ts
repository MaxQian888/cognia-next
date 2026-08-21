import type { IssueDropPreview } from "@/lib/issues/board-model"
import { statusCategoryOf } from "@/types/issues"
import type { IssueStatus } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import { buildIssueDndAnnouncements } from "./dnd-announcements"

let seq = 0
function item(over: Partial<UnifiedIssueItem> = {}): UnifiedIssueItem {
  seq += 1
  const sourceId = over.sourceId ?? `s${seq}`
  const status: IssueStatus = over.status ?? "todo"
  return {
    unifiedId: `local:${sourceId}`,
    kind: "local",
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
    capabilities: FULL_ISSUE_CAPABILITIES,
    ...over,
  }
}

/** Records the key + values instead of localizing, so assertions stay literal. */
function spyT() {
  const calls: Array<{ key: string; values?: Record<string, string | number> }> = []
  const t = (key: string, values?: Record<string, string | number>) => {
    calls.push({ key, values })
    return key
  }
  return { t, calls }
}

function build(
  items: UnifiedIssueItem[],
  preview: IssueDropPreview | null,
  sizes: Partial<Record<IssueStatus, number>> = {}
) {
  const { t, calls } = spyT()
  const announcements = buildIssueDndAnnouncements({
    itemsById: new Map(items.map((i) => [i.unifiedId, i])),
    columnSize: (status) => sizes[status] ?? 0,
    statusLabel: (status) => `col:${status}`,
    preview: () => preview,
    t,
  })
  return { announcements, calls }
}

beforeEach(() => {
  seq = 0
})

describe("buildIssueDndAnnouncements", () => {
  describe("onDragStart", () => {
    it("names the issue and the column it came from", () => {
      const a = item({ status: "todo" })
      const { announcements, calls } = build([a], null)
      announcements.onDragStart?.({ active: { id: a.unifiedId } } as never)
      expect(calls[0]).toEqual({
        key: "pickedUp",
        values: { identifier: "MERC-1", column: "col:todo" },
      })
    })

    it("says nothing about a card it does not know", () => {
      const { announcements, calls } = build([], null)
      announcements.onDragStart?.({ active: { id: "local:ghost" } } as never)
      expect(calls).toHaveLength(0)
    })
  })

  describe("onDragOver", () => {
    it("reports a 1-based position inside the target column", () => {
      const a = item({ status: "todo" })
      const { announcements, calls } = build([a], { status: "done", index: 1 }, { done: 2 })
      announcements.onDragOver?.({
        active: { id: a.unifiedId },
        over: { id: "col:done" },
      } as never)
      expect(calls[0]).toEqual({
        key: "over",
        values: { identifier: "MERC-1", column: "col:done", position: 2, total: 3 },
      })
    })

    it("counts the dragged card into the total for a cross-column move", () => {
      const a = item({ status: "todo" })
      const { announcements, calls } = build([a], { status: "done", index: 0 }, { done: 0 })
      announcements.onDragOver?.({
        active: { id: a.unifiedId },
        over: { id: "col:done" },
      } as never)
      expect(calls[0]?.values?.total).toBe(1)
    })

    it("does not double-count the dragged card in its own column", () => {
      const a = item({ status: "todo" })
      const { announcements, calls } = build([a], { status: "todo", index: 0 }, { todo: 3 })
      announcements.onDragOver?.({
        active: { id: a.unifiedId },
        over: { id: "local:other" },
      } as never)
      expect(calls[0]?.values?.total).toBe(3)
    })

    it("announces a refusal instead of staying silent", () => {
      const a = item({ status: "todo" })
      const { announcements, calls } = build([a], null)
      announcements.onDragOver?.({
        active: { id: a.unifiedId },
        over: { id: "col:done" },
      } as never)
      expect(calls[0]).toEqual({ key: "denied", values: { identifier: "MERC-1" } })
    })

    it("treats leaving every target as a cancel-in-progress", () => {
      const a = item({ status: "todo" })
      const { announcements, calls } = build([a], null)
      announcements.onDragOver?.({ active: { id: a.unifiedId }, over: null } as never)
      expect(calls[0]).toEqual({
        key: "cancelled",
        values: { identifier: "MERC-1", column: "col:todo" },
      })
    })
  })

  describe("onDragEnd", () => {
    it("uses the past tense for a landed card", () => {
      const a = item({ status: "todo" })
      const { announcements, calls } = build([a], { status: "done", index: 0 }, { done: 0 })
      announcements.onDragEnd?.({
        active: { id: a.unifiedId },
        over: { id: "col:done" },
      } as never)
      expect(calls[0]?.key).toBe("dropped")
    })

    it("announces a drop outside every target as a cancel", () => {
      const a = item({ status: "todo" })
      const { announcements, calls } = build([a], null)
      announcements.onDragEnd?.({ active: { id: a.unifiedId }, over: null } as never)
      expect(calls[0]?.key).toBe("cancelled")
    })
  })

  describe("onDragCancel", () => {
    it("says where the card stayed", () => {
      const a = item({ status: "in_review" })
      const { announcements, calls } = build([a], null)
      announcements.onDragCancel?.({ active: { id: a.unifiedId } } as never)
      expect(calls[0]).toEqual({
        key: "cancelled",
        values: { identifier: "MERC-1", column: "col:in_review" },
      })
    })
  })
})
