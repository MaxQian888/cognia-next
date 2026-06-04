import {
  WORKFLOW_CONDITION_OPERATORS,
  type WorkflowCondition,
  type WorkflowConditionGroup,
} from "./conditions"

describe("workflow condition types", () => {
  it("enumerates every operator exactly once", () => {
    expect(new Set(WORKFLOW_CONDITION_OPERATORS).size).toBe(WORKFLOW_CONDITION_OPERATORS.length)
    expect(WORKFLOW_CONDITION_OPERATORS).toContain("eq")
    expect(WORKFLOW_CONDITION_OPERATORS).toContain("inRange")
    expect(WORKFLOW_CONDITION_OPERATORS).toContain("truthy")
    expect(WORKFLOW_CONDITION_OPERATORS).toHaveLength(15)
  })

  it("accepts a well-formed group", () => {
    const group: WorkflowConditionGroup = {
      combinator: "all",
      conditions: [
        { left: "{{ $node['n1'].status }}", operator: "eq", right: "ok", caseSensitive: false },
        { left: "{{ $node['n1'].count }}", operator: "inRange", right: "1", rightUpper: "10" },
      ],
    }
    const first: WorkflowCondition = group.conditions[0]
    expect(first.operator).toBe("eq")
  })
})
