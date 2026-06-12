import * as sdk from "./workflow-template"

describe("plugin-sdk: api/workflow-template", () => {
  it("re-exports the helper + registry functions plugin authors call", () => {
    expect(typeof sdk.defineWorkflowTemplate).toBe("function")
    expect(typeof sdk.registerWorkflowTemplate).toBe("function")
    expect(typeof sdk.unregisterWorkflowTemplateById).toBe("function")
    expect(typeof sdk.unregisterWorkflowTemplatesByPlugin).toBe("function")
    expect(typeof sdk.getWorkflowTemplate).toBe("function")
    expect(typeof sdk.getWorkflowTemplateEntry).toBe("function")
    expect(typeof sdk.listWorkflowTemplateIds).toBe("function")
    expect(typeof sdk.listWorkflowTemplateEntries).toBe("function")
    expect(typeof sdk.validateWorkflowTemplateRequires).toBe("function")
  })

  it("defineWorkflowTemplate is a typesafe identity function", () => {
    const def = sdk.defineWorkflowTemplate({
      id: "t",
      name: "T",
      description: "d",
      category: "automation",
      nodes: [],
      edges: [],
    })
    expect(def.id).toBe("t")
  })
})
