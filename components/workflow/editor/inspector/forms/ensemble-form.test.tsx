/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

jest.mock("./shared/expression-field", () => ({
  ExpressionField: ({
    value,
    onChange,
    id,
  }: {
    value: string
    onChange: (v: string) => void
    id?: string
  }) => <textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} />,
}))

jest.mock("./shared/entity-picker", () => ({
  ...Object.fromEntries(
    [
      "CharacterPicker",
      "SubworkflowPicker",
      "SkillPicker",
      "TeamPicker",
      "McpServerPicker",
      "PluginPicker",
      "TwinPicker",
      "EntityPicker",
    ].map((name) => [
      name,
      ({
        value,
        onChange,
        id,
      }: {
        value?: string
        onChange?: (v: string) => void
        id?: string
      }) => <input id={id} value={value ?? ""} onChange={(e) => onChange?.(e.target.value)} />,
    ])
  ),
}))

import { EnsembleConfig } from "./index"

function wrap(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

describe("EnsembleConfig", () => {
  it("shows the prompt + schema for an agent.turn target and hides the sub-workflow picker", () => {
    wrap(<EnsembleConfig params={{ target: { kind: "agent.turn" } }} onChange={jest.fn()} />)
    expect(screen.getByLabelText(/^Prompt/)).toBeInTheDocument()
    expect(screen.queryByLabelText(/^Sub-workflow/)).toBeNull()
  })

  it("swaps to the sub-workflow picker for a subworkflow target", () => {
    wrap(<EnsembleConfig params={{ target: { kind: "subworkflow" } }} onChange={jest.fn()} />)
    expect(screen.getByLabelText(/^Sub-workflow/)).toBeInTheDocument()
    expect(screen.queryByLabelText(/^Prompt/)).toBeNull()
  })

  it("edits N and seeds the field input for majority vote", () => {
    const onChange = jest.fn()
    wrap(
      <EnsembleConfig
        params={{ aggregation: { kind: "majority-vote-on-field" } }}
        onChange={onChange}
      />
    )
    fireEvent.change(screen.getByLabelText(/^Samples/), { target: { value: "5" } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ n: 5 }))
    expect(screen.getByLabelText("Field")).toBeInTheDocument()
  })

  it("shows the score field only for best-of", () => {
    wrap(
      <EnsembleConfig params={{ aggregation: { kind: "best-of-by-score" } }} onChange={jest.fn()} />
    )
    expect(screen.getByLabelText(/^Score field/)).toBeInTheDocument()
    expect(screen.queryByLabelText("Field")).toBeNull()
  })

  it("shows the synthesizer alias for the synthesize policy", () => {
    wrap(
      <EnsembleConfig
        params={{ aggregation: { kind: "synthesize-by-final-agent" } }}
        onChange={jest.fn()}
      />
    )
    expect(screen.getByLabelText(/^Synthesizer alias/)).toBeInTheDocument()
  })

  it("parses the lens textarea into an array", () => {
    const onChange = jest.fn()
    wrap(<EnsembleConfig params={{}} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText(/^Lenses/), {
      target: { value: "for\nagainst\n" },
    })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ lens: ["for", "against"] }))
  })
})
