import { loadBuiltInResourceOverlay } from "./built-in-resource-overlay"

describe("loadBuiltInResourceOverlay", () => {
  it("loads only the requested Skill payload and normalizes public aliases", async () => {
    const resources = await loadBuiltInResourceOverlay("builtin:web-research")
    expect(resources).toEqual([
      expect.objectContaining({
        skillId: "skill_builtin_web_research",
        path: "references/source-evaluation.md",
      }),
    ])
  })

  it("keeps compliance files UI-visible but can exclude them for model scope", async () => {
    const visible = await loadBuiltInResourceOverlay("diagram-design")
    expect(visible?.some((resource) => /LICENSE/.test(resource.path))).toBe(true)
    const modelReadable = await loadBuiltInResourceOverlay("diagram-design", {
      includeCompliance: false,
    })
    expect(modelReadable?.some((resource) => /LICENSE/.test(resource.path))).toBe(false)
  })

  it("returns null for custom skills so Dexie remains authoritative", async () => {
    await expect(loadBuiltInResourceOverlay("custom-skill")).resolves.toBeNull()
  })
})
