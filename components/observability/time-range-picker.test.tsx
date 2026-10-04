/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { TimeRangePicker, fromLocalInput, toLocalInput } from "./time-range-picker"

jest.mock("next-intl", () => {
  // Key-echo translator (with `has`, which the enum-label hook asks before
  // translating) plus an Intl-backed formatter — what next-intl's
  // `useFormatter` does, in "en"/UTC (next-intl itself is ESM-only and cannot
  // be `requireActual`-ed here) — so units and currency render as in the app.
  const translator = () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key
  return {
    useTranslations: () => Object.assign(translator(), { has: () => false }),
    useFormatter: () => ({
      number: (value: number, options?: Intl.NumberFormatOptions) =>
        new Intl.NumberFormat("en", options).format(value),
      dateTime: (value: number | Date, options?: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat("en", { timeZone: "UTC", ...options }).format(value),
    }),
  }
})

describe("time-range-picker helpers", () => {
  it("round-trips epoch ms through a datetime-local string", () => {
    const ms = new Date(2024, 0, 2, 3, 4).getTime()
    expect(fromLocalInput(toLocalInput(ms))).toBe(ms)
  })

  it("rejects empty / invalid input", () => {
    expect(fromLocalInput("")).toBeNull()
    expect(fromLocalInput("not-a-date")).toBeNull()
  })
})

describe("TimeRangePicker", () => {
  const baseProps = {
    preset: "1h" as const,
    customSince: null,
    customUntil: null,
    onPreset: jest.fn(),
    onCustom: jest.fn(),
  }

  beforeEach(() => jest.clearAllMocks())

  it("shows the active preset label on the trigger", () => {
    render(<TimeRangePicker {...baseProps} />)
    expect(screen.getByTestId("time-range-trigger")).toHaveTextContent("presets.1h")
  })

  it("fires onPreset when a quick range is chosen", () => {
    render(<TimeRangePicker {...baseProps} />)
    fireEvent.click(screen.getByTestId("time-range-trigger"))
    fireEvent.click(screen.getByTestId("range-preset-24h"))
    expect(baseProps.onPreset).toHaveBeenCalledWith("24h")
  })

  it("applies a custom absolute range", () => {
    render(<TimeRangePicker {...baseProps} />)
    fireEvent.click(screen.getByTestId("time-range-trigger"))
    fireEvent.change(screen.getByLabelText("from"), { target: { value: "2024-01-01T00:00" } })
    fireEvent.change(screen.getByLabelText("to"), { target: { value: "2024-01-01T01:00" } })
    fireEvent.click(screen.getByTestId("range-apply-custom"))
    expect(baseProps.onCustom).toHaveBeenCalledWith(
      new Date("2024-01-01T00:00").getTime(),
      new Date("2024-01-01T01:00").getTime()
    )
  })

  it("renders a custom-range label when bounds are pinned, in full as its title", () => {
    render(<TimeRangePicker {...baseProps} preset="custom" customSince={1000} customUntil={2000} />)
    const trigger = screen.getByTestId("time-range-trigger")
    expect(trigger).toHaveTextContent("customLabel")
    // Dates come from the app-locale formatter, not `toLocaleString()`.
    expect(trigger).toHaveTextContent('"from":"Jan 1, 12:00 AM"')
    // The label truncates; the title carries all of it.
    expect(trigger).toHaveAttribute("title", trigger.textContent)
  })

  it("seeds From/To from the active custom range when opened", () => {
    const since = new Date("2024-03-01T10:00").getTime()
    const until = new Date("2024-03-01T12:30").getTime()
    render(
      <TimeRangePicker {...baseProps} preset="custom" customSince={since} customUntil={until} />
    )
    fireEvent.click(screen.getByTestId("time-range-trigger"))
    expect(screen.getByLabelText("from")).toHaveValue("2024-03-01T10:00")
    expect(screen.getByLabelText("to")).toHaveValue("2024-03-01T12:30")
  })

  it("leaves the fields empty for a relative preset", () => {
    render(<TimeRangePicker {...baseProps} />)
    fireEvent.click(screen.getByTestId("time-range-trigger"))
    expect(screen.getByLabelText("from")).toHaveValue("")
    expect(screen.getByTestId("range-apply-custom")).toBeDisabled()
  })

  it("refuses a reversed or zero-width range and says why", () => {
    render(<TimeRangePicker {...baseProps} />)
    fireEvent.click(screen.getByTestId("time-range-trigger"))
    fireEvent.change(screen.getByLabelText("from"), { target: { value: "2024-01-01T02:00" } })
    fireEvent.change(screen.getByLabelText("to"), { target: { value: "2024-01-01T01:00" } })
    expect(screen.getByTestId("range-apply-custom")).toBeDisabled()
    expect(screen.getByTestId("range-order-error")).toHaveTextContent("orderError")
    expect(screen.getByLabelText("to")).toHaveAttribute("aria-invalid", "true")
    fireEvent.click(screen.getByTestId("range-apply-custom"))
    expect(baseProps.onCustom).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText("to"), { target: { value: "2024-01-01T02:00" } })
    expect(screen.getByTestId("range-apply-custom")).toBeDisabled()
  })
})
