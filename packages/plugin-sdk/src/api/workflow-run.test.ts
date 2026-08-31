import * as sdk from "./workflow-run"
import {
  WORKFLOW_RUNNER_TOOL_DEFINITION,
  WORKFLOW_RUNNER_TOOL_NAME,
} from "@/lib/workflow/publish/runner-tool"

describe("plugin-sdk: api/workflow-run", () => {
  it("shares the host's dependency-free runner definition", () => {
    expect(sdk.WORKFLOW_RUNNER_TOOL_NAME).toBe(WORKFLOW_RUNNER_TOOL_NAME)
    expect(sdk.WORKFLOW_RUNNER_TOOL_DEFINITION).toBe(WORKFLOW_RUNNER_TOOL_DEFINITION)
    expect(sdk.WORKFLOW_RUNNER_TOOL_DEFINITION.requiresApproval).toBe(true)
  })

  it("does not expose host execution or persistence functions", () => {
    expect(sdk).not.toHaveProperty("runWorkflow")
    expect(sdk).not.toHaveProperty("executeRunWorkflowTyped")
    expect(sdk).not.toHaveProperty("listWorkflowSummaries")
    expect(sdk).not.toHaveProperty("recordCallbackBinding")
    expect(sdk).not.toHaveProperty("emitWorkflowWaitEvent")
  })
})
