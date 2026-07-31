import { buildWorkflowAiTools } from "./index"
import {
  WORKFLOW_RUNNER_TOOL_NAME,
  WORKFLOW_RUNNER_TOOL_DEFINITION,
} from "@/lib/workflow/publish/runner-tool"

describe("buildWorkflowAiTools", () => {
  const tools = buildWorkflowAiTools()
  const names = tools.map((t) => t.name)

  it("composes every tool family, including the wake tool", () => {
    // One representative per build* family — a dropped spread fails here.
    for (const expected of [
      "wf_read_graph",
      "wf_add_node",
      "wf_list_workflows",
      WORKFLOW_RUNNER_TOOL_NAME,
      "wf_emit_workflow_event",
    ]) {
      expect(names).toContain(expected)
    }
  })

  it("has no duplicate tool names", () => {
    expect(new Set(names).size).toBe(names.length)
  })

  it("registers the typed runner with the SHARED definition (single source, no drift)", () => {
    const runner = tools.find((t) => t.name === WORKFLOW_RUNNER_TOOL_NAME)
    expect(runner?.definition).toBe(WORKFLOW_RUNNER_TOOL_DEFINITION)
    expect(runner?.pluginId).toBe("cognia-workflow-ai")
  })
})
