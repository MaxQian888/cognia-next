import { defineWorkflowTemplate } from "./define-workflow-template"

describe("defineWorkflowTemplate", () => {
  it("returns the definition unchanged (identity helper)", () => {
    const def = {
      id: "t",
      name: "T",
      description: "d",
      category: "automation" as const,
      nodes: [],
      edges: [],
    }
    expect(defineWorkflowTemplate(def)).toBe(def)
  })
})
