/**
 * @jest-environment jsdom
 *
 * Branch/Switch typeVersion-2 inspector forms — structured-condition
 * authoring. The legacy v1 paths are covered by the pre-existing suites;
 * this file guards the v2 dispatch and the case-list editor.
 */
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { BranchConfig, BreakConfig, ContinueConfig, LoopConfig, SwitchConfig } from "./index"

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

describe("LoopConfig", () => {
  it("renders the legacy form for typeVersion 1", () => {
    const onChange = jest.fn()
    render(
      <LoopConfig
        params={{ mode: "forEach", inputExpression: "x", bodyExpression: "y" }}
        onChange={onChange}
        typeVersion={1}
      />
    )
    expect(screen.queryByTestId("loop-v2-mode")).toBeNull()
  })

  it("renders the v2 container form with the per-mode field", () => {
    const onChange = jest.fn()
    render(
      <LoopConfig
        params={{ mode: "forEach", source: "{{ $node['n1'].items }}" }}
        onChange={onChange}
        typeVersion={2}
      />
    )
    expect(screen.getByTestId("loop-v2-mode")).toBeInTheDocument()
    expect(screen.getByTestId("loop-v2-concurrency")).toBeInTheDocument()
  })

  it("hides concurrency for while mode (sequential by definition)", () => {
    const onChange = jest.fn()
    render(
      <LoopConfig
        params={{ mode: "while", whileExpression: "{{ $static.go }}" }}
        onChange={onChange}
        typeVersion={2}
      />
    )
    expect(screen.queryByTestId("loop-v2-concurrency")).toBeNull()
  })

  it("patches iterationConcurrency as a number", () => {
    const onChange = jest.fn()
    render(<LoopConfig params={{ mode: "times", times: 3 }} onChange={onChange} typeVersion={2} />)
    fireEvent.change(screen.getByTestId("loop-v2-concurrency"), { target: { value: "4" } })
    expect(lastParams(onChange).iterationConcurrency).toBe(4)
  })

  it("shows conditionTiming only for while mode", () => {
    const onChange = jest.fn()
    const { rerender } = render(
      <LoopConfig
        params={{ mode: "while", whileExpression: "x" }}
        onChange={onChange}
        typeVersion={2}
      />
    )
    expect(screen.getByTestId("loop-v2-condition-timing")).toBeInTheDocument()
    rerender(
      <LoopConfig params={{ mode: "forEach", source: "y" }} onChange={onChange} typeVersion={2} />
    )
    expect(screen.queryByTestId("loop-v2-condition-timing")).toBeNull()
    rerender(
      <LoopConfig params={{ mode: "times", times: 2 }} onChange={onChange} typeVersion={2} />
    )
    expect(screen.queryByTestId("loop-v2-condition-timing")).toBeNull()
  })

  it("shows batchSize only for forEach mode and patches it as a number", () => {
    const onChange = jest.fn()
    const { rerender } = render(
      <LoopConfig params={{ mode: "forEach", source: "y" }} onChange={onChange} typeVersion={2} />
    )
    fireEvent.change(screen.getByTestId("loop-v2-batch-size"), { target: { value: "5" } })
    expect(lastParams(onChange).batchSize).toBe(5)
    rerender(
      <LoopConfig
        params={{ mode: "forEach", source: "y", batchSize: 5 }}
        onChange={onChange}
        typeVersion={2}
      />
    )
    fireEvent.change(screen.getByTestId("loop-v2-batch-size"), { target: { value: "" } })
    expect(lastParams(onChange).batchSize).toBeUndefined()
    rerender(
      <LoopConfig
        params={{ mode: "while", whileExpression: "x" }}
        onChange={onChange}
        typeVersion={2}
      />
    )
    expect(screen.queryByTestId("loop-v2-batch-size")).toBeNull()
  })

  it("patches conditionTiming via the select and stores the default as undefined", async () => {
    const onChange = jest.fn()
    const { rerender } = render(
      <LoopConfig
        params={{ mode: "while", whileExpression: "x" }}
        onChange={onChange}
        typeVersion={2}
      />
    )
    await userEvent.click(screen.getByTestId("loop-v2-condition-timing"))
    await userEvent.click(screen.getByRole("option", { name: "Check after (do-while)" }))
    expect(lastParams(onChange).conditionTiming).toBe("post")
    rerender(
      <LoopConfig
        params={{ mode: "while", whileExpression: "x", conditionTiming: "post" }}
        onChange={onChange}
        typeVersion={2}
      />
    )
    await userEvent.click(screen.getByTestId("loop-v2-condition-timing"))
    await userEvent.click(screen.getByRole("option", { name: "Check before (while)" }))
    expect(lastParams(onChange).conditionTiming).toBeUndefined()
  })

  it("switching mode away clears mode-scoped knobs (conditionTiming/batchSize)", async () => {
    const onChange = jest.fn()
    render(
      <LoopConfig
        params={{ mode: "while", whileExpression: "x", conditionTiming: "post" }}
        onChange={onChange}
        typeVersion={2}
      />
    )
    await userEvent.click(screen.getByTestId("loop-v2-mode"))
    await userEvent.click(screen.getByRole("option", { name: "For each item" }))
    const next = lastParams(onChange)
    expect(next.mode).toBe("forEach")
    expect(next.conditionTiming).toBeUndefined()

    const onChange2 = jest.fn()
    render(
      <LoopConfig
        params={{ mode: "forEach", source: "y", batchSize: 4 }}
        onChange={onChange2}
        typeVersion={2}
      />
    )
    const triggers = screen.getAllByTestId("loop-v2-mode")
    await userEvent.click(triggers[triggers.length - 1])
    await userEvent.click(screen.getByRole("option", { name: "Fixed count" }))
    const next2 = lastParams(onChange2)
    expect(next2.mode).toBe("times")
    expect(next2.batchSize).toBeUndefined()
  })

  it("authors the new error policies and normalizes legacy skip to remove-failed", async () => {
    const onChange = jest.fn()
    const { rerender } = render(
      <LoopConfig params={{ mode: "times", times: 2 }} onChange={onChange} typeVersion={2} />
    )
    await userEvent.click(screen.getByTestId("loop-v2-on-item-error"))
    await userEvent.click(screen.getByRole("option", { name: "Continue with null" }))
    expect(lastParams(onChange).onItemError).toBe("continue-with-null")
    rerender(
      <LoopConfig
        params={{ mode: "times", times: 2, onItemError: "skip" }}
        onChange={onChange}
        typeVersion={2}
      />
    )
    expect(screen.getByTestId("loop-v2-on-item-error")).toHaveTextContent("Remove failed item")
    await userEvent.click(screen.getByTestId("loop-v2-on-item-error"))
    await userEvent.click(screen.getByRole("option", { name: "Fail the loop" }))
    expect(lastParams(onChange).onItemError).toBeUndefined()
  })

  it("shows onItemError for every mode", () => {
    const onChange = jest.fn()
    const { rerender } = render(
      <LoopConfig params={{ mode: "forEach", source: "y" }} onChange={onChange} typeVersion={2} />
    )
    expect(screen.getByTestId("loop-v2-on-item-error")).toBeInTheDocument()
    rerender(
      <LoopConfig
        params={{ mode: "while", whileExpression: "x" }}
        onChange={onChange}
        typeVersion={2}
      />
    )
    expect(screen.getByTestId("loop-v2-on-item-error")).toBeInTheDocument()
    rerender(
      <LoopConfig params={{ mode: "times", times: 2 }} onChange={onChange} typeVersion={2} />
    )
    expect(screen.getByTestId("loop-v2-on-item-error")).toBeInTheDocument()
  })
})

describe("BreakConfig / ContinueConfig", () => {
  it("render their info copy without params", () => {
    render(<BreakConfig />)
    render(<ContinueConfig />)
    // Both are static info paragraphs; presence is enough.
    expect(document.querySelectorAll("p").length).toBeGreaterThanOrEqual(2)
  })
})
