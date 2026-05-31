import {
  resolveMobileTabLayout,
  DEFAULT_MOBILE_TAB_LAYOUT,
  type MobileTabLayout,
} from "./mobile-tabs"

describe("resolveMobileTabLayout", () => {
  it("resolves the default layout to all tabs in canonical order", () => {
    const r = resolveMobileTabLayout(DEFAULT_MOBILE_TAB_LAYOUT)
    expect(r.order).toEqual(["chat", "workflows", "discover", "me"])
    expect(r.visible).toEqual(["chat", "workflows", "discover", "me"])
    expect(r.hidden).toEqual([])
    expect(r.defaultLanding).toBe("chat")
  })

  it("applies a custom order and appends any missing canonical ids", () => {
    const layout: MobileTabLayout = {
      order: ["workflows", "chat"],
      hidden: [],
      defaultLanding: "chat",
    }
    const r = resolveMobileTabLayout(layout)
    expect(r.order).toEqual(["workflows", "chat", "discover", "me"])
  })

  it("drops unknown / duplicate ids from the order", () => {
    const layout: MobileTabLayout = {
      order: ["me", "me", "nope" as never, "chat"],
      hidden: [],
      defaultLanding: "chat",
    }
    const r = resolveMobileTabLayout(layout)
    expect(r.order).toEqual(["me", "chat", "workflows", "discover"])
  })

  it("removes hidden tabs from visible", () => {
    const r = resolveMobileTabLayout({
      order: ["chat", "workflows", "discover", "me"],
      hidden: ["discover"],
      defaultLanding: "chat",
    })
    expect(r.visible).toEqual(["chat", "workflows", "me"])
    expect(r.hidden).toEqual(["discover"])
  })

  it("ignores the hidden set when it would drop below the floor", () => {
    const r = resolveMobileTabLayout({
      order: ["chat", "workflows", "discover", "me"],
      hidden: ["workflows", "discover", "me"],
      defaultLanding: "chat",
    })
    // Only 1 would remain → honour none.
    expect(r.visible).toEqual(["chat", "workflows", "discover", "me"])
    expect(r.hidden).toEqual([])
  })

  it("falls back the landing to the first visible tab when the chosen one is hidden", () => {
    const r = resolveMobileTabLayout({
      order: ["chat", "workflows", "discover", "me"],
      hidden: ["chat"],
      defaultLanding: "chat",
    })
    expect(r.visible[0]).toBe("workflows")
    expect(r.defaultLanding).toBe("workflows")
  })
})
