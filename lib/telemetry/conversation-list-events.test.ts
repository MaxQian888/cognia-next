const trackEvent = jest.fn((..._args: unknown[]) => Promise.resolve(true))
jest.mock("./events/track-event", () => ({
  trackEvent: (...args: unknown[]) => trackEvent(...args),
}))

import {
  conversationSectionKindOf,
  trackConversationCreated,
  trackConversationFiltered,
  trackConversationLayoutChanged,
  trackConversationOpened,
  trackConversationReordered,
  trackConversationRowAction,
  trackConversationSearched,
  trackConversationSectionToggled,
  trackConversationViewChanged,
} from "./conversation-list-events"

beforeEach(() => trackEvent.mockClear())

describe("conversationSectionKindOf", () => {
  it("reports the kind and drops the embedded id", () => {
    expect(conversationSectionKindOf("pinned")).toBe("pinned")
    expect(conversationSectionKindOf("folder:f_123")).toBe("folder")
    expect(conversationSectionKindOf("date:today")).toBe("date")
    expect(conversationSectionKindOf("workspace:project-abc")).toBe("workspace")
    expect(conversationSectionKindOf("agent:char_x")).toBe("agent")
    expect(conversationSectionKindOf("recent")).toBe("recent")
  })

  it("refuses shapes it does not know rather than mislabel them", () => {
    expect(conversationSectionKindOf("thread:abc")).toBeNull()
    expect(conversationSectionKindOf("")).toBeNull()
  })
})

describe("emitters", () => {
  it("opened / created / view / filtered / row action pass ids and enums through", async () => {
    await trackConversationOpened("s_1", "keyboard")
    await trackConversationCreated("team")
    await trackConversationViewChanged("archived")
    await trackConversationFiltered("kind", 2)
    await trackConversationRowAction("pin")
    await trackConversationRowAction("delete", 3)
    expect(trackEvent.mock.calls).toEqual([
      ["chat.list.opened", { sessionId: "s_1", via: "keyboard" }],
      ["chat.list.created", { kind: "team" }],
      ["chat.list.view.changed", { view: "archived" }],
      ["chat.list.filtered", { facet: "kind", activeCount: 2 }],
      ["chat.list.row.action", { action: "pin", count: 1, bulk: false }],
      ["chat.list.row.action", { action: "delete", count: 3, bulk: true }],
    ])
  })

  it("search reports the query's length, never its text", async () => {
    await trackConversationSearched({
      scope: "titleAndContent",
      query: "  secret plan  ",
      resultCount: 4,
      truncated: true,
    })
    expect(trackEvent).toHaveBeenCalledWith("chat.list.searched", {
      scope: "titleAndContent",
      queryLength: 11,
      resultCount: 4,
      truncated: true,
    })
    expect(JSON.stringify(trackEvent.mock.calls)).not.toContain("secret")
  })

  it("reorder derives from → to from the before/after orders and the section kind from the key", async () => {
    await trackConversationReordered({
      sectionKey: "date:today",
      before: ["a", "b", "c", "d"],
      after: ["b", "c", "a", "d"],
      via: "pointer",
    })
    expect(trackEvent).toHaveBeenCalledWith("chat.list.reordered", {
      section: "date",
      from: 0,
      to: 2,
      size: 4,
      via: "pointer",
    })
    // Moving upward.
    trackEvent.mockClear()
    await trackConversationReordered({
      sectionKey: "folder:f1",
      before: ["a", "b", "c"],
      after: ["c", "a", "b"],
      via: "keyboard",
    })
    expect(trackEvent).toHaveBeenCalledWith(
      "chat.list.reordered",
      expect.objectContaining({ section: "folder", from: 0, to: 1, via: "keyboard" })
    )
  })

  it("reorder stays silent for a no-op, an unknown section, or a non-permutation", async () => {
    await expect(
      trackConversationReordered({
        sectionKey: "pinned",
        before: ["a", "b"],
        after: ["a", "b"],
        via: "pointer",
      })
    ).resolves.toBe(false)
    await expect(
      trackConversationReordered({
        sectionKey: "thread:x",
        before: ["a", "b"],
        after: ["b", "a"],
        via: "pointer",
      })
    ).resolves.toBe(false)
    await expect(
      trackConversationReordered({
        sectionKey: "pinned",
        before: ["a", "b"],
        after: ["b", "z"],
        via: "pointer",
      })
    ).resolves.toBe(false)
    expect(trackEvent).not.toHaveBeenCalled()
  })

  it("layout emits one event per changed setting, sizes arrays and skips undefined", async () => {
    await trackConversationLayoutChanged({
      density: "compact",
      showPreview: false,
      metadata: ["agent", "model"],
      filterPresets: [{ id: "p", name: "Secret preset", filters: {}, createdAt: 0 } as never],
      groupBy: undefined,
    })
    expect(trackEvent.mock.calls).toEqual([
      ["chat.list.layout.changed", { setting: "density", value: "compact" }],
      ["chat.list.layout.changed", { setting: "showPreview", value: "false" }],
      ["chat.list.layout.changed", { setting: "metadata", value: "2" }],
      ["chat.list.layout.changed", { setting: "filterPresets", value: "1" }],
    ])
    expect(JSON.stringify(trackEvent.mock.calls)).not.toContain("Secret preset")
  })

  it("section toggle reports the kind and refuses unknown keys", async () => {
    await trackConversationSectionToggled("workspace:project-1", true)
    expect(trackEvent).toHaveBeenCalledWith("chat.list.section.toggled", {
      section: "workspace",
      collapsed: true,
    })
    trackEvent.mockClear()
    await expect(trackConversationSectionToggled("nope:1", false)).resolves.toBe(false)
    expect(trackEvent).not.toHaveBeenCalled()
  })
})
