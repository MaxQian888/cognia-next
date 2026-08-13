import {
  CONVERSATION_SIDEBAR_METADATA_OPTIONS,
  CONVERSATION_GROUP_BY_OPTIONS,
  DEFAULT_CONVERSATION_SIDEBAR_METADATA,
  DEFAULT_CONVERSATION_GROUP_BY,
  resolveConversationGroupBy,
  resolveConversationSidebarMetadata,
  toggleConversationSidebarMetadata,
} from "./conversation-grouping"

describe("resolveConversationGroupBy", () => {
  it("defaults to the workspace axis when nothing is stored", () => {
    expect(resolveConversationGroupBy(undefined)).toBe("workspace")
    expect(resolveConversationGroupBy(null)).toBe("workspace")
    expect(resolveConversationGroupBy({})).toBe("workspace")
    expect(DEFAULT_CONVERSATION_GROUP_BY).toBe("workspace")
  })

  it("returns an explicitly chosen axis", () => {
    for (const option of CONVERSATION_GROUP_BY_OPTIONS) {
      expect(resolveConversationGroupBy({ groupBy: option })).toBe(option)
    }
  })

  it("reads the retired groupByDate=false as 'no grouping'", () => {
    // The only reading of the old boolean that carries a user decision.
    expect(resolveConversationGroupBy({ groupByDate: false })).toBe("none")
  })

  it("does not pin groupByDate=true users to date buckets", () => {
    // `true` was the default nobody chose — treating it as a decision would
    // deny every existing install the new default forever.
    expect(resolveConversationGroupBy({ groupByDate: true })).toBe("workspace")
  })

  it("lets the current field win over the retired one", () => {
    expect(resolveConversationGroupBy({ groupBy: "agent", groupByDate: false })).toBe("agent")
  })

  it("ignores a corrupt persisted value", () => {
    expect(
      resolveConversationGroupBy({ groupBy: "bogus" } as unknown as { groupBy: undefined })
    ).toBe("workspace")
  })
})

describe("conversation sidebar metadata", () => {
  it("defaults to agent and model", () => {
    expect(resolveConversationSidebarMetadata(undefined)).toEqual(["agent", "model"])
    expect(DEFAULT_CONVERSATION_SIDEBAR_METADATA).toEqual(["agent", "model"])
  })

  it("preserves user order while dropping corrupt and duplicate entries", () => {
    expect(
      resolveConversationSidebarMetadata({
        metadata: ["provider", "agent", "provider", "bogus"],
      } as never)
    ).toEqual(["provider", "agent"])
    expect(CONVERSATION_SIDEBAR_METADATA_OPTIONS).toEqual([
      "agent",
      "model",
      "provider",
      "workspace",
    ])
  })

  it("adds and removes one field without reordering siblings", () => {
    expect(toggleConversationSidebarMetadata(["agent", "model"], "provider", true)).toEqual([
      "agent",
      "model",
      "provider",
    ])
    expect(toggleConversationSidebarMetadata(["agent", "model"], "agent", false)).toEqual(["model"])
  })
})
