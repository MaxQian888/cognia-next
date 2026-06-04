/**
 * @jest-environment jsdom
 *
 * Branch/Switch typeVersion-2 inspector forms — structured-condition
 * authoring. The legacy v1 paths are covered by the pre-existing suites;
 * this file guards the v2 dispatch and the case-list editor.
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { BranchConfig, SwitchConfig } from "./index"

function lastParams(onChange: jest.Mock): Record<string, unknown> {
  return onChange.mock.calls[onChange.mock.calls.length - 1][0] as Record<string, unknown>
}

describe("BranchConfig", () => {
  it("renders the legacy expression form for typeVersion 1", () => {
    const onChange = jest.fn()
    render(<BranchConfig params={{ condition: "x" }} onChange={onChange} typeVersion={1} />)
    expect(screen.queryByTestId("branch-conditions-condition-builder")).toBeNull()
  })

  it("renders the condition builder for typeVersion 2", () => {
    const onChange = jest.fn()
    render(<BranchConfig params={{}} onChange={onChange} typeVersion={2} />)
    expect(screen.getByTestId("branch-conditions-condition-builder")).toBeInTheDocument()
  })

  it("patches params.conditions when the builder changes", () => {
    const onChange = jest.fn()
    render(<BranchConfig params={{}} onChange={onChange} typeVersion={2} />)
    fireEvent.click(screen.getByTestId("branch-conditions-add-condition"))
    const next = lastParams(onChange)
    const group = next.conditions as { conditions: unknown[] }
    expect(group.conditions).toHaveLength(1)
  })
})

describe("SwitchConfig", () => {
  it("renders the legacy subject/cases form for typeVersion 1", () => {
    const onChange = jest.fn()
    render(
      <SwitchConfig params={{ subject: "x", cases: [] }} onChange={onChange} typeVersion={1} />
    )
    expect(screen.queryByTestId("switch-v2-add-case")).toBeNull()
  })

  it("adds a case with a generated id for typeVersion 2", () => {
    const onChange = jest.fn()
    render(<SwitchConfig params={{}} onChange={onChange} typeVersion={2} />)
    fireEvent.click(screen.getByTestId("switch-v2-add-case"))
    const next = lastParams(onChange)
    const cases = next.cases as Array<{ id: string; when: { conditions: unknown[] } }>
    expect(cases).toHaveLength(1)
    expect(cases[0].id).toMatch(/^c_/)
    expect(cases[0].when.conditions).toEqual([])
  })

  it("edits a case label and removes a case", () => {
    const onChange = jest.fn()
    const params = {
      cases: [
        { id: "c_a", label: "Alpha", when: { combinator: "all", conditions: [] } },
        { id: "c_b", label: "Beta", when: { combinator: "all", conditions: [] } },
      ],
    }
    render(<SwitchConfig params={params} onChange={onChange} typeVersion={2} />)
    const labelInput = screen.getByTestId("switch-v2-case-label-0") as HTMLInputElement
    fireEvent.change(labelInput, { target: { value: "Gamma" } })
    let next = lastParams(onChange)
    expect((next.cases as Array<{ label: string }>)[0].label).toBe("Gamma")

    fireEvent.click(screen.getByTestId("switch-v2-remove-case-1"))
    next = lastParams(onChange)
    expect(next.cases as unknown[]).toHaveLength(1)
  })

  it("nests a condition builder per case", () => {
    const onChange = jest.fn()
    const params = {
      cases: [{ id: "c_a", label: "Alpha", when: { combinator: "all", conditions: [] } }],
    }
    render(<SwitchConfig params={params} onChange={onChange} typeVersion={2} />)
    fireEvent.click(screen.getByTestId("switch-case-0-add-condition"))
    const next = lastParams(onChange)
    const cases = next.cases as Array<{ when: { conditions: unknown[] } }>
    expect(cases[0].when.conditions).toHaveLength(1)
  })
})
