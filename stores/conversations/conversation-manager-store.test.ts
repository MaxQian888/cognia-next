import { resolveConversationFilters } from "@/lib/chat/conversation-filters"

import { useConversationManagerStore } from "./conversation-manager-store"

const initial = useConversationManagerStore.getState()
beforeEach(() => useConversationManagerStore.setState(initial, true))

describe("conversation manager store", () => {
  it("starts on the active tab, newest activity first, unfiltered", () => {
    expect(useConversationManagerStore.getState()).toMatchObject({
      tab: "active",
      sortBy: "recent",
      activeViewId: null,
      searchContent: false,
      archiveOrder: null,
      filters: resolveConversationFilters(undefined),
    })
  })

  it("keeps the archive order until a shared sort is picked", () => {
    const s = useConversationManagerStore.getState()
    s.setArchiveOrder("archivedAsc")
    expect(useConversationManagerStore.getState().archiveOrder).toBe("archivedAsc")
    s.setSortBy("created")
    expect(useConversationManagerStore.getState()).toMatchObject({
      sortBy: "created",
      archiveOrder: null,
    })
  })

  it("normalizes filters on write and clears them with the selected view", () => {
    const s = useConversationManagerStore.getState()
    s.setFilters({ pinned: true })
    s.setActiveViewId("v1")
    expect(useConversationManagerStore.getState().filters).toEqual(
      resolveConversationFilters({ pinned: true })
    )
    s.resetFilters()
    expect(useConversationManagerStore.getState()).toMatchObject({
      filters: resolveConversationFilters(undefined),
      activeViewId: null,
    })
  })

  it("keeps the sort, the content switch and the tab", () => {
    const s = useConversationManagerStore.getState()
    s.setSortBy("title")
    s.setSearchContent(true)
    s.setTab("archived")
    expect(useConversationManagerStore.getState()).toMatchObject({
      sortBy: "title",
      searchContent: true,
      tab: "archived",
    })
  })

  it("persists the preferences, not the tab", () => {
    const options = useConversationManagerStore.persist.getOptions()
    const saved = options.partialize!(useConversationManagerStore.getState()) as object
    expect(Object.keys(saved).sort()).toEqual([
      "activeViewId",
      "archiveOrder",
      "filters",
      "searchContent",
      "sortBy",
    ])
  })
})
