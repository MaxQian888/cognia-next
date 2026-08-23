import type { ChatSession, SessionFolder } from "@cognia/agent-config-types"

import type { ConversationSection } from "@/lib/chat/conversation-list-model"
import {
  freezeConversationLayout,
  mergeFrozenOrder,
  projectFrozenSections,
} from "@/lib/chat/conversation-order-freeze"

function row(id: string, overrides: Partial<ChatSession> = {}): ChatSession {
  return { id, title: id, createdAt: 0, updatedAt: 0, ...overrides } as ChatSession
}

function dateSection(bucket: "today" | "yesterday", ids: string[]): ConversationSection {
  return { kind: "date", bucket, sessions: ids.map((id) => row(id)) }
}

function folderSection(id: string, ids: string[]): ConversationSection {
  return {
    kind: "folder",
    folder: { id, name: id, order: 0, createdAt: 0, updatedAt: 0 } as SessionFolder,
    sessions: ids.map((r) => row(r)),
    collapsed: false,
  }
}

describe("mergeFrozenOrder", () => {
  it("passes the live order straight through when nothing is frozen", () => {
    const live = ["a", "b"]
    expect(mergeFrozenOrder([], live)).toBe(live)
  })

  it("returns the live array itself when it already agrees with the frozen order", () => {
    // Identity matters: this runs on every live-query emit and feeds memo deps.
    const live = ["a", "b", "c"]
    expect(mergeFrozenOrder(["a", "b", "c"], live)).toBe(live)
  })

  it("restores the frozen relative order of rows that moved", () => {
    // "c" got a message and jumped to the top; the reader keeps their list.
    expect(mergeFrozenOrder(["a", "b", "c"], ["c", "a", "b"])).toEqual(["a", "b", "c"])
  })

  it("drops rows that are gone rather than holding a row that opens nothing", () => {
    expect(mergeFrozenOrder(["a", "b", "c"], ["c", "a"])).toEqual(["a", "c"])
  })

  it("lets a new row through, where the live order puts it relative to the frozen ones", () => {
    // Freezing insertions would fight the new-conversation reveal.
    expect(mergeFrozenOrder(["a", "b"], ["a", "new", "b"])).toEqual(["a", "new", "b"])
  })

  it("puts a new row that precedes everything at the very top", () => {
    expect(mergeFrozenOrder(["a", "b"], ["new", "b", "a"])).toEqual(["new", "a", "b"])
  })

  it("keeps several new rows in their live order", () => {
    expect(mergeFrozenOrder(["a"], ["n1", "n2", "a", "n3"])).toEqual(["n1", "n2", "a", "n3"])
  })

  it("handles a live order with nothing in common with the frozen one", () => {
    expect(mergeFrozenOrder(["a", "b"], ["x", "y"])).toEqual(["x", "y"])
  })

  it("emits every live id exactly once, whatever the churn", () => {
    const frozen = ["a", "b", "c", "d"]
    const live = ["d", "n1", "b", "n2", "a"]
    const out = mergeFrozenOrder(frozen, live)
    expect([...out].sort()).toEqual([...live].sort())
    expect(new Set(out).size).toBe(out.length)
  })

  it("is idempotent — re-merging its own output changes nothing", () => {
    const once = mergeFrozenOrder(["a", "b", "c"], ["c", "a", "b"])
    expect(mergeFrozenOrder(["a", "b", "c"], once)).toEqual(once)
  })
})

describe("projectFrozenSections", () => {
  it("hands back the live sections when nothing is frozen", () => {
    const live = [dateSection("today", ["a"])]
    expect(projectFrozenSections({ sections: [] }, live)).toEqual(live)
  })

  it("keeps a row in the bucket it was shown in when activity moves it", () => {
    // The loudest symptom under date grouping: the row you were reaching for is
    // not merely lower down, it has left the section entirely.
    const frozen = freezeConversationLayout([
      dateSection("today", ["a"]),
      dateSection("yesterday", ["b"]),
    ])
    const live = [dateSection("today", ["b", "a"])]
    const out = projectFrozenSections(frozen, live)
    expect(out.map((s) => [s.kind, s.sessions.map((r) => r.id)])).toEqual([
      ["date", ["a"]],
      ["date", ["b"]],
    ])
  })

  it("restores the frozen order inside a section", () => {
    const frozen = freezeConversationLayout([dateSection("today", ["a", "b", "c"])])
    const live = [dateSection("today", ["c", "a", "b"])]
    expect(projectFrozenSections(frozen, live)[0]!.sessions.map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
    ])
  })

  it("lets a new conversation through at its live position", () => {
    // Freezing insertions would fight the new-conversation reveal, which has to
    // be able to show a chat the user just created.
    const frozen = freezeConversationLayout([dateSection("today", ["a", "b"])])
    const live = [dateSection("today", ["new", "a", "b"])]
    expect(projectFrozenSections(frozen, live)[0]!.sessions.map((r) => r.id)).toEqual([
      "new",
      "a",
      "b",
    ])
  })

  it("drops a deleted row at once rather than leaving one that opens nothing", () => {
    const frozen = freezeConversationLayout([dateSection("today", ["a", "b"])])
    const live = [dateSection("today", ["a"])]
    expect(projectFrozenSections(frozen, live)[0]!.sessions.map((r) => r.id)).toEqual(["a"])
  })

  it("drops a frozen section that has emptied out", () => {
    const frozen = freezeConversationLayout([
      dateSection("today", ["a"]),
      dateSection("yesterday", ["b"]),
    ])
    const live = [dateSection("today", ["a"])]
    expect(projectFrozenSections(frozen, live)).toHaveLength(1)
  })

  it("keeps an emptied folder section — the model always emits those", () => {
    const frozen = freezeConversationLayout([folderSection("f1", ["a"])])
    const live = [folderSection("f1", [])]
    const out = projectFrozenSections(frozen, live)
    expect(out).toHaveLength(1)
    expect(out[0]!.sessions).toEqual([])
  })

  it("appends a section that only the live model has", () => {
    const frozen = freezeConversationLayout([dateSection("today", ["a"])])
    const live = [dateSection("today", ["a"]), dateSection("yesterday", ["b"])]
    expect(projectFrozenSections(frozen, live).map((s) => s.sessions.map((r) => r.id))).toEqual([
      ["a"],
      ["b"],
    ])
  })

  it("uses fresh row data, so a rename or a new unread badge still lands", () => {
    // Positions are frozen; the rows themselves are not.
    const frozen = freezeConversationLayout([dateSection("today", ["a"])])
    const live: ConversationSection[] = [
      { kind: "date", bucket: "today", sessions: [row("a", { title: "renamed" })] },
    ]
    expect(projectFrozenSections(frozen, live)[0]!.sessions[0]!.title).toBe("renamed")
  })

  it("carries the live section's own metadata, so a collapse toggle still works", () => {
    const frozen = freezeConversationLayout([folderSection("f1", ["a"])])
    const live = [{ ...folderSection("f1", ["a"]), collapsed: true } as ConversationSection]
    const out = projectFrozenSections(frozen, live)[0]!
    expect(out.kind === "folder" && out.collapsed).toBe(true)
  })

  it("never duplicates or loses a live row", () => {
    const frozen = freezeConversationLayout([
      dateSection("today", ["a", "b"]),
      dateSection("yesterday", ["c"]),
    ])
    const live = [dateSection("today", ["c", "new", "a"]), dateSection("yesterday", ["b"])]
    const ids = projectFrozenSections(frozen, live).flatMap((s) => s.sessions.map((r) => r.id))
    expect([...ids].sort()).toEqual(["a", "b", "c", "new"])
    expect(new Set(ids).size).toBe(ids.length)
  })
})
