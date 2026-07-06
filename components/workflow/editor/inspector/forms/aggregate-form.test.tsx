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

import { AggregateConfig, JoinConfig } from "./index"

function wrap(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

describe("AggregateConfig", () => {
  it("shows the key expression only for group-by / dedupe", () => {
    const { rerender } = wrap(
      <AggregateConfig params={{ operation: "collect" }} onChange={jest.fn()} />
    )
    expect(screen.queryByLabelText("Key expression")).toBeNull()

    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AggregateConfig params={{ operation: "group-by" }} onChange={jest.fn()} />
      </NextIntlClientProvider>
    )
    expect(screen.getByLabelText("Key expression")).toBeInTheDocument()
  })

  it("shows numeric function + value only for the numeric op", () => {
    wrap(<AggregateConfig params={{ operation: "numeric" }} onChange={jest.fn()} />)
    expect(screen.getByLabelText("Function")).toBeInTheDocument()
    expect(screen.getByLabelText("Value expression")).toBeInTheDocument()
  })

  it("edits the custom reducer expression", () => {
    const onChange = jest.fn()
    wrap(<AggregateConfig params={{ operation: "custom" }} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText("Reducer expression (JS)"), {
      target: { value: "acc + item.n" },
    })
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ reducerExpression: "acc + item.n" })
    )
  })
})

describe("JoinConfig aggregate toggle", () => {
  it("enables aggregation and seeds a collect operation", () => {
    const onChange = jest.fn()
    wrap(<JoinConfig params={{}} onChange={onChange} />)
    fireEvent.click(screen.getByLabelText("Aggregate gathered results"))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ aggregate: { operation: "collect" } })
    )
  })

  it("renders the nested aggregate form once enabled", () => {
    wrap(<JoinConfig params={{ aggregate: { operation: "collect" } }} onChange={jest.fn()} />)
    expect(screen.getByLabelText("Operation")).toBeInTheDocument()
  })
})
