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

import { AggregateConfig, JoinConfig, WaitConfig } from "./index"

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

/**
 * `initialValue` is the seed `data.aggregate` hands its custom reducer as the
 * first accumulator. It had no field, so a custom reducer always started from
 * `undefined` — `(acc, item) => acc + item.n` produced NaN and there was no
 * way to fix it from the editor.
 */
describe("AggregateConfig — custom reducer seed", () => {
  it("offers the seed only for the custom operation", () => {
    const { container, rerender } = wrap(
      <AggregateConfig params={{ operation: "collect" }} onChange={jest.fn()} />
    )
    expect(container.querySelector('[data-field="initialValue"]')).toBeNull()

    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AggregateConfig params={{ operation: "custom" }} onChange={jest.fn()} />
      </NextIntlClientProvider>
    )
    expect(container.querySelector('[data-field="initialValue"]')).not.toBeNull()
  })

  it("parses the seed as JSON and drops it when emptied", () => {
    const onChange = jest.fn()
    const { container } = wrap(
      <AggregateConfig params={{ operation: "custom" }} onChange={onChange} />
    )
    const box = container.querySelector('[data-field="initialValue"] textarea')!
    fireEvent.change(box, { target: { value: "[]" } })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ initialValue: [] }))

    fireEvent.change(box, { target: { value: "" } })
    // Absent means "no seed" and must stay distinct from a literal null.
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ initialValue: undefined }))
  })

  it("keeps half-typed JSON in the box without pushing it into params", () => {
    const onChange = jest.fn()
    const { container } = wrap(
      <AggregateConfig params={{ operation: "custom" }} onChange={onChange} />
    )
    const box = container.querySelector(
      '[data-field="initialValue"] textarea'
    ) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: '{"a":' } })
    expect(box.value).toBe('{"a":')
    expect(onChange).not.toHaveBeenCalled()
  })
})

/**
 * `flow.wait` in event mode routes a wake by `correlationId` when several runs
 * listen on the same event name; without a field, two runs waiting on one
 * event could not be told apart.
 */
describe("WaitConfig — event correlation", () => {
  it("shows the correlation key only in event mode", () => {
    const { container, rerender } = wrap(
      <WaitConfig params={{ mode: "duration" }} onChange={jest.fn()} />
    )
    expect(container.querySelector('[data-field="correlationId"]')).toBeNull()

    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <WaitConfig params={{ mode: "event" }} onChange={jest.fn()} />
      </NextIntlClientProvider>
    )
    const field = container.querySelector('[data-field="correlationId"]')
    expect(field).not.toBeNull()
  })

  it("writes the correlation key", () => {
    const onChange = jest.fn()
    const { container } = wrap(<WaitConfig params={{ mode: "event" }} onChange={onChange} />)
    const input = container.querySelector('[data-field="correlationId"] textarea')!
    fireEvent.change(input, { target: { value: "order-42" } })
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ correlationId: "order-42" })
    )
  })
})
