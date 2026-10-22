import {
  GLANCE_PLUGIN_LIMITS,
  glancePluginCommandId,
  isGlancePluginLocalId,
  sanitizeGlancePluginData,
  sanitizeGlancePluginModuleDef,
} from "./plugin-data"

describe("isGlancePluginLocalId", () => {
  it.each(["build", "ci.status", "a_b-c", "A1"])("accepts %s", (id) => {
    expect(isGlancePluginLocalId(id)).toBe(true)
  })

  it.each(["", "-a", ".a", "a b", "a:b", "a/b", "x".repeat(65), 3, null])("rejects %p", (id) => {
    expect(isGlancePluginLocalId(id)).toBe(false)
  })
})

describe("sanitizeGlancePluginModuleDef", () => {
  it("fills the defaults: compact and standard, both platforms", () => {
    expect(sanitizeGlancePluginModuleDef({ id: "ci", title: "  CI   status " })).toEqual({
      id: "ci",
      title: "CI status",
      sizes: ["compact", "standard"],
      platforms: ["desktop", "mobile"],
    })
  })

  it("keeps known sizes in canonical order, known platforms, a key and an icon", () => {
    expect(
      sanitizeGlancePluginModuleDef({
        id: "ci",
        title: "CI",
        titleKey: "glance.ci",
        icon: "git-branch",
        sizes: ["expanded", "huge", "compact"],
        platforms: ["mobile", "watch"],
      })
    ).toEqual({
      id: "ci",
      title: "CI",
      titleKey: "glance.ci",
      icon: "git-branch",
      sizes: ["compact", "expanded"],
      platforms: ["mobile"],
    })
  })

  it("keeps PascalCase and legacy kebab-case lucide names, drops anything else", () => {
    const iconOf = (icon: unknown) =>
      sanitizeGlancePluginModuleDef({ id: "a", title: "A", icon })?.icon
    expect(iconOf("GitBranch")).toBe("GitBranch")
    expect(iconOf("git-branch")).toBe("git-branch")
    expect(iconOf("<svg>")).toBeUndefined()
    expect(iconOf("1abc")).toBeUndefined()
    expect(iconOf("A".repeat(49))).toBeUndefined()
  })

  it("caps a long title", () => {
    const def = sanitizeGlancePluginModuleDef({ id: "a", title: "x".repeat(200) })
    expect(def?.title).toHaveLength(GLANCE_PLUGIN_LIMITS.title)
    expect(def?.title.endsWith("…")).toBe(true)
  })

  it.each([
    [null],
    ["ci"],
    [{ title: "No id" }],
    [{ id: "bad id", title: "x" }],
    [{ id: "ok", title: "   " }],
    [{ id: "ok" }],
  ])("is null for %j", (raw) => {
    expect(sanitizeGlancePluginModuleDef(raw)).toBeNull()
  })
})

describe("sanitizeGlancePluginData", () => {
  it("is empty for anything that is not an object", () => {
    expect(sanitizeGlancePluginData(null)).toEqual({})
    expect(sanitizeGlancePluginData("hi")).toEqual({})
  })

  it("keeps a well-formed module whole", () => {
    const data = {
      summary: "2 failing",
      stats: [
        { label: "Passing", value: "41", tone: "ok" },
        { label: "Failing", value: "2", tone: "crit" },
      ],
      rows: [
        {
          id: "main",
          label: "main",
          value: "red",
          hint: "3 min ago",
          tone: "crit",
          action: "open",
        },
      ],
      actions: [{ id: "open", label: "Open CI", icon: "external-link", command: "open-ci" }],
      empty: "No builds",
    }
    expect(sanitizeGlancePluginData(data)).toEqual(data)
  })

  it("drops unknown fields, bad tones and malformed entries", () => {
    expect(
      sanitizeGlancePluginData({
        html: "<b>x</b>",
        stats: [{ label: "A", value: "1", tone: "rainbow" }, { label: "B" }, "x"],
        rows: [
          { id: "bad id", label: "x" },
          { id: "r", label: "" },
          { id: "ok", label: "OK", extra: 1 },
        ],
        actions: [
          { id: "a", label: "A" },
          { id: "b", label: "B", command: "bad command" },
        ],
      })
    ).toEqual({ stats: [{ label: "A", value: "1" }], rows: [{ id: "ok", label: "OK" }] })
  })

  it("bounds every list", () => {
    const many = (n: number, make: (i: number) => object) =>
      Array.from({ length: n }, (_, i) => make(i))
    const out = sanitizeGlancePluginData({
      stats: many(10, (i) => ({ label: `s${i}`, value: String(i) })),
      rows: many(20, (i) => ({ id: `r${i}`, label: `r${i}` })),
      actions: many(6, (i) => ({ id: `a${i}`, label: `a${i}`, command: `c${i}` })),
    })
    expect(out.stats).toHaveLength(GLANCE_PLUGIN_LIMITS.stats)
    expect(out.rows).toHaveLength(GLANCE_PLUGIN_LIMITS.rows)
    expect(out.actions).toHaveLength(GLANCE_PLUGIN_LIMITS.actions)
  })

  it("caps strings and collapses whitespace", () => {
    const out = sanitizeGlancePluginData({
      stats: [{ label: "a\n\nb", value: "9".repeat(100) }],
      summary: "s".repeat(500),
    })
    expect(out.stats?.[0].label).toBe("a b")
    expect(out.stats?.[0].value).toHaveLength(GLANCE_PLUGIN_LIMITS.value)
    expect(out.summary).toHaveLength(GLANCE_PLUGIN_LIMITS.summary)
  })

  it("drops a row's pointer to an action that does not exist, and duplicate ids", () => {
    expect(
      sanitizeGlancePluginData({
        rows: [
          { id: "r", label: "R", action: "ghost" },
          { id: "r", label: "again" },
        ],
        actions: [
          { id: "a", label: "A", command: "c" },
          { id: "a", label: "A2", command: "c2" },
        ],
      })
    ).toEqual({
      rows: [{ id: "r", label: "R" }],
      actions: [{ id: "a", label: "A", command: "c" }],
    })
  })
})

describe("glancePluginCommandId", () => {
  it("namespaces a command the way manifest commands are registered", () => {
    expect(glancePluginCommandId("com.example.ci", "open-ci")).toBe("com.example.ci.open-ci")
  })
})
