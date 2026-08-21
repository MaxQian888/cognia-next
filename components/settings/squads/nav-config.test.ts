import {
  FALLBACK_SQUAD_PANEL,
  parseSquadPanelId,
  resolveSquadPanel,
  squadPanelForFocusId,
  squadPanelId,
} from "./nav-config"

describe("squad panel ids", () => {
  it("round-trips a Squad id through the panel id", () => {
    expect(parseSquadPanelId(squadPanelId("abc"))).toEqual({ kind: "squad", id: "abc" })
  })

  it("keeps ids containing a colon intact", () => {
    // Plugin-contributed ids are namespaced `<pluginId>:<id>`.
    expect(parseSquadPanelId(squadPanelId("plug:in"))).toEqual({ kind: "squad", id: "plug:in" })
  })

  it("reads a static panel as static", () => {
    expect(parseSquadPanelId("templates")).toEqual({ kind: "static", id: "templates" })
  })
})

describe("resolveSquadPanel", () => {
  const ctx = { squadIds: ["a", "b"] }

  it("honours an explicit static panel", () => {
    expect(resolveSquadPanel("templates", ctx)).toBe("templates")
  })

  it("honours a Squad that exists", () => {
    expect(resolveSquadPanel("squad:b", ctx)).toBe("squad:b")
  })

  it("lands on a neighbour when the linked Squad is gone", () => {
    // A blank right pane is the worst outcome of a stale link.
    expect(resolveSquadPanel("squad:deleted", ctx)).toBe("squad:a")
  })

  it("falls back to templates when there is no Squad to land on", () => {
    expect(resolveSquadPanel("squad:deleted", { squadIds: [] })).toBe(FALLBACK_SQUAD_PANEL)
  })

  it("opens on the first Squad when no parameter is given", () => {
    // Someone with Squads came here to see them, not the gallery.
    expect(resolveSquadPanel(null, ctx)).toBe("squad:a")
    expect(resolveSquadPanel("  ", ctx)).toBe("squad:a")
  })

  it("opens on templates for someone with no Squads yet", () => {
    expect(resolveSquadPanel(null, { squadIds: [] })).toBe("templates")
  })

  it("ignores an unrecognised value rather than rendering it", () => {
    expect(resolveSquadPanel("nonsense", ctx)).toBe("squad:a")
  })
})

describe("squadPanelForFocusId", () => {
  it("selects the owning panel so the anchor is mounted to scroll to", () => {
    expect(squadPanelForFocusId("squad-templates-create")).toBe("templates")
  })

  it("claims nothing it does not own", () => {
    expect(squadPanelForFocusId(null)).toBeNull()
    expect(squadPanelForFocusId("provider-default-model")).toBeNull()
  })
})
