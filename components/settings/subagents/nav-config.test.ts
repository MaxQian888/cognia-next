import {
  FALLBACK_SUBAGENT_PANEL,
  SUBAGENT_STATIC_GROUPS,
  panelForFocusId,
  parsePanelId,
  pluginPanelId,
  resolveSubagentPanel,
  templatePanelId,
  type SubagentPanelContext,
} from "./nav-config"

const ctx = (over: Partial<SubagentPanelContext> = {}): SubagentPanelContext => ({
  templateIds: ["explore", "my-fork"],
  pluginIds: ["acme:reviewer"],
  ...over,
})

describe("panel id helpers", () => {
  it("round-trips template ids", () => {
    expect(parsePanelId(templatePanelId("abc"))).toEqual({ kind: "template", id: "abc" })
  })

  it("round-trips plugin runtime ids that themselves contain a colon", () => {
    expect(parsePanelId(pluginPanelId("acme:reviewer"))).toEqual({
      kind: "plugin",
      id: "acme:reviewer",
    })
  })

  it("treats bare ids as static panels", () => {
    expect(parsePanelId("nesting")).toEqual({ kind: "static", id: "nesting" })
  })
})

describe("resolveSubagentPanel", () => {
  it("defaults to the first template", () => {
    expect(resolveSubagentPanel(null, ctx())).toBe("template:explore")
  })

  it("falls back to a static panel when no templates exist", () => {
    expect(resolveSubagentPanel(null, ctx({ templateIds: [] }))).toBe(FALLBACK_SUBAGENT_PANEL)
  })

  it("passes static panel ids through", () => {
    expect(resolveSubagentPanel("background", ctx())).toBe("background")
  })

  it("keeps the legacy ?subagentTab=runtime deep link working", () => {
    expect(resolveSubagentPanel("runtime", ctx())).toBe("runtime")
  })

  it("maps the legacy ?subagentTab=templates deep link to the first template", () => {
    expect(resolveSubagentPanel("templates", ctx())).toBe("template:explore")
  })

  it("resolves a live template id", () => {
    expect(resolveSubagentPanel("template:my-fork", ctx())).toBe("template:my-fork")
  })

  it("resolves a live plugin id", () => {
    expect(resolveSubagentPanel("plugin:acme:reviewer", ctx())).toBe("plugin:acme:reviewer")
  })

  it("degrades a deleted template link to the default instead of an empty pane", () => {
    expect(resolveSubagentPanel("template:gone", ctx())).toBe("template:explore")
  })

  it("degrades a disabled plugin link to the default", () => {
    expect(resolveSubagentPanel("plugin:acme:gone", ctx())).toBe("template:explore")
  })

  it("degrades unknown junk to the default", () => {
    expect(resolveSubagentPanel("../../etc", ctx())).toBe("template:explore")
  })
})

describe("panelForFocusId", () => {
  it.each([
    ["subagent-nesting", "nesting"],
    ["subagent-background-tasks", "background"],
  ])("maps the registered finder control %s to its owning panel", (focus, panel) => {
    expect(panelForFocusId(focus)).toBe(panel)
  })

  it("returns null for an unregistered control so the section keeps the URL panel", () => {
    expect(panelForFocusId("something-else")).toBeNull()
    expect(panelForFocusId(null)).toBeNull()
  })
})

describe("static groups", () => {
  it("exposes every static panel exactly once", () => {
    const ids = SUBAGENT_STATIC_GROUPS.flatMap((g) => g.items.map((i) => i.id))
    expect(ids).toEqual(["runtime", "nesting", "background"])
    expect(new Set(ids).size).toBe(ids.length)
  })
})
