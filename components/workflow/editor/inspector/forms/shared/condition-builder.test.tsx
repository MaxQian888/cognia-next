/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import type { WorkflowConditionGroup } from "@/types/workflow/conditions"

// Radix Select → native <select> so `onValueChange` is driveable in jsdom
// (same pattern as edge-inspector.test.tsx — the portal/pointer flow is flaky).
jest.mock("@/components/ui/select", () => {
  const Select = ({
    value,
    onValueChange,
    children,
  }: {
    value: string
    onValueChange: (v: string) => void
    children: React.ReactNode
  }) => (
    <select value={value} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  )
  const SelectItem = ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  )
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>
  return {
    Select,
    SelectItem,
    SelectTrigger: Passthrough,
    SelectContent: Passthrough,
    SelectValue: Passthrough,
  }
})

// CodeMirror-hosted expression editor → plain input for deterministic typing.
jest.mock("./expression-field", () => ({
  ExpressionField: ({
    id,
    value,
    onChange,
    "aria-label": ariaLabel,
  }: {
    id?: string
    value: string
    onChange: (v: string) => void
    "aria-label"?: string
  }) => (
    <input
      data-testid={`ef-${id}`}
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}))

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

  it("edits left, right, and rightUpper operands", () => {
    const onChange = jest.fn()
    const value: WorkflowConditionGroup = {
      combinator: "all",
      conditions: [{ left: "", operator: "inRange", right: "", rightUpper: "" }],
    }
    render(<ConditionBuilder idPrefix="cb" value={value} onChange={onChange} />)
    fireEvent.change(screen.getByTestId("ef-cb-left-0"), { target: { value: "{{ $x }}" } })
    expect(lastCall(onChange).conditions[0].left).toBe("{{ $x }}")
    fireEvent.change(screen.getByTestId("ef-cb-right-0"), { target: { value: "1" } })
    expect(lastCall(onChange).conditions[0].right).toBe("1")
    fireEvent.change(screen.getByTestId("cb-right-upper-0"), { target: { value: "9" } })
    expect(lastCall(onChange).conditions[0].rightUpper).toBe("9")
  })

  it("switching to a unary operator strips the right operand", () => {
    const onChange = jest.fn()
    const value: WorkflowConditionGroup = {
      combinator: "all",
      conditions: [{ left: "a", operator: "eq", right: "b", caseSensitive: true }],
    }
    const { container } = render(
      <ConditionBuilder idPrefix="cb" value={value} onChange={onChange} />
    )
    const select = container.querySelector("select")!
    fireEvent.change(select, { target: { value: "isEmpty" } })
    const next = lastCall(onChange).conditions[0]
    expect(next.operator).toBe("isEmpty")
    expect(next.right).toBeUndefined()
    expect(next.caseSensitive).toBeUndefined()
  })

  it("switching to a non-range operator strips the upper bound", () => {
    const onChange = jest.fn()
    const value: WorkflowConditionGroup = {
      combinator: "all",
      conditions: [{ left: "a", operator: "inRange", right: "1", rightUpper: "9" }],
    }
    const { container } = render(
      <ConditionBuilder idPrefix="cb" value={value} onChange={onChange} />
    )
    const select = container.querySelector("select")!
    fireEvent.change(select, { target: { value: "gt" } })
    const next = lastCall(onChange).conditions[0]
    expect(next.operator).toBe("gt")
    expect(next.rightUpper).toBeUndefined()
  })

  it("unchecking case sensitivity clears the flag back to undefined", () => {
    const onChange = jest.fn()
    const value: WorkflowConditionGroup = {
      combinator: "all",
      conditions: [{ left: "a", operator: "contains", right: "b", caseSensitive: true }],
    }
    render(<ConditionBuilder idPrefix="cb" value={value} onChange={onChange} />)
    fireEvent.click(screen.getByTestId("cb-case-sensitive-0"))
    expect(lastCall(onChange).conditions[0].caseSensitive).toBeUndefined()
  })
})
