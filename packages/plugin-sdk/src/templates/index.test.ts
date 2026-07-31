import {
  TEMPLATE_API_VERSION,
  defineTemplate,
  defineTemplatePackage,
  defineSkillTemplate,
  defineWorkflowNodeGroup,
  defineWorkflowNodeGroups,
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

  it("defines one or many workflow node-group templates", () => {
    const definition = {
      apiVersion: TEMPLATE_API_VERSION,
      id: "demo:review-group",
      domain: "workflow" as const,
      status: "published" as const,
      revision: 1,
      version: "1.0.0",
      metadata: { name: "Review group" },
      payload: {
        kind: "cognia.workflow/node-group/v1" as const,
        nodes: [
          {
            id: "prompt",
            type: "ai.prompt",
            typeVersion: 1,
            position: { x: 0, y: 0 },
            data: { label: "Review", params: { prompt: "Review this change" } },
          },
        ],
        edges: [],
      },
      inputs: [],
      dependencies: [],
      capabilities: [],
      compatibility: { platforms: ["desktop" as const, "web" as const] },
      provenance: { source: "plugin" as const, pluginId: "demo" },
      contentHash: "a".repeat(64),
      createdAt: 1,
      updatedAt: 1,
    }

    expect(defineWorkflowNodeGroup(definition)).toBe(definition)
    expect(defineWorkflowNodeGroups([definition] as const)).toEqual([definition])
  })

  it("rejects malformed or duplicate workflow node-group definitions", () => {
    const base = {
      apiVersion: TEMPLATE_API_VERSION,
      id: "demo:invalid-group",
      domain: "workflow" as const,
      status: "published" as const,
      revision: 1,
      version: "1.0.0",
      metadata: { name: "Invalid group" },
      payload: {
        kind: "cognia.workflow/node-group/v1" as const,
        nodes: [],
        edges: [],
      },
      inputs: [],
      dependencies: [],
      capabilities: [],
      compatibility: { platforms: ["desktop" as const] },
      provenance: { source: "plugin" as const, pluginId: "demo" },
      contentHash: "a".repeat(64),
      createdAt: 1,
      updatedAt: 1,
    }

    expect(() => defineWorkflowNodeGroup(base)).toThrow(/at least one node/i)
    expect(() =>
      defineWorkflowNodeGroups([
        {
          ...base,
          payload: {
            ...base.payload,
            nodes: [
              {
                id: "one",
                type: "ai.prompt",
                typeVersion: 1,
                position: { x: 0, y: 0 },
                data: { label: "One" },
              },
            ],
          },
        },
        {
          ...base,
          payload: {
            ...base.payload,
            nodes: [
              {
                id: "two",
                type: "io.output",
                typeVersion: 1,
                position: { x: 0, y: 0 },
                data: { label: "Two" },
              },
            ],
          },
        },
      ] as never)
    ).toThrow(/duplicate/i)
  })
})
