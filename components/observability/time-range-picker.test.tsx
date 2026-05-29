/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { TimeRangePicker, fromLocalInput, toLocalInput } from "./time-range-picker"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

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

  it("renders a custom-range label when bounds are pinned", () => {
    render(<TimeRangePicker {...baseProps} preset="custom" customSince={1000} customUntil={2000} />)
    expect(screen.getByTestId("time-range-trigger")).toHaveTextContent("→")
  })
})
