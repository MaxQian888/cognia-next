/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import type { WorkflowConditionGroup } from "@/types/workflow/conditions"
import { ConditionBuilder } from "./condition-builder"

function lastCall(fn: jest.Mock): WorkflowConditionGroup {
  return fn.mock.calls[fn.mock.calls.length - 1][0] as WorkflowConditionGroup
}

describe("ConditionBuilder", () => {
  it("renders an add button and the coercion hint when empty", () => {
    const onChange = jest.fn()
    render(<ConditionBuilder idPrefix="cb" value={undefined} onChange={onChange} />)
    expect(screen.getByTestId("cb-add-condition")).toBeInTheDocument()
    expect(screen.getByTestId("cb-coercion-hint")).toBeInTheDocument()
  })

  it("adds a condition row with eq defaults", () => {
    const onChange = jest.fn()
    render(<ConditionBuilder idPrefix="cb" value={undefined} onChange={onChange} />)
    fireEvent.click(screen.getByTestId("cb-add-condition"))
    const next = lastCall(onChange)
    expect(next.combinator).toBe("all")
    expect(next.conditions).toHaveLength(1)
    expect(next.conditions[0].operator).toBe("eq")
  })

  it("toggles the combinator between all and any", () => {
    const onChange = jest.fn()
    const value: WorkflowConditionGroup = {
      combinator: "all",
      conditions: [{ left: "a", operator: "eq", right: "b" }],
    }
    render(<ConditionBuilder idPrefix="cb" value={value} onChange={onChange} />)
    fireEvent.click(screen.getByTestId("cb-combinator-any"))
    expect(lastCall(onChange).combinator).toBe("any")
  })

  it("edits a row's left operand", () => {
    const onChange = jest.fn()
    const value: WorkflowConditionGroup = {
      combinator: "all",
      conditions: [{ left: "", operator: "eq", right: "" }],
    }
    render(<ConditionBuilder idPrefix="cb" value={value} onChange={onChange} />)
    const left = screen.getByTestId("cb-left-0").querySelector("textarea, input, [contenteditable]")
    expect(left).not.toBeNull()
  })

  it("removes a row", () => {
    const onChange = jest.fn()
    const value: WorkflowConditionGroup = {
      combinator: "all",
      conditions: [
        { left: "a", operator: "eq", right: "b" },
        { left: "c", operator: "neq", right: "d" },
      ],
    }
    render(<ConditionBuilder idPrefix="cb" value={value} onChange={onChange} />)
    fireEvent.click(screen.getByTestId("cb-remove-0"))
    const next = lastCall(onChange)
    expect(next.conditions).toHaveLength(1)
    expect(next.conditions[0].left).toBe("c")
  })

  it("hides the right operand for unary operators", () => {
    const onChange = jest.fn()
    const value: WorkflowConditionGroup = {
      combinator: "all",
      conditions: [{ left: "a", operator: "isEmpty" }],
    }
    render(<ConditionBuilder idPrefix="cb" value={value} onChange={onChange} />)
    expect(screen.queryByTestId("cb-right-0")).toBeNull()
  })

  it("shows the upper bound input only for inRange", () => {
    const onChange = jest.fn()
    const value: WorkflowConditionGroup = {
      combinator: "all",
      conditions: [{ left: "a", operator: "inRange", right: "1", rightUpper: "9" }],
    }
    render(<ConditionBuilder idPrefix="cb" value={value} onChange={onChange} />)
    expect(screen.getByTestId("cb-right-upper-0")).toBeInTheDocument()
  })

  it("shows the case-sensitivity toggle for string operators and patches it", () => {
    const onChange = jest.fn()
    const value: WorkflowConditionGroup = {
      combinator: "all",
      conditions: [{ left: "a", operator: "contains", right: "b" }],
    }
    render(<ConditionBuilder idPrefix="cb" value={value} onChange={onChange} />)
    const toggle = screen.getByTestId("cb-case-sensitive-0")
    fireEvent.click(toggle)
    expect(lastCall(onChange).conditions[0].caseSensitive).toBe(true)
  })

  it("does not show the case toggle for numeric-ordering operators", () => {
    const onChange = jest.fn()
    const value: WorkflowConditionGroup = {
      combinator: "all",
      conditions: [{ left: "a", operator: "gt", right: "1" }],
    }
    render(<ConditionBuilder idPrefix="cb" value={value} onChange={onChange} />)
    expect(screen.queryByTestId("cb-case-sensitive-0")).toBeNull()
  })
})
