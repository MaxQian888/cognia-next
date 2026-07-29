import { panelIdSet, resolvePanelId } from "./resolve-panel-id"

const KNOWN = panelIdSet([{ id: "overview" }, { id: "logs" }, { id: "keys" }])

describe("panelIdSet", () => {
  it("collects the ids of a flat nav item list", () => {
    expect([...KNOWN].sort()).toEqual(["keys", "logs", "overview"])
  })
})

describe("resolvePanelId", () => {
  it("passes a known id through", () => {
    expect(resolvePanelId("logs", KNOWN, "overview")).toBe("logs")
  })

  it("falls back for an id that is not in the nav", () => {
    // This is a URL the user can type; an unknown value must land somewhere
    // rather than indexing the panel switch with nothing.
    expect(resolvePanelId("nonsense", KNOWN, "overview")).toBe("overview")
  })

  it("falls back for an absent param", () => {
    expect(resolvePanelId(null, KNOWN, "overview")).toBe("overview")
    expect(resolvePanelId(undefined, KNOWN, "overview")).toBe("overview")
  })

  it("falls back for an empty string rather than treating it as a request", () => {
    expect(resolvePanelId("", KNOWN, "overview")).toBe("overview")
  })

  it("does not accept an inherited Object property as a panel id", () => {
    // `Set.has` rather than an object lookup, so `?panel=toString` cannot
    // resolve to a panel that does not exist.
    expect(resolvePanelId("toString", KNOWN, "overview")).toBe("overview")
    expect(resolvePanelId("constructor", KNOWN, "overview")).toBe("overview")
  })
})
