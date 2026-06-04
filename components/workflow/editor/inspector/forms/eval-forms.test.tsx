/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}))
// The Monaco-backed expression editor is exercised in its own suite; a plain
// input keeps this form suite jsdom-fast (mirrors sibling form tests).
jest.mock("./shared/expression-field", () => ({
  ExpressionField: ({
    value,
    onChange,
    id,
    placeholder,
  }: {
    value: string
    onChange: (v: string) => void
    id?: string
    placeholder?: string
  }) => (
    <input
      id={id}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}))

import { EvalRunConfig, EvalGateConfig } from "./eval-forms"

describe("EvalRunConfig", () => {
  it("patches datasetId, model, k and scorerIds", () => {
    const onChange = jest.fn()
    render(<EvalRunConfig params={{}} onChange={onChange} />)
    fireEvent.change(document.getElementById("eval-ds")!, { target: { value: "d1" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ datasetId: "d1" }))
    fireEvent.change(document.getElementById("eval-k")!, { target: { value: "3" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ k: 3 }))
    fireEvent.change(document.getElementById("eval-scorers")!, {
      target: { value: "assertion, cost" },
    })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ scorerIds: ["assertion", "cost"] })
    )
  })

  it("patches label, characterId, split and capabilities", () => {
    const onChange = jest.fn()
    render(<EvalRunConfig params={{}} onChange={onChange} />)
    fireEvent.change(document.getElementById("eval-label")!, { target: { value: "L" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ label: "L" }))
    fireEvent.change(document.getElementById("eval-char")!, { target: { value: "ch1" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ characterId: "ch1" }))
    fireEvent.change(document.getElementById("eval-split")!, { target: { value: "test" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ split: "test" }))
    fireEvent.change(document.getElementById("eval-caps")!, { target: { value: "a, b" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ capabilities: ["a", "b"] }))
  })

  it("patches team and workflow refs", () => {
    const onChange = jest.fn()
    const { rerender } = render(
      <EvalRunConfig params={{ targetKind: "team" }} onChange={onChange} />
    )
    fireEvent.change(screen.getByPlaceholderText("workflows.forms.eval.run.teamId.placeholder"), {
      target: { value: "tm1" },
    })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ teamId: "tm1" }))
    rerender(<EvalRunConfig params={{ targetKind: "workflow" }} onChange={onChange} />)
    fireEvent.change(
      screen.getByPlaceholderText("workflows.forms.eval.run.workflowId.placeholder"),
      { target: { value: "wf1" } }
    )
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ workflowId: "wf1" }))
  })

  it("shows the chat model field by default and team/workflow refs by kind", () => {
    const { rerender } = render(<EvalRunConfig params={{}} onChange={jest.fn()} />)
    expect(screen.getByText("workflows.forms.eval.run.model.label")).toBeInTheDocument()
    rerender(<EvalRunConfig params={{ targetKind: "team" }} onChange={jest.fn()} />)
    expect(screen.getByText("workflows.forms.eval.run.teamId.label")).toBeInTheDocument()
    rerender(<EvalRunConfig params={{ targetKind: "workflow" }} onChange={jest.fn()} />)
    expect(screen.getByText("workflows.forms.eval.run.workflowId.label")).toBeInTheDocument()
  })
})

describe("EvalRunConfig prefilled", () => {
  it("renders list params as comma-joined strings", () => {
    render(
      <EvalRunConfig
        params={{ scorerIds: ["assertion", "cost"], capabilities: ["a"] }}
        onChange={jest.fn()}
      />
    )
    expect(document.getElementById("eval-scorers")).toHaveValue("assertion, cost")
    expect(document.getElementById("eval-caps")).toHaveValue("a")
  })
})

describe("EvalGateConfig", () => {
  it("patches runId and numeric thresholds; empty clears to undefined", () => {
    const onChange = jest.fn()
    render(<EvalGateConfig params={{ minPassAt1: 0.5 }} onChange={onChange} />)
    fireEvent.change(document.getElementById("eval-runid")!, { target: { value: "r1" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ runId: "r1" }))
    fireEvent.change(document.getElementById("eval-minPassAt1")!, { target: { value: "" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ minPassAt1: undefined }))
    fireEvent.change(document.getElementById("eval-maxTotalCostUsd")!, { target: { value: "2" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ maxTotalCostUsd: 2 }))
  })
})
