import {
  compareUnifiedItems,
  makeUnifiedId,
  parseUnifiedId,
  type UnifiedScheduledItem,
} from "./unified"

function makeItem(overrides: Partial<UnifiedScheduledItem> = {}): UnifiedScheduledItem {
  return {
    unifiedId: "app:1",
    kind: "app",
    sourceId: "1",
    name: "T",
    status: "active",
    triggerSummary: { type: "cron", cron: "* * * * *" },
    nextRunAt: 1000,
    origin: { deepLinkHref: "/scheduler" },
    capabilities: { runNow: true, pause: true, edit: true, delete: true },
    ...overrides,
  }
}

describe("makeUnifiedId / parseUnifiedId", () => {
  it("makes ids in the documented format", () => {
    expect(makeUnifiedId("app", "abc")).toBe("app:abc")
    expect(makeUnifiedId("workflow", "wf-1")).toBe("workflow:wf-1")
  })

  it("round-trips through parseUnifiedId", () => {
    expect(parseUnifiedId(makeUnifiedId("backup", "default"))).toEqual({
      kind: "backup",
      sourceId: "default",
    })
  })

  it("returns undefined for malformed ids", () => {
    expect(parseUnifiedId("")).toBeUndefined()
    expect(parseUnifiedId("nopecolon")).toBeUndefined()
    expect(parseUnifiedId(":nokind")).toBeUndefined()
    expect(parseUnifiedId("app:")).toBeUndefined()
    expect(parseUnifiedId("unknownkind:x")).toBeUndefined()
  })

  it("preserves source ids containing colons (only the first colon is the delimiter)", () => {
    expect(parseUnifiedId("plugin:vendor:plugin-id:123")).toEqual({
      kind: "plugin",
      sourceId: "vendor:plugin-id:123",
    })
  })
})

describe("compareUnifiedItems", () => {
  it("places active items before paused ones", () => {
    const items = [
      makeItem({ unifiedId: "a:1", status: "paused", nextRunAt: 100 }),
      makeItem({ unifiedId: "a:2", status: "active", nextRunAt: 500 }),
    ]
    items.sort(compareUnifiedItems)
    expect(items.map((i) => i.unifiedId)).toEqual(["a:2", "a:1"])
  })

  it("breaks active/paused ties by nextRunAt ascending", () => {
    const items = [
      makeItem({ unifiedId: "a:1", status: "active", nextRunAt: 500 }),
      makeItem({ unifiedId: "a:2", status: "active", nextRunAt: 100 }),
      makeItem({ unifiedId: "a:3", status: "active", nextRunAt: 300 }),
    ]
    items.sort(compareUnifiedItems)
    expect(items.map((i) => i.unifiedId)).toEqual(["a:2", "a:3", "a:1"])
  })

  it("sinks items with no nextRunAt below items with one", () => {
    const items = [
      makeItem({ unifiedId: "a:no-next", status: "active", nextRunAt: undefined }),
      makeItem({ unifiedId: "a:has-next", status: "active", nextRunAt: 1000 }),
    ]
    items.sort(compareUnifiedItems)
    expect(items.map((i) => i.unifiedId)).toEqual(["a:has-next", "a:no-next"])
  })

  it("falls back to unifiedId for fully tied items (deterministic ordering)", () => {
    const items = [
      makeItem({ unifiedId: "a:b", status: "active", nextRunAt: 100 }),
      makeItem({ unifiedId: "a:a", status: "active", nextRunAt: 100 }),
    ]
    items.sort(compareUnifiedItems)
    expect(items.map((i) => i.unifiedId)).toEqual(["a:a", "a:b"])
  })
})
