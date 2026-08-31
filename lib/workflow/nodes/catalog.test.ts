import {
  NODE_CATALOG,
  addPluginCatalogEntry,
  effectiveRequires,
  groupedCatalog,
  missingCapabilities,
  nodeCatalogEntry,
  searchCatalog,
  __resetPluginCatalogForTesting,
} from "./catalog"
import { isCapabilityId } from "@/lib/platform/capabilities"
import { WORKFLOW_NODE_KINDS } from "@/types/workflow/visual"
import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"

function nodeMessage(
  messages: Record<string, unknown>,
  kind: string
): { label?: unknown; description?: unknown } | undefined {
  let cursor: unknown = (messages as { workflows?: { nodes?: unknown } }).workflows?.nodes
  for (const part of kind.split(".")) {
    if (!cursor || typeof cursor !== "object") return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor as { label?: unknown; description?: unknown } | undefined
}

describe("NODE_CATALOG", () => {
  it("has one fully-described entry per palette kind", () => {
    // The palette covers every kind that ships metadata; synthesizer-only
    // kinds (the agent-team `pattern.*` nodes, "not placed by users in the
    // editor") are intentionally excluded, so the catalog is a subset of the
    // full kind list.
    expect(NODE_CATALOG.length).toBeGreaterThan(0)
    expect(NODE_CATALOG.length).toBeLessThanOrEqual(WORKFLOW_NODE_KINDS.length)
    const seen = new Set<string>()
    for (const e of NODE_CATALOG) {
      expect(seen.has(e.kind)).toBe(false)
      seen.add(e.kind)
      expect(e.label.length).toBeGreaterThan(0)
      expect(e.description.length).toBeGreaterThan(0)
      expect(e.iconName.length).toBeGreaterThan(0)
    }
  })

  it("excludes synthesizer-only pattern kinds from the palette", () => {
    const kinds = new Set(NODE_CATALOG.map((e) => e.kind))
    expect(kinds.has("pattern.synthesize" as never)).toBe(false)
    expect(kinds.has("pattern.judge-panel" as never)).toBe(false)
  })

  it("each category has at least one entry", () => {
    const cats = new Set(NODE_CATALOG.map((e) => e.category))
    for (const required of ["trigger", "action", "ai", "flow", "data", "io", "annotation"]) {
      expect(cats.has(required as ReturnType<typeof nodeCatalogEntry>["category"])).toBe(true)
    }
  })

  // Built-in catalog entries (NODE_CATALOG never contains plugin-contributed
  // kinds — those are added at runtime via `addPluginCatalogEntry` and keep
  // their plugin author's English fallback). Every built-in kind MUST carry a
  // localized `label` + `description` in BOTH message bundles, otherwise the
  // palette / sidebar / inspector silently render the hard-coded English
  // fallback. This invariant is what stops node-catalog growth from drifting
  // out of i18n coverage.
  describe.each([
    ["en", enMessages as unknown as Record<string, unknown>],
    ["zh-CN", zhMessages as unknown as Record<string, unknown>],
  ])("workflows.nodes i18n coverage (%s)", (_locale, messages) => {
    it.each(NODE_CATALOG.map((e) => e.kind))("has a label + description for %s", (kind) => {
      const entry = nodeMessage(messages, kind)
      expect(typeof entry?.label).toBe("string")
      expect((entry?.label as string)?.length ?? 0).toBeGreaterThan(0)
      expect(typeof entry?.description).toBe("string")
      expect((entry?.description as string)?.length ?? 0).toBeGreaterThan(0)
    })
  })
})

describe("nodeCatalogEntry", () => {
  it("returns a known entry for a known kind", () => {
    const e = nodeCatalogEntry("trigger.cron")
    expect(e.label).toBe("On schedule")
    expect(e.iconName).toBe("Clock")
  })

  it("exposes the platform-neutral Marketplace integration trigger", () => {
    const entry = nodeCatalogEntry("trigger.integration.event")
    expect(entry.category).toBe("trigger")
    expect(entry.label).toBe("On integration event")
    expect(entry.iconName).toBe("PlugZap")
    expect(entry.keywords).toEqual(expect.arrayContaining(["integration", "marketplace"]))
  })

  it("exposes the native desktop UIA-event trigger", () => {
    const e = nodeCatalogEntry("trigger.desktop.event")
    expect(e.category).toBe("trigger")
    expect(e.desktopOnly).toBe(true)
    expect(e.description).toMatch(/native Windows UI Automation/i)
  })

  it("exposes goal lifecycle actions as user-placeable action entries", () => {
    const e = nodeCatalogEntry("action.goal.create" as never)
    expect(e.category).toBe("action")
    expect(e.label).toBe("Create goal")
    expect(e.iconName).toBe("Target")
    expect(e.keywords).toEqual(expect.arrayContaining(["goal", "objective", "create"]))
  })

  it("synthesizes a stub entry for an unknown kind (plugin namespace)", () => {
    const e = nodeCatalogEntry("custom.thing.foo" as Parameters<typeof nodeCatalogEntry>[0])
    expect(e.label).toBe("custom.thing.foo")
    expect(e.iconName).toBe("Box")
  })

  it("resolves a registered plugin entry (with pluginId) before synthesizing", () => {
    __resetPluginCatalogForTesting()
    addPluginCatalogEntry({
      kind: "demo.action.format" as never,
      category: "plugin",
      label: "Format",
      description: "Format text",
      iconName: "Wand",
      keywords: [],
      pluginId: "demo",
    })
    const e = nodeCatalogEntry("demo.action.format" as Parameters<typeof nodeCatalogEntry>[0])
    expect(e.label).toBe("Format")
    expect(e.description).toBe("Format text")
    expect(e.pluginId).toBe("demo")
    expect(e.iconName).toBe("Wand")
    __resetPluginCatalogForTesting()
  })

  it("keeps plugin default params on the registered catalog entry", () => {
    __resetPluginCatalogForTesting()
    addPluginCatalogEntry({
      kind: "demo.action.format" as never,
      category: "plugin",
      label: "Format",
      description: "Format text",
      iconName: "Wand",
      keywords: [],
      pluginId: "demo",
      defaultParams: { mode: "markdown", retries: 2 },
    })
    const e = nodeCatalogEntry("demo.action.format" as Parameters<typeof nodeCatalogEntry>[0])
    expect(e.defaultParams).toEqual({ mode: "markdown", retries: 2 })
    __resetPluginCatalogForTesting()
  })
})

describe("capability requirements (ADR 0060)", () => {
  it("every desktopOnly entry carries an explicit, well-formed requires backfill", () => {
    for (const e of NODE_CATALOG.filter((e) => e.desktopOnly)) {
      expect(e.requires?.length ?? 0).toBeGreaterThan(0)
      for (const cap of e.requires ?? []) expect(isCapabilityId(cap)).toBe(true)
    }
  })

  it("every requires tag anywhere in the catalog is a well-formed capability id", () => {
    for (const e of NODE_CATALOG) {
      for (const cap of e.requires ?? []) expect(isCapabilityId(cap)).toBe(true)
    }
  })

  it("desktop UIA nodes require uia-automation (without becoming desktopOnly)", () => {
    const uiaKinds = NODE_CATALOG.filter((e) => e.kind.startsWith("action.desktop."))
    expect(uiaKinds.length).toBeGreaterThan(0)
    for (const e of uiaKinds) {
      expect(e.requires).toEqual(["uia-automation"])
      expect(e.desktopOnly).toBeUndefined()
    }
    expect(nodeCatalogEntry("trigger.desktop.event").requires).toEqual(["uia-automation"])
  })

  it("webhook nodes require always-on; git nodes require shell; terminal nodes require pty", () => {
    expect(nodeCatalogEntry("trigger.webhook").requires).toEqual(["always-on"])
    expect(nodeCatalogEntry("io.webhook.respond").requires).toEqual(["always-on"])
    expect(nodeCatalogEntry("action.git.commit").requires).toEqual(["shell"])
    expect(nodeCatalogEntry("action.terminal.session.run").requires).toEqual(["pty"])
    expect(nodeCatalogEntry("action.terminal.script").requires).toEqual(["shell"])
  })

  it("effectiveRequires: explicit wins, legacy desktopOnly maps to shell, else empty", () => {
    expect(effectiveRequires({ requires: ["camera"] })).toEqual(["camera"])
    expect(effectiveRequires({ requires: ["camera"], desktopOnly: true })).toEqual(["camera"])
    expect(effectiveRequires({ desktopOnly: true })).toEqual(["shell"])
    expect(effectiveRequires({})).toEqual([])
  })

  it("missingCapabilities subtracts the local set", () => {
    expect(missingCapabilities({ requires: ["shell", "pty"] }, ["shell"])).toEqual(["pty"])
    expect(missingCapabilities({ requires: ["shell"] }, ["shell", "pty"])).toEqual([])
    expect(missingCapabilities({}, [])).toEqual([])
    expect(missingCapabilities({ desktopOnly: true }, ["webview"])).toEqual(["shell"])
  })

  it("plugin catalog entries round-trip requires (and preflight math applies)", () => {
    __resetPluginCatalogForTesting()
    addPluginCatalogEntry({
      kind: "demo.action.snap" as never,
      category: "plugin",
      label: "Snap",
      description: "Take a photo",
      iconName: "Camera",
      keywords: [],
      pluginId: "demo",
      requires: ["camera", "plugin:demo"],
    })
    const e = nodeCatalogEntry("demo.action.snap" as never)
    expect(e.requires).toEqual(["camera", "plugin:demo"])
    expect(missingCapabilities(e, ["webview", "camera"])).toEqual(["plugin:demo"])
    __resetPluginCatalogForTesting()
  })
})

describe("groupedCatalog", () => {
  it("returns the categories in the canonical order", () => {
    const groups = groupedCatalog()
    expect(groups.map((g) => g.category)).toEqual([
      "trigger",
      "action",
      "ai",
      "flow",
      "data",
      "io",
      "annotation",
    ])
  })

  it("hides desktop-only entries when requested", () => {
    const groups = groupedCatalog({ includeDesktopOnly: false })
    const all = groups.flatMap((g) => g.entries)
    expect(all.some((e) => e.kind === "trigger.webhook")).toBe(false)
    expect(all.some((e) => e.kind === "trigger.manual")).toBe(true)
  })
})

describe("searchCatalog", () => {
  it("returns all palette entries when query is empty", () => {
    expect(searchCatalog("")).toHaveLength(NODE_CATALOG.length)
  })

  it("ranks exact label match above contains-only", () => {
    const out = searchCatalog("cron")
    expect(out[0].kind).toBe("trigger.cron")
  })

  it("matches keywords (e.g., 'telegram' finds the connector kinds)", () => {
    const out = searchCatalog("telegram")
    expect(out.some((e) => e.kind === "trigger.connector.inbound")).toBe(true)
    expect(out.some((e) => e.kind === "action.connector.send")).toBe(true)
  })

  it("does not expose platform-specific nodes from Core", () => {
    expect(searchCatalog("github")).toEqual([])
    expect(NODE_CATALOG.some((entry) => entry.kind.startsWith("action.github."))).toBe(false)
  })

  it("matches goal lifecycle actions by goal terms", () => {
    const out = searchCatalog("goal")
    expect(out.some((e) => e.kind === "action.goal.create")).toBe(true)
    expect(out.some((e) => e.kind === "action.goal.analytics")).toBe(true)
    expect(searchCatalog("subgoal").some((e) => e.kind === "action.goal.decomposeSubgoals")).toBe(
      true
    )
  })

  it("matches goal template actions by template terms", () => {
    const out = searchCatalog("template")
    expect(out.some((e) => e.kind === "action.goal.template.list")).toBe(true)
    expect(out.some((e) => e.kind === "action.goal.template.createGoal")).toBe(true)
    expect(searchCatalog("favorite").some((e) => e.kind === "action.goal.template.favorite")).toBe(
      true
    )
  })

  it("matches plan lifecycle actions by plan terms", () => {
    const out = searchCatalog("plan")
    expect(out.some((e) => e.kind === "action.plan.create")).toBe(true)
    expect(out.some((e) => e.kind === "action.plan.approve")).toBe(true)
    expect(out.some((e) => e.kind === "action.plan.setStepStatus")).toBe(true)
    expect(searchCatalog("draft").some((e) => e.kind === "action.plan.updateDraft")).toBe(true)
    expect(searchCatalog("events").some((e) => e.kind === "action.plan.events")).toBe(true)
    expect(searchCatalog("repair").some((e) => e.kind === "action.plan.refine")).toBe(true)
  })

  it("matches scheduler task actions by scheduler terms", () => {
    const out = searchCatalog("scheduler")
    expect(out.some((e) => e.kind === "action.scheduler.task.create")).toBe(true)
    expect(out.some((e) => e.kind === "action.scheduler.task.runNow")).toBe(true)
    expect(out.some((e) => e.kind === "action.scheduler.task.executions")).toBe(true)
    expect(out.some((e) => e.kind === "action.scheduler.statistics")).toBe(true)
    expect(out.some((e) => e.kind === "action.scheduler.event.trigger")).toBe(true)
    expect(searchCatalog("pause task").some((e) => e.kind === "action.scheduler.task.pause")).toBe(
      true
    )
    expect(searchCatalog("backfill").some((e) => e.kind === "action.scheduler.task.backfill")).toBe(
      true
    )
    expect(
      searchCatalog("import tasks").some((e) => e.kind === "action.scheduler.task.import")
    ).toBe(true)
    expect(
      searchCatalog("recent executions").some(
        (e) => e.kind === "action.scheduler.executions.recent"
      )
    ).toBe(true)
  })

  it("matches kind substring as a last-resort bucket", () => {
    const out = searchCatalog("ai.")
    expect(out.length).toBeGreaterThan(0)
    expect(out.every((e) => e.kind.startsWith("ai."))).toBe(true)
  })

  it("matches localized labels/descriptions when a translator is supplied", () => {
    const getText = (entry: { kind: string }) =>
      entry.kind === "flow.loop" ? { label: "循环", description: "重复执行子图" } : undefined
    const byLabel = searchCatalog("循环", { getText })
    expect(byLabel[0]?.kind).toBe("flow.loop")
    const byDesc = searchCatalog("子图", { getText })
    expect(byDesc.some((e) => e.kind === "flow.loop")).toBe(true)
    // Without the translator the same query finds nothing.
    expect(searchCatalog("循环").some((e) => e.kind === "flow.loop")).toBe(false)
  })

  it("hands getText the full entry so plugin kinds can be localized", () => {
    __resetPluginCatalogForTesting()
    addPluginCatalogEntry({
      kind: "demo.action.format" as never,
      category: "plugin",
      label: "Format",
      description: "Format text",
      iconName: "Box",
      keywords: [],
      pluginId: "demo",
    })
    const seen: Array<string | undefined> = []
    const getText = (entry: { kind: string; pluginId?: string }) => {
      seen.push(entry.pluginId)
      return entry.pluginId === "demo" ? { label: "格式化", description: "格式化文本" } : undefined
    }
    const out = searchCatalog("格式化", { getText })
    expect(out.some((e) => (e.kind as string) === "demo.action.format")).toBe(true)
    expect(seen).toContain("demo")
    __resetPluginCatalogForTesting()
  })

  /**
   * `hidden` was declared on `NodeCatalogEntry` from the start and set by zero
   * built-ins, while two kinds whose own descriptions said "not hand-authored"
   * sat in the palette and failed non-retryably the moment they were dropped.
   */
  it("keeps the synthesizer-only team nodes out of the palette", () => {
    for (const kind of ["action.team.task.dispatch", "action.team.reconcile"] as const) {
      expect(nodeCatalogEntry(kind).hidden).toBe(true)
    }
    const palette = new Set(groupedCatalog().flatMap((g) => g.entries.map((e) => e.kind)))
    expect(palette.has("action.team.task.dispatch" as never)).toBe(false)
    expect(palette.has("action.team.reconcile" as never)).toBe(false)
    // Still catalogued, so a synthesized graph renders a real label and icon.
    expect(nodeCatalogEntry("action.team.task.dispatch").label).toBe("Dispatch team task")
  })

  it("sections the oversized actions group and leaves the others flat", () => {
    const groups = groupedCatalog()
    const actions = groups.find((g) => g.category === "action")
    expect(actions?.sections?.length).toBeGreaterThan(5)
    expect(actions?.sections?.[0]?.section).toBe("agents")
    expect(groups.find((g) => g.category === "trigger")?.sections).toBeUndefined()
  })
})
