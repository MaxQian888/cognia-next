import {
  TEMPLATE_API_VERSION,
  defineTemplate,
  defineTemplatePackage,
  defineSkillTemplate,
  validateTemplateDefinition,
} from "./index"

describe("@cognia/plugin-sdk/templates", () => {
  it("publishes versioned author helpers without host registry functions", () => {
    const definition = defineTemplate({
      apiVersion: TEMPLATE_API_VERSION,
      id: "skill.summary",
      domain: "skill",
      status: "published",
      revision: 1,
      version: "1.0.0",
      metadata: { name: "Summary" },
      payload: { content: "Summarize" },
      inputs: [],
      dependencies: [],
      capabilities: [],
      compatibility: { platforms: ["desktop", "web", "mobile"] },
      provenance: { source: "plugin", pluginId: "demo" },
      contentHash: "a".repeat(64),
      createdAt: 1,
      updatedAt: 1,
    })
    const packageManifest = defineTemplatePackage({
      schemaVersion: 1,
      apiVersion: TEMPLATE_API_VERSION,
      id: "com.example.summary",
      version: "1.0.0",
      name: "Summary",
      entrypoints: ["skill.summary@1.0.0"],
      definitions: [
        {
          id: "skill.summary",
          version: "1.0.0",
          path: "definitions/skill.summary@1.0.0.json",
          sha256: "b".repeat(64),
        },
      ],
      assets: [],
    })

    expect(definition.id).toBe("skill.summary")
    expect(packageManifest.id).toBe("com.example.summary")
    expect(validateTemplateDefinition(definition).ok).toBe(true)
    expect(defineSkillTemplate(definition)).toBe(definition)
  })

  it("rejects incomplete package graphs", () => {
    expect(() =>
      defineTemplatePackage({
        schemaVersion: 1,
        apiVersion: TEMPLATE_API_VERSION,
        id: "com.example.invalid",
        version: "1.0.0",
        name: "Invalid",
        entrypoints: ["missing@1.0.0"],
        definitions: [],
        assets: [],
      })
    ).toThrow(/no definitions/i)
  })
})
