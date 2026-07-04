import { DEFAULT_PROJECT_KNOWLEDGE_SETTINGS, resolveProjectKnowledgeSettings } from "./index"

describe("resolveProjectKnowledgeSettings", () => {
  it("returns defaults for undefined / null", () => {
    expect(resolveProjectKnowledgeSettings(undefined)).toEqual(DEFAULT_PROJECT_KNOWLEDGE_SETTINGS)
    expect(resolveProjectKnowledgeSettings(null)).toEqual(DEFAULT_PROJECT_KNOWLEDGE_SETTINGS)
  })

  it("defaults enableProjectRag to true", () => {
    expect(resolveProjectKnowledgeSettings({}).enableProjectRag).toBe(true)
  })

  it("honours an explicit disable", () => {
    expect(resolveProjectKnowledgeSettings({ enableProjectRag: false }).enableProjectRag).toBe(
      false
    )
  })

  it("floors a positive topK and falls back for non-positive / missing", () => {
    expect(resolveProjectKnowledgeSettings({ ragTopK: 8.9 }).ragTopK).toBe(8)
    expect(resolveProjectKnowledgeSettings({ ragTopK: 0 }).ragTopK).toBe(
      DEFAULT_PROJECT_KNOWLEDGE_SETTINGS.ragTopK
    )
    expect(resolveProjectKnowledgeSettings({ ragTopK: -5 }).ragTopK).toBe(
      DEFAULT_PROJECT_KNOWLEDGE_SETTINGS.ragTopK
    )
    expect(resolveProjectKnowledgeSettings({}).ragTopK).toBe(
      DEFAULT_PROJECT_KNOWLEDGE_SETTINGS.ragTopK
    )
  })
})
