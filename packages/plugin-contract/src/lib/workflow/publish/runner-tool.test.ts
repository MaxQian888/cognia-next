import {
  WORKFLOW_AI_PLUGIN_ID,
  WORKFLOW_RUNNER_TOOL_DEFINITION,
  WORKFLOW_RUNNER_TOOL_NAME,
} from "./runner-tool"

describe("workflow runner tool constants", () => {
  it("keeps the tool name in sync between constant and definition", () => {
    expect(WORKFLOW_RUNNER_TOOL_NAME).toBe("wf_run_workflow_typed")
    expect(WORKFLOW_RUNNER_TOOL_DEFINITION.name).toBe(WORKFLOW_RUNNER_TOOL_NAME)
  })

  it("declares an approval-gated tool with a name-required schema", () => {
    expect(WORKFLOW_RUNNER_TOOL_DEFINITION.requiresApproval).toBe(true)
    expect(WORKFLOW_RUNNER_TOOL_DEFINITION.category).toBe("workflow")
    const schema = WORKFLOW_RUNNER_TOOL_DEFINITION.parametersSchema as {
      required?: string[]
      properties?: Record<string, unknown>
    }
    expect(schema.required).toEqual(["name"])
    expect(Object.keys(schema.properties ?? {})).toEqual(expect.arrayContaining(["name", "input"]))
  })

  it("pins the owning plugin id", () => {
    expect(WORKFLOW_AI_PLUGIN_ID).toBe("cognia-workflow-ai")
  })
})
