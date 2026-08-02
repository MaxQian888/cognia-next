/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars && Object.keys(vars).length > 0 ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { InputVariable } from "@/lib/skills/recording/input-variables"

import { ReviewVariables } from "./review-variables"

function variable(patch: Partial<InputVariable> = {}): InputVariable {
  return { name: "orderId", kind: "variable", seq: 1, sample: "ORD-42", confirmed: false, ...patch }
}

function renderVariables(variables: InputVariable[]) {
  const onConfirm = jest.fn()
  render(<ReviewVariables variables={variables} onConfirm={onConfirm} />)
  return { onConfirm }
}

describe("ReviewVariables", () => {
  it("renders nothing when the recording had no typed input", () => {
    const { container } = render(<ReviewVariables variables={[]} onConfirm={jest.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("counts what is still unanswered", () => {
    // Deliberate friction: the recorder cannot tell a search term from a menu
    // name, and guessing wrong produces a skill hard-coded to one person's data.
    renderVariables([variable({ seq: 1 }), variable({ seq: 2, confirmed: true })])
    expect(screen.getByText(/^unconfirmed:.*"count":1/)).toBeInTheDocument()
  })

  it("says nothing about unanswered questions once they are all answered", () => {
    renderVariables([variable({ confirmed: true })])
    expect(screen.queryByText(/^unconfirmed:/)).not.toBeInTheDocument()
  })

  it("shows the recorded sample, labelled as staying on this device", () => {
    renderVariables([variable()])
    expect(screen.getByText("ORD-42")).toBeInTheDocument()
    expect(screen.getByText(/sampleLocal/)).toBeInTheDocument()
  })

  it("shows no sample for a secret — there is nothing kept to show", () => {
    renderVariables([variable({ kind: "sensitive", sample: undefined })])
    expect(screen.queryByText(/^sample:/)).not.toBeInTheDocument()
  })

  it("renames a variable through the caller", async () => {
    const { onConfirm } = renderVariables([variable({ seq: 4 })])
    await userEvent.type(screen.getByLabelText("name"), "X")
    expect(onConfirm).toHaveBeenCalledWith(4, { name: "orderIdX" })
  })

  it("confirms a suggestion as-is", async () => {
    const { onConfirm } = renderVariables([variable({ seq: 4 })])
    await userEvent.click(screen.getByRole("button", { name: "confirm" }))
    expect(onConfirm).toHaveBeenCalledWith(4, {})
  })

  it("replaces the confirm action with a badge once answered", () => {
    renderVariables([variable({ confirmed: true })])
    expect(screen.getByText("confirmed")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "confirm" })).not.toBeInTheDocument()
  })

  it("offers all three classifications, and reports the choice", async () => {
    const user = userEvent.setup()
    const { onConfirm } = renderVariables([variable({ seq: 4 })])
    await user.click(screen.getByRole("combobox", { name: "orderId" }))

    expect(screen.getByRole("option", { name: "kindVariable" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "kindLiteral" })).toBeInTheDocument()

    // "Always this value" is the only choice that lets a recorded sample reach
    // the saved skill, so it has to be an explicit pick.
    await user.click(screen.getByRole("option", { name: "kindSensitive" }))
    expect(onConfirm).toHaveBeenCalledWith(4, { kind: "sensitive" })
  })

  it("renders one row per variable, keyed by its step", () => {
    renderVariables([variable({ seq: 1 }), variable({ seq: 2, name: "invoiceMonth" })])
    expect(screen.getAllByLabelText("name")).toHaveLength(2)
  })
})
