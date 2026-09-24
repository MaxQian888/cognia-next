import type { ChatSession, SessionFolder } from "@cognia/agent-config-types"

import type { ConversationSection } from "@/lib/chat/conversation-list-model"

import {
  buildMobileChannelListItems,
  findRowIndex,
  rowItemKey,
  type BuildMobileChannelListItemsInput,
} from "./mobile-channel-list-items"

const session = (id: string): ChatSession => ({
  id,
  title: id,
  createdAt: 1,
  updatedAt: 1,
  kind: "direct",
})

const folder = (id: string): SessionFolder =>
  ({ id, name: id, order: 0, createdAt: 0, updatedAt: 0 }) as SessionFolder

const base: BuildMobileChannelListItemsInput = {
  sections: [],
  narrowed: false,
  truncated: false,
  pending: false,
  empty: false,
}

const kinds = (input: Partial<BuildMobileChannelListItemsInput>) =>
  buildMobileChannelListItems({ ...base, ...input }).map((item) => item.key)

describe("buildMobileChannelListItems", () => {
  it("flattens sections into a header followed by its rows, in section order", () => {
    const sections: ConversationSection[] = [
      { kind: "pinned", sessions: [session("a")] },
      { kind: "date", bucket: "today", sessions: [session("b"), session("c")] },
    ]
    expect(kinds({ sections })).toEqual([
      "header:pinned",
      "row:a",
      "header:date:today",
      "row:b",
      "row:c",
    ])
  })

  it("counts every section's rows on its header, even when folded", () => {
    const sections: ConversationSection[] = [
      { kind: "folder", folder: folder("f"), sessions: [session("a"), session("b")], collapsed: true },
      {
        kind: "group",
        axis: "workspace",
        group: { id: "w", name: "W" },
        sessions: [session("c")],
        collapsed: false,
      },
    ]
    const items = buildMobileChannelListItems({ ...base, sections })
    expect(items.map((item) => item.key)).toEqual(["header:folder:f", "header:workspace:w", "row:c"])
    const [folded, group] = items
    expect(folded).toMatchObject({ kind: "header", count: 2, sectionKey: "folder:f" })
    expect(group).toMatchObject({ kind: "header", count: 1, sectionKey: "workspace:w" })
    expect(items[2]).toMatchObject({ kind: "row", sectionKey: "workspace:w" })
  })

  it("explains an expanded empty folder instead of leaving a bare heading", () => {
    const sections: ConversationSection[] = [
      { kind: "folder", folder: folder("f"), sessions: [], collapsed: false },
    ]
    expect(kinds({ sections })).toEqual(["header:folder:f", "folder-empty:f"])
  })

  it("keeps a folded empty folder's header but not the hint", () => {
    const sections: ConversationSection[] = [
      { kind: "folder", folder: folder("f"), sessions: [], collapsed: true },
    ]
    expect(kinds({ sections })).toEqual(["header:folder:f"])
  })

  it("hides empty folders while a query or filter narrows the list", () => {
    // Next to "nothing matched", an empty folder header reads as a result.
    const sections: ConversationSection[] = [
      { kind: "folder", folder: folder("f"), sessions: [], collapsed: false },
      { kind: "folder", folder: folder("g"), sessions: [session("a")], collapsed: false },
    ]
    expect(kinds({ sections, narrowed: true, empty: false })).toEqual([
      "header:folder:g",
      "row:a",
    ])
  })

  it("puts status notices above the rows, and never says empty while still searching", () => {
    expect(kinds({ truncated: true, pending: true, empty: true })).toEqual([
      "notice:truncated",
      "notice:pending",
    ])
    expect(kinds({ empty: true })).toEqual(["notice:empty"])
  })

  it("drops a section the model emitted with no rows unless it is a folder", () => {
    const sections: ConversationSection[] = [{ kind: "recent", sessions: [] }]
    expect(kinds({ sections })).toEqual([])
  })
})

describe("findRowIndex", () => {
  it("finds a rendered row and reports -1 for one that is folded away", () => {
    const items = buildMobileChannelListItems({
      ...base,
      sections: [
        { kind: "pinned", sessions: [session("a")] },
        { kind: "folder", folder: folder("f"), sessions: [session("b")], collapsed: true },
      ],
    })
    expect(findRowIndex(items, "a")).toBe(1)
    expect(findRowIndex(items, "b")).toBe(-1)
    expect(rowItemKey("a")).toBe("row:a")
  })
})
