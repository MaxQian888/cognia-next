import { WORKFLOW_CONDITION_OPERATORS, WORKFLOW_NODE_KINDS } from "./index"

describe("types/workflow barrel", () => {
  it("re-exports condition operators alongside node kinds", () => {
    expect(WORKFLOW_CONDITION_OPERATORS).toContain("regex")
    expect(WORKFLOW_NODE_KINDS).toContain("flow.break")
  })
})
