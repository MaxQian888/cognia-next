import * as sdk from "./workflow-template"

describe("plugin-sdk: api/workflow-template", () => {
  it("exports the portable author helper without host registry controls", () => {
    expect(typeof sdk.defineWorkflowTemplate).toBe("function")
    expect(sdk).not.toHaveProperty("registerWorkflowTemplate")
    expect(sdk).not.toHaveProperty("unregisterWorkflowTemplateById")
    expect(sdk).not.toHaveProperty("getWorkflowTemplate")
    expect(sdk).not.toHaveProperty("validateWorkflowTemplateRequires")
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
