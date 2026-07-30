import { TemplateCatalog } from "./catalog"
import { refreshCatalogOnlyTemplateAdapters } from "./catalog-only-adapters"

describe("catalog-only template adapters", () => {
  it("projects legacy domains into read-only published catalog entries", async () => {
    const catalog = new TemplateCatalog()
    const empty = async () => []

    const count = await refreshCatalogOnlyTemplateAdapters(catalog, {
      a2ui: async () => [
        {
          id: "dashboard",
          name: "Dashboard",
          payload: { components: [] },
          trust: "built-in",
        },
      ],
      goal: empty,
      scheduler: empty,
      prompt: empty,
      subscription: empty,
      document: empty,
    })

    expect(count).toBe(1)
    expect(catalog.get("catalog.a2ui.dashboard", "1.0.0")).toMatchObject({
      domain: "a2ui",
      status: "published",
      provenance: { source: "built-in", trust: "built-in" },
    })
  })
})
