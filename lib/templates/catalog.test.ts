import { createTemplateDefinition } from "./contracts"
import { TemplateCatalog } from "./catalog"

async function draft(id: string, source: "user" | "plugin" = "user") {
  return createTemplateDefinition({
    id,
    domain: "skill",
    status: "draft",
    revision: 1,
    metadata: { name: id },
    payload: { content: id },
    inputs: [],
    dependencies: [],
    capabilities: [],
    compatibility: { platforms: ["desktop", "web", "mobile"] },
    provenance: { source, pluginId: source === "plugin" ? "demo.plugin" : undefined },
  })
}

describe("TemplateCatalog", () => {
  it("keeps a stable snapshot until a source changes", async () => {
    const catalog = new TemplateCatalog()
    const before = catalog.getSnapshot()
    expect(catalog.getSnapshot()).toBe(before)

    catalog.replaceSource("user", [await draft("skill.one")])
    const after = catalog.getSnapshot()
    expect(after).not.toBe(before)
    expect(catalog.getSnapshot()).toBe(after)
    expect(after.definitions.map((definition) => definition.id)).toEqual(["skill.one"])
  })

  it("notifies subscribers for plugin registration and teardown", async () => {
    const catalog = new TemplateCatalog()
    const listener = jest.fn()
    const unsubscribe = catalog.subscribe(listener)
    const dispose = catalog.register("plugin:demo.plugin", await draft("skill.plugin", "plugin"))

    expect(listener).toHaveBeenCalledTimes(1)
    expect(catalog.query({ source: "plugin" })).toHaveLength(1)
    dispose()
    expect(listener).toHaveBeenCalledTimes(2)
    expect(catalog.query({ source: "plugin" })).toEqual([])

    unsubscribe()
  })

  it("registers and tears down a batch with one catalog notification", async () => {
    const catalog = new TemplateCatalog()
    const listener = jest.fn()
    catalog.subscribe(listener)

    const dispose = catalog.registerMany("plugin:demo.plugin", [
      await draft("skill.one", "plugin"),
      await draft("skill.two", "plugin"),
    ])

    expect(listener).toHaveBeenCalledTimes(1)
    expect(catalog.getSnapshot().definitions.map((definition) => definition.id)).toEqual([
      "skill.one",
      "skill.two",
    ])

    dispose()

    expect(listener).toHaveBeenCalledTimes(2)
    expect(catalog.getSnapshot().definitions).toEqual([])
  })

  it("filters the unified view by domain, status, trust, platform, and text", async () => {
    const catalog = new TemplateCatalog()
    const definition = await draft("skill.research")
    definition.metadata = {
      name: "Research Summary",
      description: "Summarize reliable sources",
      tags: ["research"],
    }
    definition.provenance.trust = "verified-publisher"
    catalog.replaceSource("user", [definition])

    expect(
      catalog.query({
        domain: "skill",
        status: "draft",
        trust: "verified-publisher",
        platform: "mobile",
        text: "reliable",
      })
    ).toHaveLength(1)
    expect(catalog.query({ text: "unrelated" })).toEqual([])
  })
})
