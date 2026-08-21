import type { ConversationSidebarSettings } from "@cognia/agent-config-types"

import {
  CONVERSATION_SEARCH_WORKSPACE_OPTIONS,
  DEFAULT_CONVERSATION_SEARCH_OPTIONS,
  countWidenedSearchAxes,
  describeConversationSearchScope,
  needsCrossWorkspaceSessions,
  resolveConversationSearchOptions,
} from "@/lib/chat/conversation-search-scope"

function settings(
  overrides: Partial<ConversationSidebarSettings> = {}
): ConversationSidebarSettings {
  return overrides
}

describe("resolveConversationSearchOptions", () => {
  it("defaults to the cheapest reach on every axis", () => {
    expect(resolveConversationSearchOptions(undefined)).toEqual(DEFAULT_CONVERSATION_SEARCH_OPTIONS)
    expect(resolveConversationSearchOptions(settings())).toEqual({
      workspace: "current",
      includeArchived: false,
      content: false,
    })
  })

  it("folds the legacy searchScope enum into the content axis", () => {
    expect(resolveConversationSearchOptions(settings({ searchScope: "titleAndContent" }))).toEqual({
      workspace: "current",
      includeArchived: false,
      content: true,
    })
    expect(resolveConversationSearchOptions(settings({ searchScope: "title" })).content).toBe(false)
  })

  it("lets the newer object override the legacy enum in both directions", () => {
    // A downgrade-then-upgrade round trip must not resurrect a setting the user
    // has since changed, so the object wins whenever it says anything at all.
    expect(
      resolveConversationSearchOptions(
        settings({ searchScope: "titleAndContent", search: { content: false } })
      ).content
    ).toBe(false)
    expect(
      resolveConversationSearchOptions(
        settings({ searchScope: "title", search: { content: true } })
      ).content
    ).toBe(true)
  })

  it("degrades an unknown workspace reach to the current workspace", () => {
    const raw = { search: { workspace: "galaxy" } } as unknown as ConversationSidebarSettings
    expect(resolveConversationSearchOptions(raw).workspace).toBe("current")
  })

  it("keeps every rendered workspace option resolvable", () => {
    for (const workspace of CONVERSATION_SEARCH_WORKSPACE_OPTIONS) {
      expect(resolveConversationSearchOptions(settings({ search: { workspace } })).workspace).toBe(
        workspace
      )
    }
  })
})

describe("countWidenedSearchAxes", () => {
  it("counts each widened axis once", () => {
    expect(countWidenedSearchAxes(undefined)).toBe(0)
    expect(countWidenedSearchAxes({ workspace: "current" })).toBe(0)
    expect(countWidenedSearchAxes({ workspace: "all" })).toBe(1)
    expect(countWidenedSearchAxes({ workspace: "all", includeArchived: true })).toBe(2)
    expect(countWidenedSearchAxes({ workspace: "all", includeArchived: true, content: true })).toBe(
      3
    )
  })
})

describe("describeConversationSearchScope", () => {
  it("reports the unwidened default under the old enum's name", () => {
    // Keeps the metric comparable across the change from the enum to the object.
    expect(describeConversationSearchScope(undefined)).toBe("title")
    expect(describeConversationSearchScope({ workspace: "current" })).toBe("title")
  })

  it("names each widened axis, in a stable order", () => {
    expect(describeConversationSearchScope({ content: true })).toBe("content")
    expect(describeConversationSearchScope({ includeArchived: true })).toBe("archived")
    expect(describeConversationSearchScope({ workspace: "all" })).toBe("allWorkspaces")
    expect(
      describeConversationSearchScope({ content: true, includeArchived: true, workspace: "all" })
    ).toBe("content+archived+allWorkspaces")
  })
})

describe("needsCrossWorkspaceSessions", () => {
  it("loads every workspace for the workspace grouping axis", () => {
    expect(needsCrossWorkspaceSessions("workspace", undefined)).toBe(true)
  })

  it("loads every workspace when search is told to reach them, whatever the grouping", () => {
    // The defect this replaces: whether you could FIND a conversation depended
    // on how you had chosen to GROUP the list.
    expect(needsCrossWorkspaceSessions("date", { workspace: "all" })).toBe(true)
    expect(needsCrossWorkspaceSessions("agent", { workspace: "all" })).toBe(true)
    expect(needsCrossWorkspaceSessions("none", { workspace: "all" })).toBe(true)
  })

  it("stays scoped when neither reason applies", () => {
    expect(needsCrossWorkspaceSessions("date", undefined)).toBe(false)
    expect(needsCrossWorkspaceSessions("team", { workspace: "current" })).toBe(false)
    expect(needsCrossWorkspaceSessions(undefined, { includeArchived: true, content: true })).toBe(
      false
    )
  })
})
