/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { CronBuilder } from "./cron-builder"

const messages = {
  workflows: {
    forms: {
      cron: {
        builder: {
          presetLabel: "Preset",
          presets: {
            everyMinute: "Every minute",
            hourly: "Hourly",
            daily: "Daily at 9:00",
            weekdays: "Weekdays at 9:00",
            weekly: "Weekly (Mon 9:00)",
            monthly: "Monthly (1st, 9:00)",
            custom: "Custom",
          },
          nextRunsLabel: "Next runs",
          invalidExpression: "Invalid cron expression",
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

describe("CronBuilder", () => {
  it("renders the raw expression and a next-runs preview for a valid expression", () => {
    wrap(<CronBuilder id="cb" value="0 9 * * 1-5" onChange={jest.fn()} />)
    expect(screen.getByDisplayValue("0 9 * * 1-5")).toBeInTheDocument()
    expect(screen.getByTestId("cb-next-runs")).toBeInTheDocument()
    expect(screen.queryByTestId("cb-invalid")).not.toBeInTheDocument()
  })

  it("shows an error message for an invalid expression", () => {
    wrap(<CronBuilder id="cb" value="not a cron" onChange={jest.fn()} />)
    expect(screen.getByTestId("cb-invalid")).toHaveTextContent("Invalid cron expression")
    expect(screen.queryByTestId("cb-next-runs")).not.toBeInTheDocument()
  })

  it("renders the preset selector trigger", () => {
    wrap(<CronBuilder id="cb" value="0 9 * * 1-5" onChange={jest.fn()} />)
    // Radix Select renders a combobox-role trigger; we don't drive its portal
    // here (consistent with the scheduler dialog tests that avoid Radix internals).
    expect(screen.getByRole("combobox")).toBeInTheDocument()
  })

  it("propagates raw expression edits", () => {
    const onChange = jest.fn()
    wrap(<CronBuilder id="cb" value="0 9 * * *" onChange={onChange} />)
    fireEvent.change(screen.getByDisplayValue("0 9 * * *"), { target: { value: "0 * * * *" } })
    expect(onChange).toHaveBeenCalledWith("0 * * * *")
  })
})
