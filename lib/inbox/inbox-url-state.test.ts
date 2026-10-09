import {
  DEFAULT_INBOX_GROUPING,
  GROUPING_TO_LEGACY_VIEW,
  buildInboxUrl,
  isInboxGrouping,
  isInboxListFilter,
  normalizeInboxFilters,
  parseInboxUrlState,
  resolveInboxGrouping,
  serializeInboxUrlState,
} from "./inbox-url-state"

const params = (query: string) => new URLSearchParams(query)

describe("parseInboxUrlState", () => {
  it("reads nothing from an empty query", () => {
    expect(parseInboxUrlState(params(""))).toEqual({ group: null, preview: null, filters: [] })
  })

  it("reads an explicit grouping", () => {
    expect(parseInboxUrlState(params("group=platform")).group).toBe("platform")
  })

  it.each([
    ["by-adapter", "adapter"],
    ["by-platform", "platform"],
    ["unified", "status"],
  ])("maps the legacy view=%s to group=%s", (view, group) => {
    // The old sidebar toggle wrote these and nothing ever read them; existing
    // bookmarks must now mean what they always claimed.
    expect(parseInboxUrlState(params(`view=${view}`)).group).toBe(group)
  })

  it("lets an explicit group win over a legacy view", () => {
    expect(parseInboxUrlState(params("view=by-adapter&group=platform")).group).toBe("platform")
  })

  it("falls back to the legacy view when the group value is unknown", () => {
    expect(parseInboxUrlState(params("group=bogus&view=by-platform")).group).toBe("platform")
  })

  it("ignores unknown groupings and views", () => {
    expect(parseInboxUrlState(params("group=bogus&view=bogus")).group).toBeNull()
  })

  it("reads a trimmed preview id and treats blank as none", () => {
    expect(parseInboxUrlState(params("preview=%20s1%20")).preview).toBe("s1")
    expect(parseInboxUrlState(params("preview=")).preview).toBeNull()
    expect(parseInboxUrlState(params("preview=%20%20")).preview).toBeNull()
  })

  it("normalizes filters: known only, deduped, canonical order", () => {
    expect(parseInboxUrlState(params("f=snoozed,bogus,unread,unread")).filters).toEqual([
      "unread",
      "snoozed",
    ])
  })
})

describe("resolveInboxGrouping", () => {
  it("prefers the URL, then the stored choice, then the default", () => {
    expect(resolveInboxGrouping({ group: "adapter" }, "platform")).toBe("adapter")
    expect(resolveInboxGrouping({ group: null }, "platform")).toBe("platform")
    expect(resolveInboxGrouping({ group: null }, null)).toBe(DEFAULT_INBOX_GROUPING)
    expect(resolveInboxGrouping({ group: null })).toBe("status")
  })
})

describe("serializeInboxUrlState", () => {
  it("preserves params the inbox does not own", () => {
    // `/inbox/adapter` and `/inbox/platform` read their scope from the same
    // query; dropping it would silently widen the list.
    const out = serializeInboxUrlState(params("adapterId=a1&kind=lark"), { preview: "s1" })
    expect(params(out).get("adapterId")).toBe("a1")
    expect(params(out).get("kind")).toBe("lark")
    expect(params(out).get("preview")).toBe("s1")
  })

  it("writes a grouping and retires the legacy view", () => {
    const out = serializeInboxUrlState(params("view=by-adapter"), { group: "platform" })
    expect(params(out).get("view")).toBeNull()
    expect(params(out).get("group")).toBe("platform")
  })

  it("clears the grouping on null", () => {
    expect(serializeInboxUrlState(params("group=adapter"), { group: null })).toBe("")
  })

  it("clears a blank or null preview", () => {
    expect(serializeInboxUrlState(params("preview=s1"), { preview: null })).toBe("")
    expect(serializeInboxUrlState(params("preview=s1"), { preview: "  " })).toBe("")
  })

  it("writes normalized filters and drops the param when empty", () => {
    expect(
      params(serializeInboxUrlState(params(""), { filters: ["snoozed", "unread"] })).get("f")
    ).toBe("unread,snoozed")
    expect(serializeInboxUrlState(params("f=unread"), { filters: [] })).toBe("")
  })

  it("leaves keys missing from the patch untouched", () => {
    const out = serializeInboxUrlState(params("group=adapter&f=unread&preview=s1"), {})
    expect(parseInboxUrlState(params(out))).toEqual({
      group: "adapter",
      preview: "s1",
      filters: ["unread"],
    })
  })

  it("round-trips through parse", () => {
    const out = serializeInboxUrlState(params(""), {
      group: "adapter",
      preview: "s 1",
      filters: ["pinned"],
    })
    expect(parseInboxUrlState(params(out))).toEqual({
      group: "adapter",
      preview: "s 1",
      filters: ["pinned"],
    })
  })
})

describe("helpers", () => {
  it("guards groupings and filters", () => {
    expect(isInboxGrouping("status")).toBe(true)
    expect(isInboxGrouping("by-adapter")).toBe(false)
    expect(isInboxGrouping(undefined)).toBe(false)
    expect(isInboxListFilter("pending")).toBe(true)
    expect(isInboxListFilter("resolved")).toBe(false)
  })

  it("normalizes filter iterables", () => {
    expect(normalizeInboxFilters([" pinned ", "unread"])).toEqual(["unread", "pinned"])
  })

  it("maps every grouping back to a legacy view value", () => {
    expect(GROUPING_TO_LEGACY_VIEW).toEqual({
      status: "unified",
      adapter: "by-adapter",
      platform: "by-platform",
    })
  })

  it("builds a URL without a dangling question mark", () => {
    expect(buildInboxUrl("/inbox/all", "")).toBe("/inbox/all")
    expect(buildInboxUrl("/inbox/all", "group=status")).toBe("/inbox/all?group=status")
  })
})
