/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { DurationField } from "./duration-field"

const messages = {
  workflows: {
    forms: {
      wait: {
        durationMs: {
          units: { ms: "ms", sec: "seconds", min: "minutes", hour: "hours" },
        },
      },
    },
  },
}

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  )
}

describe("DurationField", () => {
  it("displays minutes for a value that divides evenly into minutes", () => {
    wrap(<DurationField id="d" value={300000} onChange={jest.fn()} />)
    // 300000ms = 5 minutes → initial unit "min", display 5.
    expect(screen.getByRole("spinbutton")).toHaveValue(5)
  })

  it("displays seconds for a value that divides into seconds but not minutes", () => {
    wrap(<DurationField id="d" value={5000} onChange={jest.fn()} />)
    expect(screen.getByRole("spinbutton")).toHaveValue(5)
  })

  it("falls back to ms for an arbitrary value", () => {
    wrap(<DurationField id="d" value={1500} onChange={jest.fn()} />)
    expect(screen.getByRole("spinbutton")).toHaveValue(1500)
  })

  it("converts the typed number to milliseconds using the current unit", () => {
    const onChange = jest.fn()
    // 60000ms → unit "min", display 1.
    wrap(<DurationField id="d" value={60000} onChange={onChange} />)
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "3" } })
    expect(onChange).toHaveBeenCalledWith(180000)
  })

  it("treats zero as ms with a zero display", () => {
    wrap(<DurationField id="d" value={0} onChange={jest.fn()} />)
    expect(screen.getByRole("spinbutton")).toHaveValue(0)
  })
})
