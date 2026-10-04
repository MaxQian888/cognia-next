import type { ChatSession } from "@cognia/agent-config-types"

import {
  CONVERSATION_MANAGER_ROUTE,
  ariaSortForColumn,
  conversationManagerHref,
  countConversationsByTab,
  isConversationManagerTab,
  sortForColumn,
} from "./conversation-manager"

describe("tabs and deep links", () => {
  it("knows its two tabs and nothing else", () => {
    expect(isConversationManagerTab("active")).toBe(true)
    expect(isConversationManagerTab("archived")).toBe(true)
    expect(isConversationManagerTab("all")).toBe(false)
    expect(isConversationManagerTab(null)).toBe(false)
  })

  it("links the active tab at the page's own address and the archive by query", () => {
    expect(conversationManagerHref()).toBe(CONVERSATION_MANAGER_ROUTE)
    expect(conversationManagerHref("active")).toBe("/conversations")
    expect(conversationManagerHref("archived")).toBe("/conversations?tab=archived")
  })
})

describe("column sorting", () => {
  it("maps title and created onto the list model's sorts", () => {
    expect(sortForColumn("recent", "title")).toBe("title")
    expect(sortForColumn("title", "created")).toBe("created")
  })

  it("flips last activity between newest and oldest first", () => {
    expect(sortForColumn("recent", "activity")).toBe("oldest")
    expect(sortForColumn("oldest", "activity")).toBe("recent")
    expect(sortForColumn("title", "activity")).toBe("recent")
  })

  it("reports each header's direction for assistive technology", () => {
    expect(ariaSortForColumn("title", "title")).toBe("ascending")
    expect(ariaSortForColumn("recent", "title")).toBe("none")
    expect(ariaSortForColumn("created", "created")).toBe("descending")
    expect(ariaSortForColumn("recent", "activity")).toBe("descending")
    expect(ariaSortForColumn("oldest", "activity")).toBe("ascending")
    expect(ariaSortForColumn("unread", "activity")).toBe("none")
  })
})

describe("countConversationsByTab", () => {
  it("counts each side, leaving hidden subagent transcripts out", () => {
    const rows = [
      { kind: "direct" },
      { kind: "team", archivedAt: 3 },
      { kind: "direct", archivedAt: 4 },
      { kind: "subagent" },
      { kind: "subagent", archivedAt: 1 },
    ] as Pick<ChatSession, "archivedAt" | "kind">[]
    expect(countConversationsByTab(rows)).toEqual({ active: 1, archived: 2 })
  })
})
