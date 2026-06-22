import { NODE_CATALOG, groupedCatalog, nodeCatalogEntry, searchCatalog } from "./catalog"
import { WORKFLOW_NODE_KINDS } from "@/types/workflow/visual"

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
})

describe("nodeCatalogEntry", () => {
  it("returns a known entry for a known kind", () => {
    const e = nodeCatalogEntry("trigger.cron")
    expect(e.label).toBe("On schedule")
    expect(e.iconName).toBe("Clock")
  })

  it("exposes the GitHub webhook trigger as a desktop-only palette entry", () => {
    const e = nodeCatalogEntry("trigger.github.webhook")
    expect(e.category).toBe("trigger")
    expect(e.label).toBe("On GitHub event")
    expect(e.iconName).toBe("GitBranch")
    expect(e.desktopOnly).toBe(true)
    expect(e.keywords).toEqual(expect.arrayContaining(["github", "webhook"]))
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
    expect(all.some((e) => e.kind === "trigger.github.webhook")).toBe(false)
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

  it("matches the GitHub webhook trigger by GitHub and PR terms", () => {
    expect(searchCatalog("github")[0]?.kind).toBe("trigger.github.webhook")
    expect(searchCatalog("pr").some((e) => e.kind === "trigger.github.webhook")).toBe(true)
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
    const getText = (kind: string) =>
      kind === "flow.loop" ? { label: "循环", description: "重复执行子图" } : undefined
    const byLabel = searchCatalog("循环", { getText })
    expect(byLabel[0]?.kind).toBe("flow.loop")
    const byDesc = searchCatalog("子图", { getText })
    expect(byDesc.some((e) => e.kind === "flow.loop")).toBe(true)
    // Without the translator the same query finds nothing.
    expect(searchCatalog("循环").some((e) => e.kind === "flow.loop")).toBe(false)
  })
})
