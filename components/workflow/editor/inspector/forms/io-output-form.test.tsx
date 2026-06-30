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

import { OutputConfig, ManualTriggerConfig } from "./index"

function wrap(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

describe("OutputConfig (io.output)", () => {
  it("edits the output value expression", () => {
    const onChange = jest.fn()
    wrap(<OutputConfig params={{}} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText(/^Output value/), {
      target: { value: "{{ $node['x'] }}" },
    })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ value: "{{ $node['x'] }}" }))
  })

  it("exposes the output schema builder + violation mode", () => {
    wrap(<OutputConfig params={{}} onChange={jest.fn()} />)
    expect(screen.getByText("Add field")).toBeInTheDocument()
    expect(screen.getByLabelText("On schema violation")).toBeInTheDocument()
  })
})

describe("ManualTriggerConfig input schema (D5)", () => {
  it("edits the declared input schema", () => {
    const onChange = jest.fn()
    wrap(<ManualTriggerConfig params={{}} onChange={onChange} />)
    fireEvent.click(screen.getByText("Add field"))
    fireEvent.change(screen.getByLabelText("Field name"), { target: { value: "topic" } })
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        inputSchema: {
          type: "object",
          properties: { topic: { type: "string" } },
          required: ["topic"],
        },
      })
    )
  })
})
